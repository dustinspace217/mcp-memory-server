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
# LIMIT (verified 2026-10-05): setsid leaves the dying process GROUP, not the
# session scope's CGROUP. At logout/shutdown systemd stops session-N.scope with
# KillMode=control-group: SIGTERM+SIGHUP to every process in it at once, SIGKILL
# 45 s later (TimeoutStopUSec). A helper alive at that sweep dies on the SIGTERM;
# one forked after the sweep's last pass lives until the SIGKILL. Either way the
# save does not survive a shutdown, which is why the replay job below is
# persisted BEFORE anything slow happens.
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

# First line of evidence that the helper ran at all: a helper killed before it
# can stage its replay job would otherwise leave only the launcher's OK line
# (QA 2026-10-05, SLA-3). The pid lets the launcher's line and this one be paired.
log "START: helper running (pid $$)"

# TEST SEAMS (env-overridable, defaults are production). Documented here because
# Power-of-Ten rule 8 counts every env-driven path:
#  SESSIONEND_LOCK — the serialization lock file. The harness points it into its
#    sandbox so a test never blocks a real save, or vice versa (QA 2026-10-05, TA-4).
#  SESSIONEND_WRITEAHEAD_DELAY — seconds before the replay job becomes due. The
#    delay is RE-ARMED right after the lock is acquired (see below), so it only
#    has to outlast one live attempt (<= 310 s); 600 s is ~2x that and lets a
#    shutdown-killed save replay at the first worker tick 10 min after staging,
#    i.e. 5-25 min after the next boot (timer: OnBootSec=5min, OnUnitActiveSec=20min).
LOCK_PATH="${SESSIONEND_LOCK:-/tmp/claude/sessionend-save.lock}"
WRITEAHEAD_DELAY="${SESSIONEND_WRITEAHEAD_DELAY:-600}"

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

# WRITE-AHEAD RETRY JOB (2026-10-05). Persist the replay job to the durable
# queue BEFORE taking the lock and BEFORE the live claude -p run, then cancel
# it on success. Why: from 2026-10-02 to 10-04 every session end was a machine
# SHUTDOWN (sessions live across reboots via the resume protocol, so they only
# end when the box goes down). The journal shows "System is rebooting" in the
# same second the saves launched; a detached helper that first waits on the
# lock and then runs claude -p for 30-120 s was killed every time (42 launches,
# 1 outcome logged, 0 narratives), and because it died before the old
# enqueue-on-failure block, nothing was queued either. A shutdown-detection
# gate was rejected: the scope stop lands in the same second as the hook, so
# detection could miss while a persisted job cannot. Staging costs a mkdir+cp
# (milliseconds). The job becomes due WRITEAHEAD_DELAY after it is RE-ARMED
# below (right after the lock), so a long lock wait cannot make it due while
# the live attempt is still pending (QA 2026-10-05, four seats). A helper
# killed before the re-arm leaves the job due WRITEAHEAD_DELAY after staging,
# and memory-retry.timer replays it at its next tick after that.
JOBDIR=""
QUEUE_LIB="$HOME/.claude/hooks/memory-queue-lib.sh"
if [ -f "$QUEUE_LIB" ]; then
    # shellcheck disable=SC1090
    source "$QUEUE_LIB"

    # Unchanged excerpt = nothing new to narrate. Sessions kept alive across
    # reboots by the resume protocol end at EVERY shutdown, and an idle tab's
    # last-300-lines excerpt is identical night after night; without this check
    # each night re-saved the same tail as a fresh narrative (QA 2026-10-05,
    # SFH-4). The hash of the last COMPLETED save is kept per session id under
    # the queue root (written by the live path below and by job.sh on replay;
    # pruned after 30 days by the worker).
    EXCERPT_HASH=$(sha256sum "$EXCERPT" | cut -d' ' -f1)
    HASH_FILE="$MQ_ROOT/last-save/${SESSION_ID}"
    if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE" 2>/dev/null)" = "$EXCERPT_HASH" ]; then
        log "SKIP: excerpt unchanged since this session's last completed save — nothing new to narrate"
        rm -f "$EXCERPT"
        exit 0
    fi

    STAGE=$(mq_new_staging "sessionend-save")
    if cp "$EXCERPT" "$STAGE/excerpt.jsonl"; then
        # @@EXCERPT@@ is resolved by job.sh at RUN time — mq_enqueue moves the
        # job dir, so a staging path baked here would dangle (bug caught by the
        # harness test, 2026-07-02). The SESSION_ID sed is a harmless no-op kept
        # for symmetry with the precompact enqueue: sessionend-prompt.md has no
        # {{SESSION_ID}} placeholder. The appended REPLAY NOTE makes a replayed
        # narrative distinguishable from the live one it may duplicate
        # (QA 2026-10-05, SFH-5).
        {
            sed \
                -e "s|{{TRANSCRIPT_PATH}}|@@EXCERPT@@|g" \
                -e "s|{{CWD}}|${CWD}|g" \
                -e "s|{{SESSION_ID}}|${SESSION_ID}-retry|g" \
                "$PROMPT_TEMPLATE"
            printf '\n\nREPLAY NOTE: this is a REPLAY of the session-end save (the live attempt did not complete, e.g. the machine shut down). Prefix the session narrative with "[replay] " so it can be told apart from a live narrative of the same session.\n'
        } > "$STAGE/prompt.txt" || log "WARN: prompt.txt write failed (rc=$?) — replay may be unusable"
        echo "$CWD" > "$STAGE/cwd" || log "WARN: cwd write failed (rc=$?)"
        # Values baked at staging time (the worker runs job.sh without this
        # helper's environment): the lock path, so the replay yields to a live
        # save instead of running beside it; the hash store path and the
        # excerpt hash, so a successful replay records the save like the live
        # path does.
        cat > "$STAGE/job.sh" <<JOBEOF
#!/bin/bash
# Replays a SessionEnd memory save whose live attempt did not complete
# (killed by a shutdown, usage limit, timeout, ...).
set -uo pipefail
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
# Yield, never wait: if a live session-end save holds the lock, exit nonzero and
# let the worker retry later (a blocking wait would stall the single-flight
# worker behind a whole burst; QA 2026-10-05, CR-1/SLA-1).
exec 8>"${LOCK_PATH}"
if ! flock -n 8; then
    echo "live session-end save holds the lock; yielding"
    exit 75
fi
cd "\$(cat "\$DIR/cwd" 2>/dev/null)" 2>/dev/null || cd "\$HOME/Claude" || exit 1
sed "s|@@EXCERPT@@|\$DIR/excerpt.jsonl|g" "\$DIR/prompt.txt" | \\
CLAUDE_LIFECYCLE_AGENT=1 claude -p \\
    --permission-mode bypassPermissions \\
    --model sonnet \\
    --no-session-persistence \\
    --output-format text || exit \$?
mkdir -p "${MQ_ROOT}/last-save" && echo "${EXCERPT_HASH}" > "${MQ_ROOT}/last-save/${SESSION_ID}"
JOBEOF
        if mq_enqueue "$STAGE" 420 "$WRITEAHEAD_DELAY"; then
            JOBDIR="$MQ_LAST_JOB"
            log "STAGED: replay job persisted before the live save (queue=$(basename "$JOBDIR"))"
        else
            log "WARN: write-ahead enqueue failed (rc=$?) — a killed save will not be retried"
        fi
    else
        log "WARN: could not persist excerpt (cp rc=$?) — a killed save will not be retried"
    fi
else
    # Without the lib the helper is exactly the pre-2026-10-05 code: a shutdown
    # kill would leave no trace. Say so (QA 2026-10-05, SFH-1).
    log "WARN: queue lib missing at $QUEUE_LIB — write-ahead disabled, a killed save will not be retried"
fi

# Serialize concurrent detached saves so back-to-back session-ends don't stack
# claude -p processes. BLOCKING (not -n): never SKIP a save — each session's
# tail is unique data and skipping loses exactly what this save exists to
# capture. Detached, so waiting for the lock costs nothing (and the replay job
# above is already on disk if the wait is cut short by a shutdown).
exec 9>"$LOCK_PATH"
flock 9

# Past the lock. Two things before the live run (QA 2026-10-05, CR-1/SLA-1):
# (1) if the worker already replayed this save while we waited, the job dir is
#     gone — running the live save now would write a duplicate, so skip it;
# (2) otherwise re-arm the delay from NOW, so it only has to outlast this one
#     attempt (bounded at 310 s) rather than the whole lock wait.
if [ -n "$JOBDIR" ]; then
    if ! mq_job_present "$JOBDIR"; then
        log "SKIP: replay job already consumed by the worker while waiting for the lock — live save skipped to avoid a duplicate (queue=$(basename "$JOBDIR"))"
        rm -f "$EXCERPT"
        exit 0
    fi
    mq_defer "$JOBDIR" "$WRITEAHEAD_DELAY" || log "WARN: could not re-arm the replay delay (rc=$?) — it stays due ${WRITEAHEAD_DELAY}s after staging"
fi

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
    rm -f "$STDOUT_FILE" "$STDERR_FILE"
    # Live save won. Record the excerpt hash (SFH-4), then drop the replay job
    # and SAY what happened to it (directive 6; QA 2026-10-05, SLA-2/CR-3): a job
    # that is already gone means the worker replayed it and a duplicate may exist.
    if [ -n "$JOBDIR" ]; then
        mkdir -p "$MQ_ROOT/last-save" && echo "$EXCERPT_HASH" > "$HASH_FILE"
        if ! mq_job_present "$JOBDIR"; then
            log "OK: save completed; replay job was already gone — the worker may have written a duplicate (queue=$(basename "$JOBDIR"))"
        elif mq_cancel "$JOBDIR"; then
            log "OK: save completed; replay job cancelled (queue=$(basename "$JOBDIR"))"
        else
            log "WARN: save completed but the replay job could not be removed (rc=$?) — it will replay as a duplicate (queue=$(basename "$JOBDIR"))"
        fi
    else
        log "OK: save completed (no replay job was staged)"
    fi
elif [ "$RC" -eq 124 ]; then
    log "FAIL: internal timeout after 300s (stdout=$(head -c 300 "$STDOUT_FILE" 2>/dev/null | tr '\n' ' '))"
elif [ "$RC" -eq 137 ]; then
    log "FAIL: hard-killed (SIGKILL after timeout grace; stdout=$(head -c 300 "$STDOUT_FILE" 2>/dev/null | tr '\n' ' '))"
else
    log "FAIL: claude -p exit=$RC (stdout=$(head -c 300 "$STDOUT_FILE" 2>/dev/null | tr '\n' ' ') stderr=$(head -c 120 "$STDERR_FILE" 2>/dev/null | tr '\n' ' '))"
fi

# Durable retry (2026-07-02; write-ahead since 2026-10-05): the replay job was
# persisted above, before the live attempt. On failure, pull it forward so
# memory-retry.timer runs it at the next tick and retries with backoff until
# usage/capacity returns. Every branch logs what is true of the job (directive
# 6): staged or not, still present or already replayed, made due or not.
if [ "$RC" -ne 0 ]; then
    if [ -z "$JOBDIR" ]; then
        log "WARN: save failed and no replay job was staged — tail lost"
    elif ! mq_job_present "$JOBDIR"; then
        log "WARN: save failed but the replay job is already gone — the worker replayed it, nothing more to retry (queue=$(basename "$JOBDIR"))"
    elif mq_make_due "$JOBDIR"; then
        log "QUEUED: failed save will be retried from the write-ahead job (queue=$(basename "$JOBDIR"))"
    else
        log "WARN: save failed and the replay job could not be made due (rc=$?) — it stays due ${WRITEAHEAD_DELAY}s after staging (queue=$(basename "$JOBDIR"))"
    fi
fi

# Chase the fresh memory write with the anti-sycophancy auditor (Phase 7.4),
# now correctly AFTER the save completes (the old parent launched it in parallel
# with the save, auditing a not-yet-written record). Self-gates + single-flight.
nohup python3 "$HOME/.claude/audit/run-memory-audit.py" --cwd "$CWD" >/dev/null 2>&1 9>&- &
disown 2>/dev/null || true

rm -f "$EXCERPT"
