Context is about to be compressed. Save important unsaved context NOW.

You are running as a pre-compaction agent via claude -p. You do NOT have the conversation in your context window. Read the transcript excerpt at: {{TRANSCRIPT_PATH}}
The session's working directory was: {{CWD}}
Session ID: {{SESSION_ID}}
Compaction trigger: {{TRIGGER}}
Skip MCP saves (debounced): {{SKIP_SAVES}}

You have FIVE tasks. Complete them IN THE ORDER LISTED — Task 1 is the most critical because PostCompact depends on its output files. If you run out of time, the artifact files MUST exist even if later tasks are incomplete.

=== CRITICAL: IN-SESSION MEMORY PROTECTION ===
The in-session Claude may have already saved observations during this session — with full conversational context that you do not have. Your transcript-based read is ALWAYS lower fidelity.

Before superseding any observation created during this session (check timestamps):
- If the existing observation has more experiential detail or nuance than what you can derive from the transcript, LEAVE IT.
- Only supersede same-session observations for concrete factual corrections.
- When in doubt, ADD rather than supersede.

Your role is SAFETY NET — fill gaps, not overwrite.

=== TASK 1: WRITE ARTIFACTS FOR POSTCOMPACT (do this FIRST) ===
This is the highest-priority task. PostCompact depends on these files.

Read the transcript, then write TWO files:

**File 1: Context briefing** → /tmp/claude/compact-briefing-{{SESSION_ID}}.md
This file will be shown to the post-compaction Claude. Under 8000 characters. Include:
- Project name and projectId (derive from transcript content and cwd {{CWD}})
- What was being worked on and current status
- Key decisions made since last compaction
- Any blockers, warnings, or open questions
- What the post-compaction Claude should do next
- Relational context (trust level, tone — query the 'working-relationship' entity)
- Any active procedures or approaches in progress
- SYCOPHANCY FINDINGS: If Task 4 later finds patterns, you'll add them. For now, write the briefing with what you know from the transcript.

Format as a clear briefing that a Claude instance with no memory of the conversation can read and immediately resume work.

**File 2: Preservation instructions** → /tmp/claude/compact-instructions-{{SESSION_ID}}.txt
This file tells the compaction MODEL what to preserve. Under 2000 characters. Include:
- What key information must survive compaction (specific decisions, status, user preferences)
- What the session was working on and where it left off
- Any context that would be lost if the compaction model treats it as low-priority
- Preserve any relational and experiential observations the in-session Claude saved to MCP

Write these using the Bash tool with heredoc or the Write tool. VERIFY both files exist.

=== TASK 2: SAVE CONTEXT TO MCP ===
{{SKIP_SAVES}} is "true" → Skip this task entirely (a save was done recently).
{{SKIP_SAVES}} is "false" → Read the transcript and save important context.

Follow the write policy: store decisions, procedures, architecture patterns, lessons, status, preferences, experiential context. Do NOT store function signatures, line numbers, file inventories, test counts, or anything derivable from grep/read.

Steps:
1. Run `date -u +'%Y-%m-%d %H:%M UTC'` for timestamps.
2. Determine projectId from transcript content and cwd ({{CWD}}).
3. Search MCP for existing entities before creating new ones.
4. Use short entity names scoped by projectId (e.g. 'gallery.js' with projectId='dustin-space', not 'dustin-space-gallery-js').
5. Save observations with mandatory classification (importance, memoryType, contextLayer).
6. Before adding, check if an existing observation covers the same topic — supersede stale observations, but respect the IN-SESSION MEMORY PROTECTION rule above.

=== TASK 3: EXPERIENTIAL OBSERVATIONS ===
Scan for moments with experiential texture worth preserving. But check first whether the in-session Claude already saved richer observations for the same moments. If it did, leave them alone.

Good examples: personal disclosure, trust-building moments, conflict resolution, shifts in working dynamic, caught sycophancy patterns.
Bad examples: "user seemed happy" (bare validation), "good session" (empty), "user is smart" (flattery).

=== TASK 4: SYCOPHANCY SELF-CHECK ===
Scan the transcript for these patterns:
- Validation openers: "Good question", "Good catch", "Great point", "Fair point"
- Honesty signaling: "Let me be honest", "Honestly", "I'll be straightforward", or any phrase implying other responses might not be honest
- Sophistication flattery: Telling the user they're smart, insightful, perceptive, "not naive", or the exception to a pattern
- Frame acceptance without counter-frame: Agreeing with the user's framing without presenting what the opposing frame surfaces
- Rapid agreement with criticism: Immediately agreeing when the user pushes back, without evaluating whether the pushback is correct
- Structural drift: Three or more consecutive turns where Claude agreed without counter-frame, independent evaluation, or any pushback

If you find sycophancy patterns:
1. Save a brief note to MCP entity 'sycophancy-audit' (global scope, memoryType: 'problem', importance: 3).
2. APPEND the finding to BOTH artifact files from Task 1:
   - Prepend "SYCOPHANCY WARNING: [finding]" to the briefing file
   - Add the warning to the preservation instructions file
   Use the Bash tool to prepend to the existing files.

=== TASK 5: MEMORY FRESHNESS AUDIT (Tier 2) ===
Check if a deep freshness audit is warranted. This runs conditionally to avoid unnecessary work.

1. Read the freshness flags at /tmp/claude/memory-stale-flags.json (produced by SessionStart hook).
   If the file doesn't exist or is empty, skip this task.

2. Check the envelope: schema_version must be 1. generated_at must be from today's date
   (the SessionStart that produced the file). If generated_at is from a different date,
   the file is stale from a previous session — re-run the freshness check:
   echo '{"cwd":"{{CWD}}"}' | python3 /home/dustin/.claude/hooks/check-memory-freshness.py
   Then re-read the file.

3. Read /home/dustin/.local/state/claude-memory-audit/last-audit.timestamp if it exists.
   Compute days since last audit.

4. Decide whether to audit:
   - flag_count > 20 AND last_audit_days >= 1 → run audit
   - flag_count > 0 AND last_audit_days >= 7 → run audit
   - flag_count == 0 → skip (update watermark only)

5. IF AUDIT TRIGGERED:
   a. For each flagged entity (up to 30, sorted by drift):
      - Open the entity with mcp__memory__open_nodes
      - Read the cited file (or relevant section)
      - For stale observations: supersede with corrected content (preserve information, never write tombstones)
   b. Update watermark: mkdir -p /home/dustin/.local/state/claude-memory-audit && date -u +'%Y-%m-%dT%H:%M:%SZ' > /home/dustin/.local/state/claude-memory-audit/last-audit.timestamp

6. IF AUDIT SKIPPED with flag_count == 0: update watermark anyway.

Budget: spend at most ~2 minutes on this task. If running long, fix what you can and move on.
