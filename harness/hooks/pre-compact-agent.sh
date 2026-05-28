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
# Timeout governed by settings.json (300s).
# Logs success/failure to ~/.claude/hooks/hook-execution.log.

set -uo pipefail

LOGFILE="$HOME/.claude/hooks/hook-execution.log"
mkdir -p /tmp/claude

log() {
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | PreCompact | $1" >> "$LOGFILE"
}

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
cd "${CWD:-$HOME/Claude}" 2>/dev/null || cd "$HOME/Claude"

CLAUDE_LOG="/tmp/claude/precompact-claude-output-${SESSION_ID}.txt"
echo "$PROMPT" | claude -p \
    --permission-mode bypassPermissions \
    --model sonnet \
    --no-session-persistence \
    --output-format text \
    > "$CLAUDE_LOG" 2>/tmp/claude/precompact-stderr-${SESSION_ID}.txt && \
    log "OK: claude -p completed (trigger=$TRIGGER, skip_saves=$SKIP_SAVES, excerpt=$EXCERPT_LINES lines)" || \
    log "FAIL: claude -p error (stderr=$(head -1 /tmp/claude/precompact-stderr-${SESSION_ID}.txt 2>/dev/null))"

# Update debounce timestamp (only if we did saves)
if [ "$SKIP_SAVES" = "false" ]; then
    date +%s > "$DEBOUNCE_FILE"
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

# Clean up
rm -f "$EXCERPT" "$CLAUDE_LOG" "/tmp/claude/precompact-stderr-${SESSION_ID}.txt"
