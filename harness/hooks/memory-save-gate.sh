#!/bin/bash
# Stop hook — every 10 unique assistant turns, BLOCKS Claude from stopping
# and requires it to do a memory save with full conversation context before continuing.
#
# This runs INSIDE the REPL (Stop events use vD), so type:"command" works and
# the decision output is respected by the harness.
#
# When blocked, Claude gets another turn and sees the reason text. It must
# do the memory save (with full context — NOT from a transcript) and then
# continue with its response. The user will see Claude say something like
# "Let me save some observations to memory" before their response.
#
# On non-milestone turns: exits silently (no output, no block, ~1ms overhead).
#
# Logs milestones to ~/.claude/hooks/hook-execution.log.

set -uo pipefail

LOGFILE="$HOME/.claude/hooks/hook-execution.log"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

# Increment turn counter
# Uses a separate counter from UserPromptSubmit since Stop fires on assistant turns
COUNTER_FILE="/tmp/claude/stop-counter-${SESSION_ID}.txt"
mkdir -p /tmp/claude

if [ -f "$COUNTER_FILE" ]; then
    COUNT=$(cat "$COUNTER_FILE")
else
    COUNT=0
fi

COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Chase the memory-write cadence with the anti-sycophancy auditor (Phase 7.4).
# Launch it DETACHED on every stop. The runner self-gates (audits only when the self-record —
# the continuity thread + introspective obs — changed since its last audit), so it's cheap on
# unchanged turns and audits a new write the stop AFTER it lands (the "N+1" chase). It holds a
# single-flight lock (no duplicate claude -p), never blocks here (background), and self-skips if
# claude/deps are missing. Output is fully redirected so it never touches the hook's stdout
# decision channel below. CWD lets it scope to the active project's thread.
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
nohup python3 "$HOME/.claude/audit/run-memory-audit.py" --cwd "$CWD" >/dev/null 2>&1 &
disown 2>/dev/null || true

# Every 10th turn, block and require a memory save
if [ $((COUNT % 10)) -eq 0 ]; then
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | StopGate | turn $COUNT — blocking for memory save (session=${SESSION_ID:0:8})" >> "$LOGFILE"
    cat << EOF
{
  "decision": "block",
  "reason": "MEMORY SAVE CHECKPOINT (turn $COUNT): Save any unsaved content to MCP memory NOW — you have full conversation context the SessionEnd hook will not. Check for: (1) decisions and reasoning; (2) user preferences or corrections; (3) experiential moments (trust shifts, tension, breakthroughs) AND a first-person 'introspective' stance on the global 'claude-self' entity — what you concluded, where you were wrong, what you're uncertain about; verbatim-anchored, never self-flattering (introspective obs get audited hardest); (4) project status — and update the per-project '<project>-continuity-thread' entity (supersede-in-place) if work-state changed; (5) procedures learned; (6) CAUSALITY — graph the 'why': create CAUSED_BY / PRECEDENT_FOR / SUPERSEDES relations between entities; and when a SIGNIFICANT incident produced a durable rule/decision/fix this session, make the incident a first-class entity (entityType='incident', lightweight — 1-3 line summary + source pointer) and edge the consequence CAUSED_BY it. Conservative — only edge causality you can state explicitly. Use add_observations / supersede_observations / create_relations directly. If nothing new since last save, state that briefly and continue."
}
EOF
fi
