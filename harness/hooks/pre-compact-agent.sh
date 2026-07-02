#!/bin/bash
# PreCompact hook — saves context to MCP before compaction, writes briefing for PostCompact.
#
# Reads hook input JSON from stdin. Extracts transcript_path, cwd, session_id, trigger.
# Extracts transcript lines since the last compact_boundary (not the full history).
# Spawns claude -p which: saves to MCP, checks sycophancy, writes briefing + instructions.
#
# CRITICAL: claude -p's stdout is redirected to a log file (NOT to this script's stdout).
# Only the contents of the instructions file go to stdout → becomes newCustomInstructions,
# which influences what the compaction model preserves in the summary.
#
# Timeout governed by settings.json (480s); internal claude -p timeout is
# INTERNAL_TIMEOUT below (single source — log lines derive from it).
# Logs success/failure to ~/.claude/hooks/hook-execution.log.

set -uo pipefail

LOGFILE="$HOME/.claude/hooks/hook-execution.log"
mkdir -p /tmp/claude

log() {
    # session= is appended centrally so every line is correlatable to a session —
    # the June 2026 failure forensics required matching /tmp filenames because
    # these log lines carried no session id. SESSION_ID is parsed before the
    # first log call; the :-unset fallback covers any future early call.
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | PreCompact | $1 (session=${SESSION_ID:-unset})" >> "$LOGFILE"
}

# Recursion guard: this script spawns claude -p; if that child ever compacts
# or otherwise fires lifecycle hooks, we must not spawn grandchildren. The
# spawn site below sets CLAUDE_LIFECYCLE_AGENT=1 in the child's environment.
if [ -n "${CLAUDE_LIFECYCLE_AGENT:-}" ]; then
    log "SKIP: recursion guard (lifecycle agent child)"
    exit 0
fi

# Leave a trace if the harness kills us (shouldn't happen now that claude -p
# has an internal timeout inside the 480s settings.json budget). NOTE: the
# trap only logs — it must NOT write to stdout, which is reserved for
# newCustomInstructions.
trap 'log "FAIL: killed by SIGTERM"; exit 143' TERM

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "auto"')

# Nothing to analyze without a transcript
if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log "SKIP: no transcript"
    echo "Preserve all decisions, procedures, user preferences, and project status."
    exit 0
fi

# Extract transcript lines since the last compact_boundary.
# Use a JSON-aware match to avoid false positives from user messages that mention
# the string "compact_boundary" in conversation (which happened in this very session).
EXCERPT="/tmp/claude/transcript-excerpt-${SESSION_ID}.jsonl"
LAST_BOUNDARY_LINE=$(grep -n '"subtype":"compact_boundary"\|"subtype": "compact_boundary"' "$TRANSCRIPT_PATH" | tail -1 | cut -d: -f1)
if [ -n "$LAST_BOUNDARY_LINE" ]; then
    tail -n "+$((LAST_BOUNDARY_LINE + 1))" "$TRANSCRIPT_PATH" > "$EXCERPT"
else
    tail -400 "$TRANSCRIPT_PATH" > "$EXCERPT"
fi

# Check excerpt has content worth analyzing
EXCERPT_LINES=$(wc -l < "$EXCERPT")
if [ "$EXCERPT_LINES" -lt 5 ]; then
    log "SKIP: excerpt too short ($EXCERPT_LINES lines since last compaction)"
    echo "Preserve all recent context — very little new content since last compaction."
    rm -f "$EXCERPT"
    exit 0
fi

# Debounce: check if a full save happened recently.
# If so, skip MCP saves but still write the briefing/instructions files.
DEBOUNCE_FILE="/tmp/claude/last-memory-save-${SESSION_ID}.txt"
SKIP_SAVES="false"
if [ -f "$DEBOUNCE_FILE" ]; then
    LAST_SAVE=$(cat "$DEBOUNCE_FILE")
    NOW=$(date +%s)
    ELAPSED=$(( NOW - LAST_SAVE ))
    if [ "$ELAPSED" -lt 600 ]; then
        SKIP_SAVES="true"
    fi
fi

# Load the prompt template and inject paths
PROMPT_TEMPLATE="$HOME/.claude/hooks/precompact-prompt.md"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
    log "FAIL: prompt template not found"
    echo "Preserve all decisions, procedures, user preferences, and project status."
    exit 0
fi

PROMPT=$(sed \
    -e "s|{{TRANSCRIPT_PATH}}|$EXCERPT|g" \
    -e "s|{{CWD}}|${CWD:-$HOME/Claude}|g" \
    -e "s|{{SESSION_ID}}|${SESSION_ID}|g" \
    -e "s|{{TRIGGER}}|${TRIGGER}|g" \
    -e "s|{{SKIP_SAVES}}|${SKIP_SAVES}|g" \
    "$PROMPT_TEMPLATE")

# Spawn claude -p.
# IMPORTANT: stdout goes to a LOG FILE, not to this script's stdout.
# This prevents claude -p's reasoning text from contaminating newCustomInstructions.
# Internal timeout (420s + 10s kill grace) fires BEFORE the settings.json hook
# budget (480s): a harness kill would skip the instructions delivery below and
# hand the compaction model EMPTY newCustomInstructions (worse than the designed
# fallback); an internal timeout (exit 124) flows through normally so the
# fallback text still ships. The CLI reports errors — including usage-limit
# exhaustion, the June 2026 failure cluster — on stdout/exit code, NOT stderr,
# so FAIL lines log the stdout head and the capture files are kept on failure.
# 240→420 (2026-07-02): 240s was CHRONICALLY short — five internal timeouts in
# three days, including one where the agent was killed while PRINTING ITS
# COMPLETION SUMMARY (the work was done; only the exit was late). The ceiling
# only costs wall-clock in runs that would otherwise die: fast runs are
# unaffected, and compaction blocks on this hook either way (docs confirm
# PreCompact blocks; per-hook command default is 600s, so 480 is conservative).
cd "${CWD:-$HOME/Claude}" 2>/dev/null || cd "$HOME/Claude"

CLAUDE_LOG="/tmp/claude/precompact-claude-output-${SESSION_ID}.txt"
# Single source of truth for the internal ceiling — the rc=124 log line derives
# from this variable so the logged duration can never drift from the real one
# again (QA 2026-07-02: the 240→420 bump left "after 240s" in the FAIL line).
INTERNAL_TIMEOUT=420
echo "$PROMPT" | CLAUDE_LIFECYCLE_AGENT=1 timeout -k 10 "$INTERNAL_TIMEOUT" claude -p \
    --permission-mode bypassPermissions \
    --model sonnet \
    --no-session-persistence \
    --output-format text \
    > "$CLAUDE_LOG" 2>/tmp/claude/precompact-stderr-${SESSION_ID}.txt
PRECOMPACT_RC=$?
if [ "$PRECOMPACT_RC" -eq 0 ]; then
    log "OK: claude -p completed (trigger=$TRIGGER, skip_saves=$SKIP_SAVES, excerpt=$EXCERPT_LINES lines)"
elif [ "$PRECOMPACT_RC" -eq 124 ]; then
    log "FAIL: internal timeout after ${INTERNAL_TIMEOUT}s (stdout=$(head -c 300 "$CLAUDE_LOG" 2>/dev/null | tr '\n' ' '))"
elif [ "$PRECOMPACT_RC" -eq 137 ]; then
    # timeout's -k grace expired and it escalated to SIGKILL — label it as a
    # timeout escalation, not a generic exit (QA: 137 was mislabeled before)
    log "FAIL: hard-killed (SIGKILL after timeout grace; stdout=$(head -c 300 "$CLAUDE_LOG" 2>/dev/null | tr '\n' ' '))"
else
    log "FAIL: claude -p exit=$PRECOMPACT_RC (stdout=$(head -c 300 "$CLAUDE_LOG" 2>/dev/null | tr '\n' ' ') stderr=$(head -c 120 /tmp/claude/precompact-stderr-${SESSION_ID}.txt 2>/dev/null | tr '\n' ' '))"
fi

# Update debounce timestamp — only when we attempted saves AND the agent
# exited 0. Stamping on failure converts ONE failed save into TWO missed
# saves: the next PreCompact within 10 minutes would read the stamp and set
# SKIP_SAVES=true, suppressing its own save with no trace (QA 2026-06-09,
# found independently by two reviewers). Exit code is the contract — the
# CLI's prose can lie, its exit code doesn't (reference_claude_cli_behavior.md).
if [ "$SKIP_SAVES" = "false" ] && [ "$PRECOMPACT_RC" -eq 0 ]; then
    date +%s > "$DEBOUNCE_FILE"
fi

# Durable retry (2026-07-02): a killed/failed save used to be simply LOST —
# timeout, usage-limit exhaustion, whatever; the data was gone unless the
# in-context session had checkpointed. Now the failure enqueues a
# self-contained replay job (prompt + a persisted copy of the excerpt) into
# ~/.local/state/claude-memory-queue, and memory-retry.timer (plain bash +
# systemd, no Claude dependency) retries it with backoff until usage returns.
# Only when saves were actually attempted-and-failed: a SKIP_SAVES run has
# nothing to replay. The replay prompt is rebuilt with SESSION_ID suffixed
# "-retry" so its /tmp outputs (briefing/instructions, meaningless after the
# compaction has already happened) can never collide with a LIVE PreCompact
# run of the same session.
if [ "$SKIP_SAVES" = "false" ] && [ "$PRECOMPACT_RC" -ne 0 ]; then
    QUEUE_LIB="$HOME/.claude/hooks/memory-queue-lib.sh"
    if [ -f "$QUEUE_LIB" ]; then
        # shellcheck disable=SC1090
        source "$QUEUE_LIB"
        STAGE=$(mq_new_staging "precompact-save")
        if cp "$EXCERPT" "$STAGE/excerpt.jsonl" 2>/dev/null; then
            # The excerpt path is left as the @@EXCERPT@@ token, resolved by
            # job.sh AT RUN TIME against its own directory: the staged prompt
            # can't embed a real path because mq_enqueue MOVES the job from
            # staging/ to jobs/ (and a baked staging path would dangle — a
            # real bug the harness test caught on its first run, 2026-07-02).
            sed \
                -e "s|{{TRANSCRIPT_PATH}}|@@EXCERPT@@|g" \
                -e "s|{{CWD}}|${CWD:-$HOME/Claude}|g" \
                -e "s|{{SESSION_ID}}|${SESSION_ID}-retry|g" \
                -e "s|{{TRIGGER}}|${TRIGGER}|g" \
                -e "s|{{SKIP_SAVES}}|false|g" \
                "$PROMPT_TEMPLATE" > "$STAGE/prompt.txt"
            # cwd is a payload file (not baked into job.sh) so the heredoc can
            # stay fully quoted — no expansion surprises inside the job script.
            echo "${CWD:-$HOME/Claude}" > "$STAGE/cwd"
            cat > "$STAGE/job.sh" <<'JOBEOF'
#!/bin/bash
# Replays a PreCompact memory save that died in the live hook (see run.log
# for attempts). Payload lives beside this script; the worker moves the whole
# directory, so locate everything relative to $0 — including the excerpt path,
# substituted into the prompt here rather than at staging time.
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

# Output ONLY the preservation instructions to stdout → becomes newCustomInstructions.
# This is the ONLY thing that should reach stdout — it tells the compaction model what to preserve.
INSTRUCTIONS_FILE="/tmp/claude/compact-instructions-${SESSION_ID}.txt"
if [ -f "$INSTRUCTIONS_FILE" ]; then
    cat "$INSTRUCTIONS_FILE"
    rm -f "$INSTRUCTIONS_FILE"
    log "OK: instructions file delivered to compaction model"
else
    # Fallback: generic preservation guidance
    echo "Preserve all decisions, procedures, user preferences, project status, and relational context in the compaction summary. Do not discard any information about what was being worked on or why."
    log "WARN: instructions file not found — using fallback"
fi

# Clean up. The excerpt always goes; claude -p's stdout/stderr captures are
# KEPT on failure as evidence for session-health-check.py's surfacing at the
# next session start (the CLI reports errors on stdout, not stderr).
rm -f "$EXCERPT"
if [ "${PRECOMPACT_RC:-1}" -eq 0 ]; then
    rm -f "$CLAUDE_LOG" "/tmp/claude/precompact-stderr-${SESSION_ID}.txt"
fi
