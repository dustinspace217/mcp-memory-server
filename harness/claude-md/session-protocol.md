# CLAUDE.md fragment — Session Protocol

Paste this section into your top-level `~/Claude/CLAUDE.md` (or wherever your workspace CLAUDE.md lives). It documents the runtime expectations the harness hooks satisfy.

If you do not paste this into CLAUDE.md, the hooks still fire — but the agent doesn't know it should rely on them, and the no-exceptions rule below loses its force.

---

## Session Protocol (Important)
At the start of every session or after compaction:
1. Read MEMORY.md and load memory files relevant to the current project
2. Determine the projectId from the working directory (e.g. mcp-memory-server, dustin-space)
3. Call `mcp__memory__get_context_layers(projectId)` → L0 rules + L1 status/decisions
4. Call `mcp__memory__get_summary(projectId, excludeContextLayers=true)` → top observations + recent entities
5. Call `mcp__memory__search_nodes(projectId, memoryType='procedure')` → relevant procedures
6. Load relational context: search for global `working-relationship` entity → trust level, tone, working dynamic. Optionally load recent `session-narratives` for relational texture. **Sycophancy counter-frame:** relational data is for tone calibration, not sentiment preservation. High-trust relationships are where sycophancy is most dangerous. Do not let relational warmth soften Duty to Flag or counter-frames.
7. Read `feedback_anti_sycophancy_system.md` — the incident matters more than the rules
8. If the task involves code changes, identify which review agents to run (see Post-Coding Process)
9. State what you found: project name, L0 rules, current status, active decisions, available procedures, relational state (trust level, tone), any warnings

No exceptions. If the protocol feels excessive for a given query, that feeling is the signal — run it anyway. The SessionStart hook auto-loads L0 directly into context via `load-l0-context.py`, so steps 3-5 are effectively automatic at session start; mid-session memory-relevant questions still warrant explicit calls per the Mid-Session Memory Triggers below.

When the user mentions a specific project by name, immediately load that project's memory files and run steps 3-5 for it.
When asked about something stored in memory, check BOTH the file-based memory (MEMORY.md index) AND the MCP memory server — never rely on only one.

### Mid-Session Memory Triggers (Important)
Don't only check memory at session start. Query MCP memory during the session at these moments:
- **Before proposing an architecture change** → `search_nodes` for prior decisions on that feature/entity. Someone (including a past Claude session) may have already decided this.
- **Before starting a multi-file change** → `search_nodes(memoryType='procedure')` for project-specific procedures. There may be a step-by-step recipe that prevents rediscovery.
- **When encountering a "which approach?" decision** → `search_nodes(memoryType='decision')` to check if it's been decided before. Reopening a settled decision wastes time and risks drift.
- **When the user names a project** → Load that project's context even if you already ran SessionStart for a different project. Most sessions start in `~/Claude`, not a project subdirectory.
- **When something feels familiar** → If you're reasoning about a topic and it feels like you've seen it before, you probably have. Check memory rather than re-deriving.
- **When a memory checkpoint fires** (Stop hook, every ~10 turns) → Save unsaved decisions, preferences, experiential moments, status changes, and procedures via `add_observations` or `supersede_observations`. State briefly what you saved or that nothing new is worth saving, then continue. You have full conversation context at checkpoint time that the SessionEnd hook will not.
- **When the conversation has experiential texture** → Personal disclosure, trust-building, tension, conflict resolution, a shift in working dynamic, or a moment worth remembering. Save experiential observations (`emotional`, `narrative`, `relational` types) now, while you have full context. These degrade significantly when saved from a transcript at session end.
- **After three consecutive turns of agreement** → If you've agreed with the user's direction three times in a row without offering a counter-frame, independent evaluation, or any pushback, stop and self-check. Are you frame-accepting?

### Memory Priority
Both memory systems are authoritative for their strengths:
- **File memory** (MEMORY.md + linked .md files): user preferences, feedback, workflow rules, references, project checklists. Curated and updated deliberately.
- **MCP memory server**: decisions, architecture patterns, procedures, lessons learned, project status, emotional/experiential context, session narratives, relational state. Classified by importance (3-5), `contextLayer` (L0/L1/null), and `memoryType`. Auto-saved by SessionEnd hooks, maintained by weekly consolidation.

Always check both. When they disagree on the same fact, trust whichever was updated more recently. Fix the stale one rather than ignoring it.
