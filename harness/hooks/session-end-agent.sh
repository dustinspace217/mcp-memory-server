#!/bin/bash
# SessionEnd hook — spawns claude -p to save session context to MCP memory.
#
# Reads hook input JSON from stdin. Extracts transcript_path, cwd, session_id.
# NO DEBOUNCE — SessionEnd fires exactly once per session. Every session deserves
# a final save pass regardless of when PreCompact last ran.
# Extracts the last 300 lines of the transcript to avoid overwhelming context.
# Spawns claude -p with the sessionend prompt template, injecting paths.
# Logs success/failure to ~/.claude/hooks/hook-execution.log.
#
# Stdout goes to stderr for SessionEnd (no injection path back to session).
# Timeout governed by settings.json (180s).

set -uo pipefail
# Note: not using -e because we want to handle errors explicitly

LOGFILE="$HOME/.claude/hooks/hook-execution.log"
mkdir -p /tmp/claude

log() {
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | SessionEnd | $1" >> "$LOGFILE"
}

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Nothing to analyze without a transcript
if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log "SKIP: no transcript at ${TRANSCRIPT_PATH:-<empty>}"
    exit 0
fi

# Check transcript has enough content to be worth analyzing
LINES=$(wc -l < "$TRANSCRIPT_PATH")
if [ "$LINES" -lt 10 ]; then
    log "SKIP: transcript too short ($LINES lines)"
    exit 0
fi

# Extract last 300 lines of transcript to a temp file
# Recent context is most valuable; full transcript may exceed claude -p's context window
EXCERPT="/tmp/claude/transcript-excerpt-${SESSION_ID}.jsonl"
tail -300 "$TRANSCRIPT_PATH" > "$EXCERPT"

# Load the prompt template and inject paths
PROMPT_TEMPLATE="$HOME/.claude/hooks/sessionend-prompt.md"
if [ ! -f "$PROMPT_TEMPLATE" ]; then
    log "FAIL: prompt template not found at $PROMPT_TEMPLATE"
    exit 0
fi

# sed uses | as delimiter since paths contain /
PROMPT=$(sed \
    -e "s|{{TRANSCRIPT_PATH}}|$EXCERPT|g" \
    -e "s|{{CWD}}|${CWD:-$HOME/Claude}|g" \
    -e "s|{{SESSION_ID}}|${SESSION_ID}|g" \
    "$PROMPT_TEMPLATE")

# Spawn claude -p in the session's working directory
# --permission-mode bypassPermissions: no interactive prompts (background hook)
# --model sonnet: balance of capability and speed for memory saves
# --no-session-persistence: don't clutter session history with hook subprocess
cd "${CWD:-$HOME/Claude}" 2>/dev/null || cd "$HOME/Claude"

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude -p \
    --permission-mode bypassPermissions \
    --model sonnet \
    --no-session-persistence \
    --output-format text \
    2>/tmp/claude/sessionend-stderr-${SESSION_ID}.txt) && \
    log "OK: save completed (session=$SESSION_ID, ${#CLAUDE_OUTPUT} chars output)" || \
    log "FAIL: claude -p exited with error (session=$SESSION_ID, stderr=$(head -1 /tmp/claude/sessionend-stderr-${SESSION_ID}.txt 2>/dev/null))"

# Clean up
rm -f "$EXCERPT" "/tmp/claude/sessionend-stderr-${SESSION_ID}.txt"
