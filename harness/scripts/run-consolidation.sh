#!/usr/bin/env bash
# run-consolidation.sh -- Weekly memory consolidation via claude -p
#
# Invokes Claude Code in non-interactive mode with a stripped-down config:
#   - consolidation-settings.json: no hooks, no auto-memory, high effort, opus
#   - consolidation-mcp.json: ONLY the memory MCP server (--strict-mcp-config)
#   - --tools restricts built-ins to read-only (MCP tools load from server)
# This prevents the SessionEnd hook from firing and creating recursive noise.
#
# Usage:
#   bash ~/.claude/scripts/run-consolidation.sh
#
# Called by: systemd user timer memory-consolidation.timer
# Logs to:  ~/Claude/consolidator/  (persistent — survives reboot, so multi-run data accumulates; mode 700)
# On failure/timeout: writes ~/Claude/consolidator/LAST_FAILURE
#
# File relationships (6 files, 4 directories):
#   THIS SCRIPT (orchestrator)
#     ├── reads:    ~/.claude/prompts/memory-consolidation.md   (agent prompt: write policy + 3-pass workflow)
#     ├── reads:    ~/.claude/consolidation-settings.json        (claude -p config: opus, no hooks, extended thinking)
#     ├── reads:    ~/.claude/consolidation-mcp.json             (MCP config: memory server only)
#     └── called by:
#           ├── ~/.config/systemd/user/memory-consolidation.service  (systemd oneshot unit)
#           └── ~/.config/systemd/user/memory-consolidation.timer    (weekly: Mon 6am Pacific)
#
# To check timer status:  systemctl --user list-timers memory-consolidation.timer
# To run manually:        bash ~/.claude/scripts/run-consolidation.sh
# To check last failure:  cat ~/Claude/consolidator/LAST_FAILURE
# To read recent log:     ls -t ~/Claude/consolidator/consolidation-*.log | head -1 | xargs cat
#
# --- Settings file rationale (consolidation-settings.json) ---
# JSON doesn't support comments, so the reasoning lives here.
#   "model": "opus"           — consolidation requires judgment (is this stale? should these merge?)
#   "effortLevel": "high"     — thorough per-observation evaluation across 100+ entities
#   "autoMemoryEnabled": false — prevents the agent from saving auto-memory that bypasses write policy
#   "hooks": {}               — INTENDED to suppress SessionEnd/PreCompact hooks, but --settings
#                                merges additively (doesn't replace user hooks). The hooks fire but
#                                agent-type hooks fail harmlessly in -p mode. Cosmetic log noise only.
#   permissions.deny           — restricts Bash to read-only commands (compensates for --dangerously-skip-permissions)
#   (CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING + MAX_THINKING_TOKENS were removed
#    2026-07-04: inert on Opus 4.8+, which ignores both — pending cleanup since
#    the 2026-06-05 checkpoint. effortLevel xhigh is the live thinking knob.)

set -euo pipefail

# --- Configuration ---
PROMPT_FILE="$HOME/.claude/prompts/memory-consolidation.md"
SETTINGS_FILE="$HOME/.claude/consolidation-settings.json"
MCP_CONFIG="$HOME/.claude/consolidation-mcp.json"
LOG_DIR="$HOME/Claude/consolidator"
FAILURE_FILE="$LOG_DIR/LAST_FAILURE"
WORK_DIR="$HOME/Claude"
TIMESTAMP="$(date -u +'%Y-%m-%dT%H%M%SZ')"
LOG_FILE="$LOG_DIR/consolidation-$TIMESTAMP.log"

# --- Preflight checks ---
# Preflight failures used to exit straight to the systemd journal — invisible,
# the same class as the June 5-8 run failures (QA 2026-06-09 m4). Surface them
# in hook-execution.log so session-health-check.py reports them at the next
# session start. Self-contained + best-effort: log_failure isn't defined yet
# at this point, and a failed append must not mask the preflight exit.
preflight_fail() {
    echo "ERROR: $1" >&2
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | Consolidation | FAIL: preflight: $1 (exit=1)" >> "$HOME/.claude/hooks/hook-execution.log" || true
    exit 1
}

if ! command -v claude &>/dev/null; then
    preflight_fail "claude CLI not found in PATH"
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
    preflight_fail "Prompt file not found: $PROMPT_FILE"
fi

if [[ ! -f "$SETTINGS_FILE" ]]; then
    preflight_fail "Settings file not found: $SETTINGS_FILE"
fi

if [[ ! -f "$MCP_CONFIG" ]]; then
    preflight_fail "MCP config not found: $MCP_CONFIG"
fi

if [[ ! -d "$WORK_DIR" ]]; then
    preflight_fail "Working directory not found: $WORK_DIR"
fi

# --- Setup ---
# Mode 700 = user-only: logs contain observation text from memory.db which may
# include project decisions, architecture details, and user preferences.
mkdir -p -m 700 "$LOG_DIR"

# Single-flight (2026-07-02): with the memory-retry queue able to replay a
# failed run, TWO paths can now start this script (weekly timer + queued
# retry) — and a manual run beside the timer was always possible. Two
# concurrent opus consolidations racing on the same memory.db would be
# expensive at best and write-conflicting at worst. Non-blocking: the loser
# exits 0 (the running instance owns success/failure reporting, and a queued
# retry that finds a live run can safely dequeue itself — if that run fails,
# it enqueues a fresh retry).
exec 8>"$LOG_DIR/.run.lock"
if ! flock -n 8; then
    echo "Another consolidation run is already in progress — exiting."
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | Consolidation | SKIP: another run in progress" >> "$HOME/.claude/hooks/hook-execution.log" || true
    exit 0
fi

# Write a failure marker BEFORE the run starts. If the script is OOM-killed
# or receives SIGKILL between here and the success path, the marker persists
# so monitoring detects the crash. The success path removes it.
cat > "$FAILURE_FILE" <<FAILEOF
reason: run started but did not complete (possible OOM-kill or SIGKILL)
exit_code: unknown
timestamp: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
log_file: $LOG_FILE
FAILEOF

# Read the prompt from the file
PROMPT="$(cat "$PROMPT_FILE")"

# --- Logging helpers ---
# log_failure writes a human-readable failure file that persists until the
# next successful run. Check for this file to know if something went wrong.
log_failure() {
    local reason="$1"
    local exit_code="${2:-1}"
    cat > "$FAILURE_FILE" <<FAILEOF
reason: $reason
exit_code: $exit_code
timestamp: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
log_file: $LOG_FILE
FAILEOF
    echo "FAILURE: $reason (exit $exit_code)" | tee -a "$LOG_FILE"
    # Surface the failure where something actually LOOKS: session-health-check.py
    # (SessionStart hook) scans hook-execution.log for "| FAIL" lines and reports
    # them, classified, at the next session start. Without this line, failures
    # lived only in this directory's logs + LAST_FAILURE, which nothing reads —
    # three consecutive failures (2026-06-05..08) surfaced to no one (QA 2026-06-09).
    # Best-effort (|| true): log_failure runs under restored `set -e` — if this
    # append ever fails (hooks dir missing/unwritable), dying here would BOTH
    # lose the surfacing line AND replace the script's real exit code, exactly
    # the invisibility being fixed (QA 2026-06-09 m2, found by two reviewers).
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | Consolidation | FAIL: $reason (exit=$exit_code)" >> "$HOME/.claude/hooks/hook-execution.log" || true
}

echo "=== Memory Consolidation Run ===" | tee "$LOG_FILE"
echo "Started: $(date -u +'%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE"
echo "Working directory: $WORK_DIR" | tee -a "$LOG_FILE"
echo "Prompt: $PROMPT_FILE" | tee -a "$LOG_FILE"
echo "---" | tee -a "$LOG_FILE"

# --- Run Claude in non-interactive mode ---
# cd to ~/Claude so the agent can read any project file via absolute path.
# Auth: Max subscription OAuth (no --bare, which would require ANTHROPIC_API_KEY).
#
# --settings:            stripped config — no hooks, no auto-memory, opus, high effort
# --strict-mcp-config:   ignore all user/project MCP servers
# --mcp-config:          load ONLY the memory MCP server
# --tools:               restrict built-in tools to read-only (MCP tools unaffected)
# --dangerously-skip-permissions: no interactive prompts (unattended)
# --disable-slash-commands:       no skill loading overhead
# --system-prompt:       override default system prompt (prevents CLAUDE.md Session
#                        Protocol from competing with the consolidation instructions)
# timeout budget:        RETRY_BUDGET (7000s) is a SHARED ~2-hour cap across ALL
#                        retry attempts (see below), kept under systemd
#                        TimeoutStartSec=7260. opus[1m] holds the whole graph without
#                        compaction, so a long single coherent pass is the point.
cd "$WORK_DIR"

# Lifecycle recursion guard (2026-06-09): the claude -p child fires SessionEnd
# hooks on exit; session-end-agent.sh and pre-compact-agent.sh exit early when
# this var is set. Before this, the child's SessionEnd hook actually ran and
# no-op'd only because -p mode left no transcript — "an accident of behavior,
# not a guarantee" (the hook's own words) — and the run logs collected
# "Hook cancelled" noise (see consolidation-2026-06-08T185106Z.log tail).
export CLAUDE_LIFECYCLE_AGENT=1

# --- Project backfill: map global (project=NULL) memories to their project (best-effort) ---
# Closes the ~/Claude-global-session mapping gap: entities saved without a project (because the
# session's cwd was the workspace root) get re-scoped by DETERMINISTIC, conservative rules
# (name prefix-matches a known project; or a '<x>-continuity-thread' derives project '<x>'). The
# script backs ITSELF up (WAL-safe) before any write and is a NO-OP when nothing matches, so a
# normal week is free. Output (changes + backup path) appends to the consolidation log for audit.
# Best-effort: a failure must NEVER abort the consolidation run.
if python3 "$HOME/Claude/mcp-memory-server/scripts/backfill_project.py" --apply >> "$LOG_FILE" 2>&1; then
    echo "Project backfill: ran (see log for changes/backup, if any)" | tee -a "$LOG_FILE"
else
    echo "WARN: project backfill failed (non-fatal)" | tee -a "$LOG_FILE"
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | Consolidation | WARN: project backfill failed (non-fatal)" >> "$HOME/.claude/hooks/hook-execution.log" || true
fi

# --- Episodic autobiography: pre-generate the compression work plan (best-effort) ---
# The decay gradient's Phase 1 (plan 2026-06-10-episodic-decay-gradient.md). The
# DETERMINISTIC half — which aged days need a gist/era and from which ORIGINAL
# narratives — runs here in python (episodic_autobiography.py --plan) so the agent's
# Pass F only does the LLM synthesis + MCP writes. Best-effort by design: a failure
# here must NEVER abort the consolidation run, so it is guarded and Pass F simply skips
# when the file is absent. We delete a stale plan on failure so the agent never acts on
# last week's list. (`|| true` on mkdir: a /tmp/claude hiccup must not kill the run.)
# Write the plan under LOG_DIR (mode 700, created above), NOT /tmp/claude: the plan embeds
# raw session-narratives (same sensitivity as the consolidation logs), and /tmp is world-
# traversable; the sibling log dir already gets 700 for exactly this content (QA security).
AUTOBIO_WORK="$LOG_DIR/autobiography-work.txt"
if python3 "$HOME/Claude/mcp-memory-server/scripts/episodic_autobiography.py" --plan > "$AUTOBIO_WORK" 2>>"$LOG_FILE"; then
    echo "Episodic autobiography: work plan written to $AUTOBIO_WORK" | tee -a "$LOG_FILE"
else
    echo "WARN: episodic autobiography work-plan generation failed (non-fatal); Pass F will skip" | tee -a "$LOG_FILE"
    rm -f "$AUTOBIO_WORK"
    # Surface it where something actually LOOKS: session-health-check.py scans
    # hook-execution.log for "| WARN"/"| FAIL" lines. Without this, a silently-failing
    # plan-gen would let episodic compression stop for weeks behind a green timer — the
    # exact invisibility the June-incident fix addressed for log_failure/preflight_fail
    # (QA silent-failure HIGH). Best-effort (|| true) so a logging hiccup can't mask the exit.
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | Consolidation | WARN: episodic autobiography work-plan generation failed (non-fatal); Pass F skipped" >> "$HOME/.claude/hooks/hook-execution.log" || true
fi

# --- Run Claude with bounded retry on TRANSIENT server errors ---
# A single transient `API Error: Overloaded` (529 / server overload) killed an
# otherwise-healthy 14-minute run on 2026-06-05 and, with Restart=no, left the weekly
# job dead until the next scheduled run. `claude -p` surfaces Overloaded as a fatal
# exit-1 with NO internal retry, so we retry HERE.
#
# Design (smallest sufficient):
#   - Retry ONLY on detected transient server errors (Overloaded / 5xx-class). The
#     weekly usage limit ("You've hit your weekly limit") and genuine errors do NOT
#     retry — retrying a usage limit is pointless (it persists for days) and retrying
#     a real bug just burns budget.
#   - A SHARED time budget (RETRY_BUDGET) bounds total wall clock so retries can never
#     exceed systemd's TimeoutStartSec. Each attempt's `timeout` is the budget
#     REMAINING, so attempts + back-offs together stay under the cap.
#   - MAX_ATTEMPTS caps a fast-failing Overloaded from looping many times.
RETRY_BUDGET=7000        # total seconds across ALL attempts (< systemd TimeoutStartSec=7260)
MAX_ATTEMPTS=3
RETRY_BACKOFF=45         # seconds to wait between attempts
ATTEMPT_FLOOR=300        # don't start a fresh attempt with less than this much budget left
START_EPOCH="$(date +%s)"

# Transient/retryable server errors claude -p prints to stdout. CONSERVATIVE and
# anchored on the empirically-observed "API Error: Overloaded" (2026-06-05 log) plus
# its clear server-side siblings, all behind the "API Error:" prefix so stray numbers
# can't false-match. Deliberately excludes the weekly usage limit, auth failures, and
# tool/logic errors (not retryable). If a new transient string shows up in a log,
# read the exact wording and add it here rather than guessing now.
TRANSIENT_RE='API Error: (Overloaded|Internal server error|Service Unavailable|Bad Gateway|Gateway Timeout)|overloaded_error'

EXIT_CODE=1
set +e
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    remaining=$(( START_EPOCH + RETRY_BUDGET - $(date +%s) ))
    if (( remaining < ATTEMPT_FLOOR )); then
        echo "--- Retry budget exhausted (${remaining}s left < ${ATTEMPT_FLOOR}s floor) — not starting attempt $attempt ---" | tee -a "$LOG_FILE"
        break
    fi

    echo "=== Attempt $attempt/$MAX_ATTEMPTS (per-attempt timeout ${remaining}s) $(date -u +'%Y-%m-%dT%H:%M:%SZ') ===" | tee -a "$LOG_FILE"

    # Capture THIS attempt's output to a temp file (so we can scan it for transient
    # errors) while still streaming everything to the main log and the journal via tee.
    mkdir -p /tmp/claude
    ATTEMPT_OUT="$(mktemp /tmp/claude/consolidation-attempt.XXXXXX)"
    # 8>&- closes the single-flight lock fd for the claude child: fds opened
    # with exec are not close-on-exec, and a daemonized grandchild inheriting
    # the fd would hold the lock after this run exits — silently wedging every
    # future run (the flock-loser exits 0 with no trace). QA 2026-07-02.
    timeout --kill-after=10 "$remaining" claude -p "$PROMPT" \
        --settings "$SETTINGS_FILE" \
        --strict-mcp-config \
        --mcp-config "$MCP_CONFIG" \
        --tools "Bash,Read,Glob,Grep" \
        --dangerously-skip-permissions \
        --disable-slash-commands \
        --system-prompt "You are a memory consolidation agent. Follow the user's instructions exactly. Do not run any session startup protocol. Do not read CLAUDE.md or MEMORY.md. Focus solely on the consolidation task described in the prompt." \
        8>&- 2>&1 | tee -a "$LOG_FILE" "$ATTEMPT_OUT"
    # PIPESTATUS[0] is the exit code from 'timeout claude' (not tee)
    EXIT_CODE=${PIPESTATUS[0]}

    # Success, or a budget timeout (124 = not transient), stops the loop. Only a
    # non-zero exit whose output matches a transient server error retries.
    if (( EXIT_CODE == 0 )) || (( EXIT_CODE == 124 )); then
        rm -f "$ATTEMPT_OUT"
        break
    fi
    # Scope the transient-error scan to the output TAIL: the CLI's fatal error
    # is the last thing it prints. The memory graph now contains observations
    # QUOTING past errors ("API Error: Overloaded", 2026-06-05) and the agent
    # may echo them mid-report — a full-output grep would spuriously retry a
    # non-retryable failure with up to 2 more full opus runs (QA 2026-06-09).
    if tail -n 20 "$ATTEMPT_OUT" | grep -qiE "$TRANSIENT_RE" && (( attempt < MAX_ATTEMPTS )); then
        rm -f "$ATTEMPT_OUT"
        echo "--- Attempt $attempt failed on a TRANSIENT server error (exit $EXIT_CODE) — retrying in ${RETRY_BACKOFF}s ---" | tee -a "$LOG_FILE"
        sleep "$RETRY_BACKOFF"
        continue
    fi
    rm -f "$ATTEMPT_OUT"
    break
done
set -e

echo "---" | tee -a "$LOG_FILE"
echo "Finished: $(date -u +'%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE"
echo "Exit code: $EXIT_CODE" | tee -a "$LOG_FILE"

# --- Handle failure ---
if [[ $EXIT_CODE -eq 124 ]]; then
    log_failure "Timed out (retry budget of ${RETRY_BUDGET}s exhausted)" 124
elif [[ $EXIT_CODE -eq 137 ]]; then
    # 137 = SIGKILL of the claude child: either timeout's --kill-after grace
    # escalating, OR the kernel OOM-killer (the pre-run marker names OOM as a
    # live possibility) — both route through `timeout` identically, so don't
    # overclaim which (QA 2026-06-09 m3).
    log_failure "Hard-killed (SIGKILL — timeout escalation or OOM)" 137
elif [[ $EXIT_CODE -ne 0 ]]; then
    log_failure "Claude exited with error" "$EXIT_CODE"
else
    # Success — clear any previous failure marker
    rm -f "$FAILURE_FILE"
    echo "STATUS: Success" | tee -a "$LOG_FILE"
fi

# --- Durable retry on failure (2026-07-02) ---
# The June 2026 cluster: a usage-limit death left the weekly job dead until the
# NEXT weekly timer — the in-script retry loop deliberately excludes usage
# limits ("retrying a usage limit is pointless" — within one run's budget it
# is; across DAYS it isn't). Enqueue a replay into the memory retry queue
# (memory-retry.timer, plain bash + systemd) so the run resumes once usage
# opens back up. The job is SELF-CANCELING: it no-ops if LAST_FAILURE is gone
# (a later run already succeeded), and label-dedup prevents stacking retries.
if [[ $EXIT_CODE -ne 0 ]]; then
    QUEUE_LIB="$HOME/.claude/hooks/memory-queue-lib.sh"
    if [[ -f "$QUEUE_LIB" ]]; then
        # shellcheck disable=SC1090
        source "$QUEUE_LIB"
        if mq_has_job "consolidation"; then
            echo "Retry already queued — not stacking another." | tee -a "$LOG_FILE"
        else
            STAGE=$(mq_new_staging "consolidation")
            cat > "$STAGE/job.sh" <<'JOBEOF'
#!/bin/bash
# Replays a failed weekly consolidation. Self-canceling: a later successful
# run removes LAST_FAILURE, making this a no-op.
set -uo pipefail
[ -f "$HOME/Claude/consolidator/LAST_FAILURE" ] || exit 0
exec bash "$HOME/.claude/scripts/run-consolidation.sh"
JOBEOF
            # 7400s job timeout: the script's own retry budget is 7000s and it
            # must be the one to time out (it writes the failure marker).
            if mq_enqueue "$STAGE" 7400; then
                echo "Retry enqueued for memory-retry.timer (resumes when usage allows)." | tee -a "$LOG_FILE"
                echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | Consolidation | QUEUED: failed run enqueued for retry" >> "$HOME/.claude/hooks/hook-execution.log" || true
            fi
        fi
    fi
fi

# --- Cleanup old logs (keep last 8 weeks) ---
find "$LOG_DIR" -name 'consolidation-*.log' -mtime +56 -delete 2>/dev/null || true

exit $EXIT_CODE
