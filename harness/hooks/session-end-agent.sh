#!/bin/bash
# SessionEnd hook — launches a DETACHED memory save that outlives teardown.
#
# Reads hook input JSON from stdin (transcript_path, cwd, session_id). Does only
# fast, bounded work — recursion guard + transcript guards — then launches
# sessionend-save.sh via `setsid nohup ... &` so the actual claude -p save runs
# in its own session and completes AFTER this hook returns and the session tears
# down.
#
# WHY DETACHED (2026-06-10): SessionEnd hooks "cannot block termination" (Claude
# Code docs). The harness SIGTERMs this hook during teardown EARLIER than its
# 180s settings.json budget, so an in-line 20-90s claude -p save lost the race
# and the session's tail — every turn since the last mid-session checkpoint,
# which is unique data this save exists to capture — was lost. Raising the
# timeout cannot help (teardown ignores it). Detaching the save removes it from
# the dying session's process group entirely; setsid was empirically verified to
# survive a process-group SIGTERM. The save logs its own outcome (SessionEndSave
# source), so a real failure still surfaces via the health-check.
#
# Logs to ~/.claude/hooks/hook-execution.log.

set -uo pipefail

LOGFILE="$HOME/.claude/hooks/hook-execution.log"
mkdir -p /tmp/claude

log() {
    # session= appended centrally so EVERY line (incl. SKIP/WARN) is correlatable.
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | SessionEnd | $1 (session=${SESSION_ID:-unset})" >> "$LOGFILE"
}

# Recursion guard: the detached save runs claude -p with CLAUDE_LIFECYCLE_AGENT=1,
# and that child fires its own SessionEnd hook on exit. Seeing the env var here
# means we ARE that child's hook — skip so we don't recurse.
if [ -n "${CLAUDE_LIFECYCLE_AGENT:-}" ]; then
    log "SKIP: recursion guard (lifecycle agent child)"
    exit 0
fi

# This hook now does only sub-second setup (parse + guards) before launching the
# detached save. A SIGTERM during that window means the save never launched —
# rare, but a real miss of this session's tail, so WARN (visible) rather than a
# hard FAIL. Once the save is launched we exit 0 immediately and this is moot.
trap 'log "WARN: torn down during setup, before the detached save could launch"; exit 143' TERM

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Nothing to analyze without a transcript
if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log "SKIP: no transcript at ${TRANSCRIPT_PATH:-<empty>}"
    exit 0
fi

# Enough content to be worth saving? (wc -l reads the file but is sub-second
# even on a multi-MB transcript.)
LINES=$(wc -l < "$TRANSCRIPT_PATH")
if [ "$LINES" -lt 10 ]; then
    log "SKIP: transcript too short ($LINES lines)"
    exit 0
fi

# Launch the detached save. setsid → new session (survives the teardown
# process-group SIGTERM); nohup → ignore SIGHUP; </dev/null + redirects → fully
# detached I/O; & + disown → return immediately. The helper builds the prompt,
# runs the save, logs its own outcome, and cleans up.
SAVE_HELPER="$HOME/.claude/hooks/sessionend-save.sh"
if [ ! -f "$SAVE_HELPER" ]; then
    log "FAIL: detached save helper not found at $SAVE_HELPER"
    exit 0
fi
setsid nohup bash "$SAVE_HELPER" "$SESSION_ID" "$TRANSCRIPT_PATH" "${CWD:-$HOME/Claude}" \
    </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

log "OK: detached save launched (runs to completion independent of teardown)"
exit 0
