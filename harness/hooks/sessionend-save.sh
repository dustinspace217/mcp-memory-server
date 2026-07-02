#!/bin/bash
# Detached SessionEnd memory save.
#
# Launched via `setsid nohup ... &` by session-end-agent.sh so it runs in its
# OWN session and OUTLIVES session teardown. Background: SessionEnd hooks
# "cannot block termination" (Claude Code docs) — the harness SIGTERMs the hook
# during teardown EARLIER than its settings.json budget, so an in-line 20-90s
# claude -p save lost the race and the session's tail (every turn since the last
# mid-session checkpoint — unique, unrecoverable data) was lost. setsid was
# empirically verified (2026-06-10) to survive a process-group SIGTERM, so this
# detached worker completes the save regardless of teardown.
#
# Logs its OWN outcome to hook-execution.log under the SessionEndSave source —
# the parent hook returns before the save finishes, so it can no longer report
# the result. A FAIL here is therefore a REAL save failure (worth the
# health-check alarm), not a teardown artifact.
#
# Args: SESSION_ID  TRANSCRIPT_PATH  CWD
set -uo pipefail

SESSION_ID="${1:-unset}"
TRANSCRIPT_PATH="${2:-}"
CWD="${3:-$HOME/Claude}"
LOGFILE="$HOME/.claude/hooks/hook-execution.log"
mkdir -p /tmp/claude

log() {
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | SessionEndSave | $1 (session=${SESSION_ID})" >> "$LOGFILE"
}

# Serialize concurrent detached saves so back-to-back session-ends don't stack
# claude -p processes. BLOCKING (not -n): never SKIP a save — each session's
# tail is unique data and skipping loses exactly what this save exists to
# capture. Detached, so waiting for the lock costs nothing.
exec 9>"/tmp/claude/sessionend-save.lock"
flock 9

PROMPT_TEMPLATE="$HOME/.claude/hooks/sessionend-prompt.md"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
    log "FAIL: prompt template not found at $PROMPT_TEMPLATE"
    exit 0
fi
if [ ! -f "$TRANSCRIPT_PATH" ]; then
    log "FAIL: transcript vanished before save ($TRANSCRIPT_PATH)"
    exit 0
fi

# Last 300 lines: recent context is the most valuable and the full transcript
# can exceed claude -p's window. tail seeks to EOF, so this is fast even on a
# 40MB transcript.
EXCERPT="/tmp/claude/transcript-excerpt-${SESSION_ID}.jsonl"
tail -300 "$TRANSCRIPT_PATH" > "$EXCERPT"

# sed uses | as delimiter since paths contain /
PROMPT=$(sed \
    -e "s|{{TRANSCRIPT_PATH}}|$EXCERPT|g" \
    -e "s|{{CWD}}|${CWD}|g" \
    -e "s|{{SESSION_ID}}|${SESSION_ID}|g" \
    "$PROMPT_TEMPLATE")

cd "$CWD" 2>/dev/null || cd "$HOME/Claude"

# stdout to a FILE so it survives as failure evidence (the CLI reports errors —
# incl. weekly-usage-limit exhaustion — on stdout/exit code, not stderr).
# Internal timeout is a runaway backstop only; detachment removed the teardown
# pressure, so 300s is comfortable headroom rather than a race against teardown.
STDOUT_FILE="/tmp/claude/sessionend-stdout-${SESSION_ID}.txt"
STDERR_FILE="/tmp/claude/sessionend-stderr-${SESSION_ID}.txt"
# 9>&- closes the serialization-lock fd for the claude child (and below, for
# the daemonized audit): exec fds are not close-on-exec, and the nohup'd audit
# inheriting fd 9 held the BLOCKING flock until the audit finished — needlessly
# serializing every later session-end save behind it. QA 2026-07-02.
echo "$PROMPT" | CLAUDE_LIFECYCLE_AGENT=1 timeout -k 10 300 claude -p \
    --permission-mode bypassPermissions \
    --model sonnet \
    --no-session-persistence \
    --output-format text \
    > "$STDOUT_FILE" 2> "$STDERR_FILE" 9>&-
RC=$?
if [ "$RC" -eq 0 ]; then
    log "OK: save completed ($(wc -c < "$STDOUT_FILE") chars output)"
    rm -f "$STDOUT_FILE" "$STDERR_FILE"
elif [ "$RC" -eq 124 ]; then
    log "FAIL: internal timeout after 300s (stdout=$(head -c 300 "$STDOUT_FILE" 2>/dev/null | tr '\n' ' '))"
elif [ "$RC" -eq 137 ]; then
    log "FAIL: hard-killed (SIGKILL after timeout grace; stdout=$(head -c 300 "$STDOUT_FILE" 2>/dev/null | tr '\n' ' '))"
else
    log "FAIL: claude -p exit=$RC (stdout=$(head -c 300 "$STDOUT_FILE" 2>/dev/null | tr '\n' ' ') stderr=$(head -c 120 "$STDERR_FILE" 2>/dev/null | tr '\n' ' '))"
fi

# Durable retry (2026-07-02): a failed session-end save loses this session's
# TAIL — every turn since the last mid-session checkpoint, unique data. Enqueue
# a self-contained replay (prompt + persisted excerpt) for memory-retry.timer,
# which retries with backoff until usage/capacity returns. Mirrors the
# PreCompact enqueue; see memory-queue-lib.sh for the design rationale.
if [ "$RC" -ne 0 ]; then
    QUEUE_LIB="$HOME/.claude/hooks/memory-queue-lib.sh"
    if [ -f "$QUEUE_LIB" ]; then
        # shellcheck disable=SC1090
        source "$QUEUE_LIB"
        STAGE=$(mq_new_staging "sessionend-save")
        if cp "$EXCERPT" "$STAGE/excerpt.jsonl" 2>/dev/null; then
            # @@EXCERPT@@ is resolved by job.sh at RUN time — mq_enqueue moves
            # the job dir, so a staging path baked here would dangle (bug
            # caught by the harness test, 2026-07-02). The SESSION_ID sed is a
            # harmless no-op kept for symmetry with the precompact enqueue:
            # sessionend-prompt.md has no {{SESSION_ID}} placeholder.
            sed \
                -e "s|{{TRANSCRIPT_PATH}}|@@EXCERPT@@|g" \
                -e "s|{{CWD}}|${CWD}|g" \
                -e "s|{{SESSION_ID}}|${SESSION_ID}-retry|g" \
                "$PROMPT_TEMPLATE" > "$STAGE/prompt.txt"
            echo "$CWD" > "$STAGE/cwd"
            cat > "$STAGE/job.sh" <<'JOBEOF'
#!/bin/bash
# Replays a SessionEnd memory save that failed in the detached helper.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(cat "$DIR/cwd" 2>/dev/null)" 2>/dev/null || cd "$HOME/Claude" || exit 1
sed "s|@@EXCERPT@@|$DIR/excerpt.jsonl|g" "$DIR/prompt.txt" | \
CLAUDE_LIFECYCLE_AGENT=1 claude -p \
    --permission-mode bypassPermissions \
    --model sonnet \
    --no-session-persistence \
    --output-format text
JOBEOF
            if mq_enqueue "$STAGE" 420; then
                log "QUEUED: failed save enqueued for retry (queue=$(basename "$STAGE"))"
            else
                log "WARN: enqueue failed — save not queued for retry"
            fi
        else
            log "WARN: could not persist excerpt — save not queued for retry"
        fi
    fi
fi

# Chase the fresh memory write with the anti-sycophancy auditor (Phase 7.4),
# now correctly AFTER the save completes (the old parent launched it in parallel
# with the save, auditing a not-yet-written record). Self-gates + single-flight.
nohup python3 "$HOME/.claude/audit/run-memory-audit.py" --cwd "$CWD" >/dev/null 2>&1 9>&- &
disown 2>/dev/null || true

rm -f "$EXCERPT"
