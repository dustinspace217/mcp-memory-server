#!/bin/bash
# PostCompact hook — outputs context briefing for post-compaction Claude.
#
# Reads hook input JSON from stdin. Extracts session_id and compact_summary.
# If PreCompact wrote a briefing file → outputs it (primary path, near-instant).
# If not → extracts compact_summary from stdin and outputs it with Session Protocol
# instructions, giving the post-compaction Claude at least the compaction output
# plus directions for context reload.
#
# Stdout → userDisplayMessage (seen by post-compaction Claude as context).
# Timeout governed by settings.json (120s). Normally completes in milliseconds.
# Logs to ~/.claude/hooks/hook-execution.log.

set -uo pipefail

LOGFILE="$HOME/.claude/hooks/hook-execution.log"

log() {
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | PostCompact | $1" >> "$LOGFILE"
}

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
COMPACT_SUMMARY=$(echo "$INPUT" | jq -r '.compact_summary // empty')

BRIEFING_FILE="/tmp/claude/compact-briefing-${SESSION_ID}.md"

if [ -f "$BRIEFING_FILE" ]; then
    # Primary path: PreCompact prepared a briefing
    cat "$BRIEFING_FILE"
    rm -f "$BRIEFING_FILE"
    log "OK: delivered PreCompact briefing"
else
    # Fallback: PreCompact didn't run or failed.
    # Include the compact_summary (what the compaction model produced) so the
    # post-compaction Claude has at least that context, then instruct it to
    # reload from memory systems.
    log "WARN: no briefing file — using fallback with compact_summary"
    cat << FALLBACK
Context was compacted. PreCompact briefing was not available.

=== COMPACTION SUMMARY ===
${COMPACT_SUMMARY:-[compact summary not available]}

=== ACTION REQUIRED ===
Reload context by following Session Protocol from CLAUDE.md:
1. Read MEMORY.md and load memory files relevant to the current project
2. Determine the projectId from the working directory
3. Call mcp__memory__get_context_layers(projectId) for L0 rules + L1 status
4. Call mcp__memory__get_summary(projectId, excludeContextLayers=true) for top observations
5. Call mcp__memory__search_nodes(projectId, memoryType='procedure') for procedures
6. Load the global 'working-relationship' entity for relational context
7. Read feedback_anti_sycophancy_system.md — the incident matters more than the rules
8. State what you found: project name, L0 rules, current status, relational state, any warnings
FALLBACK
fi
