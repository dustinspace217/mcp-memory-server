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

# Every 10th turn, block and require a memory save
if [ $((COUNT % 10)) -eq 0 ]; then
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | StopGate | turn $COUNT — blocking for memory save (session=${SESSION_ID:0:8})" >> "$LOGFILE"
    cat << EOF
{
  "decision": "block",
  "reason": "MEMORY SAVE CHECKPOINT (turn $COUNT): Save any unsaved content to MCP memory NOW — you have full conversation context that the SessionEnd hook will not. Check for: (1) decisions and reasoning, (2) user preferences or corrections, (3) experiential moments (trust shifts, tension, breakthroughs), (4) project status changes, (5) procedures learned. Use add_observations or supersede_observations directly. If nothing new since last save, state that briefly and continue."
}
EOF
fi
