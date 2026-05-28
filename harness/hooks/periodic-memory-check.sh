#!/bin/bash
# UserPromptSubmit hook — every 10 user messages, reminds the in-session Claude
# to check for unsaved content worth remembering.
#
# Uses a per-session counter file. Outputs additionalContext JSON every 10th turn.
# The reminder is injected as a system-reminder, which the in-session Claude sees
# in its conversation context — harder to ignore than a CLAUDE.md instruction.
#
# Logs milestones to hook-execution.log for observability.

set -uo pipefail

LOGFILE="$HOME/.claude/hooks/hook-execution.log"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

# Increment turn counter
COUNTER_FILE="/tmp/claude/turn-counter-${SESSION_ID}.txt"
mkdir -p /tmp/claude

if [ -f "$COUNTER_FILE" ]; then
    COUNT=$(cat "$COUNTER_FILE")
else
    COUNT=0
fi

COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Every 10th turn, output a memory check reminder
if [ $((COUNT % 10)) -eq 0 ]; then
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | MemoryCheck | turn $COUNT milestone (session=${SESSION_ID:0:8})" >> "$LOGFILE"
    # Output JSON with additionalContext — injected into the conversation as system-reminder
    cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "PERIODIC MEMORY CHECK (turn $COUNT): Scan the conversation since your last memory save for: (1) decisions made and their reasoning, (2) user preferences or corrections expressed, (3) experiential/emotional moments worth preserving (personal disclosure, trust shifts, tension, breakthroughs), (4) project status changes, (5) procedures learned. Save anything valuable to MCP now while you have full context — these degrade when saved from a transcript later. If nothing is worth saving, proceed normally."
  }
}
EOF
fi
