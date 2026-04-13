# Memory Usability Overhaul — From Storage Infrastructure to Knowledge System

> **For agentic workers:** This plan contains 6 phases. Phases 1, 1b, 2 are behavioral/hook changes (no server code). Phase 3 is server code. Phase 4 is a weekly local systemd timer + `claude -p` consolidation agent. Phase 5 is hook updates that depend on clean data from Phases 1-4. Phase 6 is conditional. Execute in order unless parallelism is noted.

**Problem:** The MCP memory server has excellent storage infrastructure (temporal columns, context layers, importance scores, memory types, eviction, normalization) but the infrastructure is inert. Every observation has `importance: 3`, `contextLayer: null`, `memoryType: "fact"`. The SessionEnd hook explicitly instructs Claude to save API signatures, table schemas, function parameters, and test counts — detail that Claude re-derives faster from grep than from memory lookup + staleness verification. The signal-to-noise ratio makes recall slow and unreliable.

**Root cause:** The SessionEnd hook (in `~/.claude/settings.json`, lines 396-403) contains the instruction "FUNCTIONS & SIGNATURES: Exact name, file, parameters (names and types), return value, purpose. These are cheaper to query than re-reading source files." This is false — both paths are 2 tool calls, but grep returns current data while memory may be stale. The hook actively produces the noise that makes memory untrustworthy.

**Evidence (queried 2026-04-12):**
- `mcp-memory-server-mcp-tools`: 16 observations, all API signatures. Every one discoverable from the tool's Zod schema.
- `mcp-memory-server-database-schema`: 13 observations listing table definitions. All derivable from `PRAGMA table_info`.
- `mcp-memory-server-tests`: 12 observations with test file descriptions. Derivable from `ls __tests__`.
- Three stale facts found: "13 MCP tools" (actual: 16), "368 tests" (actual: 520), "schema version 6" (actual: 9).
- Classification fields uniformly unused: every observation has `importance: 3`, `contextLayer: null`, `memoryType: "fact"`.

**Three durable goals (from `project_mcp_memory_server_goals.md`):**
- **A.** Reduce drift and hallucination risk
- **B.** Faithful recall of who/what/when/where/why/how
- **C.** Enhance meaningful conversations and quality code

**Five usability pillars (from `project_memory_usability_redesign.md`):**
1. Hierarchical abstraction with query zoom levels
2. Retrieval-driven strengthening
3. Confidence decay with verification refresh
4. Procedure library
5. Session-start briefing, not data dump

**Design principles:**
- **P1: Don't store what grep can find.** API signatures, table schemas, function parameters, line numbers, test counts, file inventories — derivable in <2 tool calls. Store what CAN'T be derived: decisions, procedures, patterns, lessons.
- **P2: Classification is mandatory, not optional.** Every stored observation MUST have a specific importance (not default 3), a memory_type, and context_layer if it merits L0/L1.
- **P3: The server is smart enough; make the callers smarter.** Most of this plan is behavioral (hooks/prompts), not architectural (server code).
- **P4: Maintain, don't accumulate.** Periodic consolidation is as important as the initial write.

**Local LLM evaluation (concluded: not used):**
Evaluated a local 2-4B ONNX model for write-time classification or per-session consolidation. Rejected because: (1) consolidation requires judgment that small models can't provide — "is this stale?", "should these merge?" need codebase context; (2) the ONNX embedding model already caused a hard-reboot incident (see `feedback_local_llm_test_pool_discipline.md`), adding a text-generation model is strictly higher risk; (3) a weekly CCR agent provides Claude-quality consolidation at ~$0.10/run (~$0.40/month); (4) the complexity cost (new dependency, model download, inference pipeline, error handling, test surface) is disproportionate to the benefit. The local LLM's zero-marginal-cost advantage doesn't outweigh the quality gap and reliability risk.

---

## Phase Summary

| Phase | Theme | Type | Dependencies | Serves Goals | Serves Pillars | Status |
|-------|-------|------|-------------|-------------|---------------|--------|
| **1** | Write Policy | Hook/prompt rewrite | None | A, B, C | 1, 5 | DONE |
| **1b** | Post-Write Guardrail | Server-side heuristic | None (parallel with 1) | A | 1 | DONE |
| **2** | Corpus Cleanup | Audit skill + execution | Phase 1 (needs policy to classify toward) | A, B, C | 1, 2, 4 | DONE (supersession pass; classification deferred to server restart) |
| **3** | Server Enhancements | Code (2 features) | None (parallel with 1-2) | A, B | 4 | DONE |
| **4** | Consolidation Agent | Local systemd timer + `claude -p` | Phase 1 (follows policy) + Phase 3a (memoryType filter) | A, B, C | 2, 3 | DONE |
| **5** | SessionStart Enhancement | Hook rewrite | Phases 1-4 (needs clean classified data) | B, C | 5 | DONE |
| **6** | Confidence Decay | Server code (conditional) | Phase 5 (evaluate need after) | A, B | 3 | TODO |

**Parallelism:** Phases 1 and 3 can run in parallel (behavioral vs code). Phase 1b can run in parallel with Phase 1. Phase 2 starts after Phase 1 establishes the policy.

---

## Phase 1: Write Policy Revolution

**Goal:** Stop the noise at the source. Rewrite SessionEnd and PreCompact hooks to follow a strict write policy.

**Files to modify:**
- `~/.claude/settings.json` — SessionEnd hook prompt (lines 396-403), PreCompact hook prompt (lines 407-413)
- Create: `~/.claude/projects/-home-dustin-Claude/memory/reference_memory_write_policy.md` — the authoritative write policy (referenced by hooks and by Claude mid-session)

### Task 1a: Create the Write Policy Reference File

Write `reference_memory_write_policy.md` with this exact content structure. This file is the single source of truth — hooks reference it, mid-session Claude follows it.

**STORE (expensive to re-derive):**

| Category | memory_type | importance | context_layer | Example |
|---|---|---|---|---|
| Decisions and their reasoning | `decision` | 4-5 | L1 if recent | "Chose partial unique index over composite UNIQUE for entity soft-delete — avoids same-millisecond collision" |
| Procedures (how to do X in this project) | `procedure` | 4 | L1 | "To add a schema migration: increment version in init(), add `if (currentVersion < N)` block, add tests in migration-validation.test.ts, update CLAUDE.md" |
| Architecture patterns (cross-file relationships) | `architecture` | 4 | null | "Relations store normalized_name endpoints, not entity IDs. deleteEntities() supersedes related relations so eviction can distinguish old vs re-created entity relations." |
| Lessons learned / problems encountered | `problem` | 4 | L1 if still active | "WAL mode means DELETEs don't shrink DB until checkpoint. Eviction must not check file size per-batch." |
| User preferences and corrections | `preference` | 4-5 | L0 if critical | "Always use tabs. Comment every function. Never run sudo." |
| Project status and what's next | `status` | 4 | L1 | "[2026-04-12] v1.1.0 shipped. Post-release review issues #70-#76 fixed. Open: #59 (zero-width Unicode)" |
| Emotional / interpersonal context | `emotional` | 3 | null | "User was frustrated when migration broke twice — extra care with schema changes" |

**DO NOT STORE (cheap to re-derive — 2 tool calls or fewer):**
- Function signatures, parameter lists, return types → `Grep` the file
- Line numbers → they move constantly, always stale
- File inventories ("7 source files: types.ts, cursor.ts, ...") → `ls`
- Test counts ("520 tests across 9 files") → run tests or read CLAUDE.md
- API/tool schemas (input/output types) → the MCP server exposes Zod schemas; read index.ts
- Table definitions (columns, types, constraints) → `PRAGMA table_info` or read sqlite-store.ts
- Import lists / dependency versions → read package.json
- Environment variable descriptions → read the code or CLAUDE.md
- Anything already documented in the project's CLAUDE.md → it's loaded every session automatically
- Index definitions → read the migration code
- Enum values or constant lists → grep the source

**CLASSIFICATION IS MANDATORY:**
- Every observation MUST have a specific `importance` (not default 3 — think about it)
- Every observation MUST have a `memory_type` from the STORE table above
- Observations that merit L0/L1 MUST have `context_layer` set explicitly
- If you cannot assign a meaningful classification, the observation is probably noise — don't store it
- If you would assign importance 1-2, strongly reconsider whether it's worth storing at all

**CONSOLIDATION AT WRITE TIME:**
- Prefer fewer, richer observations over many granular ones
- "The entity has 16 tools" is one observation, not 16 separate signature observations
- Before adding, check if an existing observation covers the same topic — supersede, don't append
- Prefix time-sensitive observations with `[YYYY-MM-DD HH:MM UTC]` so staleness is visible

**THE LITMUS TEST:**
Before storing any observation, ask: "Would a future Claude session benefit more from reading this observation, or from running `grep` / `read` on the actual file?" If grep wins, don't store it.

### Task 1b: Rewrite the SessionEnd Hook Prompt

Replace the SessionEnd agent prompt in `~/.claude/settings.json` (the `"prompt"` value inside the SessionEnd hook, currently lines 401-402). The new prompt must:

1. **Reference the write policy**: "Follow the memory write policy in `~/.claude/projects/-home-dustin-Claude/memory/reference_memory_write_policy.md`. Read it if you haven't this session."
2. **Remove these bullet points entirely** (they are the primary noise source):
   - "FUNCTIONS & SIGNATURES: Exact name, file, parameters (names and types), return value, purpose. These are cheaper to query than re-reading source files."
   - "VARIABLES & CONSTANTS: Key names, what they hold, where defined."
   - "LIBRARIES & DEPENDENCIES: Package names, versions, what they're used for."
   - "APIs, ENDPOINTS, SCHEMAS: Routes, methods, table structures, config keys."
3. **Replace the "What to Save" section** with the STORE categories from the write policy
4. **Add the DO NOT STORE list** verbatim from the write policy
5. **Add the litmus test** verbatim
6. **Keep these sections unchanged**: Step 1 (project scope), Step 2 (query existing), Step 3 (entity naming), Step 5 (supersede vs append), Step 7 (timestamps), and the orphaned command check
7. **Strengthen Step 6** (importance/context layers): change from a passive scale to the mandatory classification rule from the write policy. Remove importance 1-2 from the scale — if it would be importance 1-2, don't store it.

The new prompt must be a complete, self-contained replacement. Do not use "see write policy for details" for the core rules — the agent running this hook has limited time and shouldn't need to read another file for the basic rules. The write policy file is the authoritative reference; the hook prompt is the operational summary.

### Task 1c: Update the PreCompact Hook's CONTEXT SAVE Section

The PreCompact hook prompt in `~/.claude/settings.json` (lines 408-412) has a "=== CONTEXT SAVE ===" section. Update it to follow the same write policy:

1. Add a preamble to the CONTEXT SAVE section: "Follow the memory write policy — store decisions, procedures, architecture, lessons, status, preferences. Do NOT store function signatures, line numbers, file inventories, test counts, API schemas, or anything derivable from grep/read in <2 tool calls."
2. Remove or reword bullet point 4 ("Save: project status, files modified, function signatures, decisions...") — keep "project status" and "decisions", remove "function signatures".
3. Add the classification mandate: "Set importance, memory_type, and context_layer on every observation. If you can't classify it, don't store it."
4. Keep the rest of the PreCompact prompt unchanged (sycophancy check, freshness audit, orphaned commands).

### Task 1d: Update MEMORY.md Index

Add an entry for the write policy reference file in `~/.claude/projects/-home-dustin-Claude/memory/MEMORY.md`.

### Verification for Phase 1

After all tasks complete:
- [ ] `reference_memory_write_policy.md` exists and is indexed in MEMORY.md
- [ ] SessionEnd hook prompt no longer mentions function signatures, variable names, library lists, API schemas, or table definitions
- [ ] SessionEnd hook prompt includes the DO NOT STORE list and litmus test
- [ ] SessionEnd hook prompt requires mandatory classification (importance, memory_type, context_layer)
- [ ] PreCompact CONTEXT SAVE section follows the same policy
- [ ] `jq '.hooks.SessionEnd[0].hooks[0].prompt' ~/.claude/settings.json` outputs a valid string (JSON syntax check)
- [ ] `jq '.hooks.PreCompact[0].hooks[0].prompt' ~/.claude/settings.json` outputs a valid string

---

## Phase 1b: Post-Write Noise Guardrail

**Goal:** Defense-in-depth against noise that gets past the write policy. The SessionEnd agent is an LLM following a prompt — it may still write noise despite instructions (recency bias, helpfulness pressure, time constraints). This phase adds a lightweight server-side heuristic that catches the most obvious noise patterns.

**Why this exists (from Duty to Flag analysis):** Phase 1 is a behavioral change enforced by a prompt. Phase 4 (consolidation agent) catches what gets through, but runs weekly — noise sits in the corpus for up to 7 days. This guardrail catches obvious noise immediately after write, closing the gap.

**Implementation:** A PostToolUse hook on `mcp__memory__add_observations` that inspects the tool input and logs a warning (as `additionalContext` injected back into the model) when observations match noise patterns. It does NOT block the write — it warns Claude so Claude can supersede or reconsider.

**Files to modify:**
- `~/.claude/settings.json` — add a PostToolUse hook entry

### Task 1b-1: Create the noise-detection hook script

Create `~/.claude/hooks/check-memory-noise.py` — a Python script that reads the tool input from stdin (JSON with `tool_name` and `tool_input` fields) and checks each observation's content against noise patterns.

**Noise patterns to detect (regex-based):**
1. **Line number references**: content matches `\bat line \d+` or `\bline ~?\d+` or `\(line \d+\)` or `\blines? \d+-\d+`
2. **Function signatures with parameters**: content matches `\w+\([^)]*:\s*(string|number|boolean|any|void|Promise|Array)` (TypeScript-style signature)
3. **Import/require statements**: content matches `^(import |require\(|from ['"])`
4. **Test count snapshots**: content matches `\b\d+\s+tests?\b` (e.g., "520 tests", "4 tests")
5. **File inventory lists**: content matches `^\d+ (source |test )?files?:` or content is a comma-separated list of filenames ending in `.ts`, `.js`, `.py`, etc.
6. **Table/column definitions**: content matches `^Table \w+:` or `\bCOLUMN\b.*\b(TEXT|INTEGER|REAL|BLOB)\b` (SQL DDL in observation)
7. **Package version snapshots**: content matches `@\d+\.\d+\.\d+` or `version \d+\.\d+\.\d+` when not part of a decision/milestone

**Output format:** JSON with `hookSpecificOutput` containing `additionalContext`:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "MEMORY NOISE WARNING: 3 of 5 observations match noise patterns (line numbers, function signatures, test counts). The write policy says these are derivable from grep/read and should not be stored. Consider superseding them. Flagged observations: [list with pattern matched]."
  }
}
```

If no observations match noise patterns, output nothing (empty stdout = no hook effect).

**Characteristics:**
- Runs in <100ms (pure regex, no I/O beyond stdin)
- Never blocks writes (no `"continue": false`)
- Only fires on `mcp__memory__add_observations`, not on supersede or other tools
- The warning is injected as context so Claude sees it and can act, but the observation is already written
- False positives are acceptable — the warning says "consider superseding", not "this was wrong"

### Task 1b-2: Wire the hook into settings.json

Add to the `PostToolUse` array in `~/.claude/settings.json`:

```json
{
  "matcher": "mcp__memory__add_observations",
  "hooks": [
    {
      "type": "command",
      "command": "python3 ~/.claude/hooks/check-memory-noise.py",
      "timeout": 5
    }
  ]
}
```

### Task 1b-3: Test the hook

Pipe a synthetic payload and verify:
```bash
echo '{"tool_name":"mcp__memory__add_observations","tool_input":{"observations":[{"entityName":"test","contents":["createEntities at line 1064 in sqlite-store.ts"]}]},"tool_response":{"results":[{"entityName":"test","addedObservations":["createEntities at line 1064 in sqlite-store.ts"]}]}}' | python3 ~/.claude/hooks/check-memory-noise.py
```

Expected: JSON output with additionalContext warning about line number pattern.

```bash
echo '{"tool_name":"mcp__memory__add_observations","tool_input":{"observations":[{"entityName":"test","contents":["Chose SQLite over Postgres because no external dependencies needed"]}]},"tool_response":{"results":[{"entityName":"test","addedObservations":["Chose SQLite over Postgres because no external dependencies needed"]}]}}' | python3 ~/.claude/hooks/check-memory-noise.py
```

Expected: empty stdout (no noise detected).

### Verification for Phase 1b

- [ ] `check-memory-noise.py` exists, runs in <100ms
- [ ] Correctly flags line numbers, function signatures, test counts, file inventories, table definitions
- [ ] Does NOT flag decisions, procedures, architecture patterns, status updates
- [ ] Hook wired in settings.json under PostToolUse with correct matcher
- [ ] `jq '.hooks.PostToolUse' ~/.claude/settings.json` shows both the existing playwright hook and the new memory hook
- [ ] Never outputs `"continue": false` (never blocks writes)

---

## Phase 2: Corpus Cleanup

**Goal:** Transform the existing ~1500+ observations from unclassified noise to classified signal. This is a one-time audit that establishes the baseline Phase 1's write policy will maintain.

**Approach:** Enhance the existing `audit-memory` skill (at `~/.claude/skills/audit-memory/`) to include classification, then run it across all projects.

### Task 2a: Enhance the audit-memory skill

Modify the audit-memory skill instructions to add a classification pass. Currently the skill only verifies freshness (reads cited files, compares observations, supersedes stale ones). The enhanced version does three things per entity:

1. **Triage**: Is this observation noise (derivable from grep/read) or signal (decision, procedure, architecture, lesson)?
   - Apply the DO NOT STORE list from the write policy
   - Observations that are purely noise should be superseded with a brief architectural summary if one is warranted, or simply left at importance 1 to be naturally deprioritized (don't delete — data preservation rule)
2. **Classify**: For signal observations, use `set_observation_metadata` to set:
   - `importance`: 4-5 for decisions/procedures/blockers, 3 for stable architectural facts, 2 for supporting detail
   - `contextLayer`: L0 for critical rules/constraints, L1 for current status/recent decisions/active procedures, null for everything else
   - `memoryType`: decision/procedure/architecture/problem/preference/status/emotional/fact
3. **Consolidate**: Multiple observations about the same evolving fact (e.g., "test count is 310" and "test count is 343" and "test count is 520") get superseded into ONE observation with the current value, or dropped entirely if derivable

**Specific cleanup targets for mcp-memory-server project (from evidence gathered 2026-04-12):**

| Entity | Current obs count | Action |
|--------|------------------|--------|
| `mcp-memory-server-mcp-tools` | 16 (all API signatures) | Supersede all 16 with ONE architecture observation: "16 MCP tools registered in index.ts. Schemas are self-describing via Zod — read index.ts for current signatures." Set importance: 2, memoryType: architecture |
| `mcp-memory-server-database-schema` | 13 (all table DDL) | Supersede all with 2-3 architecture observations covering design patterns (not DDL): normalized_name as identity key, superseded_at sentinel pattern, partial unique indexes. Set importance: 4, memoryType: architecture |
| `mcp-memory-server-tests` | 12 (test file inventories) | Supersede all with ONE procedure observation: how to run the two-pool test commands. Set importance: 4, memoryType: procedure |
| `mcp-memory-server-env-vars` | 5 (env var descriptions) | Supersede all — these are in CLAUDE.md and the code. Replace with one note if any env var has non-obvious behavior. |
| `mcp-memory-server-known-limitations` | 11 | Keep but reclassify: importance 3-4, memoryType: architecture. These are genuinely useful. |
| All other entities | varies | Apply the triage/classify/consolidate process |

**All projects must be audited**, not just mcp-memory-server. Run the skill with each project scope.

### Task 2b: Run the audit

Execute the enhanced audit-memory skill for each project that has entities in the MCP memory. The skill should:

1. List all projects via `mcp__memory__list_projects`
2. For each project, paginate through all entities via `search_nodes`
3. Apply the triage/classify/consolidate process to each entity
4. Report: entities checked, observations superseded, observations reclassified, entities verified clean

### Verification for Phase 2

- [ ] Every observation in the mcp-memory-server project has a non-default classification (importance != 3 unless intentionally chosen, memoryType set to a specific category, contextLayer set where warranted)
- [ ] No API signature observations remain (superseded or consolidated)
- [ ] No table DDL observations remain
- [ ] No stale count observations remain ("test count is 368", "schema version 6", "13 MCP tools")
- [ ] Procedure observations exist for: running tests, adding schema migrations, shipping against a plan
- [ ] L0 observations exist for critical rules (if any apply to this project)
- [ ] L1 observations exist for current project status and recent decisions
- [ ] All other projects in the memory server have been similarly audited

---

## Phase 3: Server Enhancements

**Goal:** Two targeted server changes that make the classified data queryable in ways that matter.

**Files to modify:**
- `sqlite-store.ts` — add memoryType filter to `searchNodes()` and `getSummary()`, add `checkDuplicates()` method
- `jsonl-store.ts` — add memoryType filter to `searchNodes()` and `getSummary()`, stub `checkDuplicates()`
- `types.ts` — add `checkDuplicates` to `GraphStore` interface, add `CheckDuplicateInput` and `CheckDuplicateResult` types
- `index.ts` — add memoryType parameter to search_nodes and get_summary tools, register check_duplicates tool
- `__tests__/knowledge-graph.test.ts` — tests for memoryType filter
- `__tests__/mcp-tools.test.ts` — tests for check_duplicates tool and memoryType parameter

### Task 3a: memoryType filter on search_nodes

**Why:** This is the missing link that makes the procedure library (Pillar 4) functional. Without it, `memory_type: 'procedure'` is metadata nobody can query. Enables: `search_nodes(query='migration', memoryType='procedure')` → "how to add a schema migration".

**types.ts changes:**
- Add `memoryType?: string` to the search parameters (either as a new field on `PaginationParams` or as a separate parameter). Prefer a separate parameter — `PaginationParams` is about pagination, not filtering.
- Update `GraphStore.searchNodes` signature to accept the optional `memoryType` parameter.

**sqlite-store.ts changes — `searchNodes()` method:**
- When `memoryType` is provided, add to the LIKE query's WHERE clause:
  ```sql
  AND e.id IN (
    SELECT entity_id FROM observations
    WHERE superseded_at = '' AND memory_type = ?
  )
  ```
  This filters entities to those having at least one active observation of the requested type.
- The vector search augmentation path should also respect the filter — only include vector matches whose entities have matching observations.
- The cursor fingerprint must incorporate memoryType (add it to `searchNodesFingerprint()` in `cursor.ts`) so mixed-filter pagination is rejected.

**jsonl-store.ts changes — `searchNodes()` method:**
- Apply the same filter in-memory: after collecting matching entities, filter to those with at least one observation where `memoryType` matches.

**index.ts changes — `search_nodes` tool:**
- Add `memoryType` parameter to the Zod input schema:
  ```typescript
  memoryType: z.string().max(50).optional()
    .describe("Filter to entities with observations of this memory type (e.g., 'decision', 'procedure'). Omit for all types.")
  ```
- Pass through to `store.searchNodes()`.

**Tests:**
- SQLite + JSONL parameterized test: create entities with observations of different memory_types, search with memoryType filter, verify only matching entities returned
- Test that memoryType filter + query text work together (both must match)
- Test that omitting memoryType returns all (backward compatible)
- Test cursor fingerprint: memoryType changes between pages → InvalidCursorError
- MCP tool test: verify Zod schema accepts memoryType parameter

### Task 3b: memoryType filter on get_summary

**Why:** Enables the SessionStart protocol to request `get_summary(memoryType='status')` for project state or `get_summary(memoryType='decision')` for recent decisions.

**sqlite-store.ts changes — `getSummary()` method:**
- When `memoryType` is provided, add `AND o.memory_type = ?` to the top-observations query.
- The recentEntities subquery should also filter: only count observations of the matching type.
- The aggregate stats (total entities/observations/relations) should remain unfiltered — they report overall health.

**jsonl-store.ts changes — `getSummary()` method:**
- Same filter in-memory for the top observations and recent entities.

**types.ts changes:**
- Add `memoryType?: string` to `getSummary()` parameters.

**index.ts changes — `get_summary` tool:**
- Add `memoryType` parameter to the Zod input schema (same as search_nodes).
- Pass through to `store.getSummary()`.

**Tests:**
- Create entities with mixed memory_types, call getSummary with memoryType filter, verify only matching observations in top list
- Verify aggregate stats are unfiltered
- Verify backward compatibility (omit memoryType → all types)

### Task 3c: check_duplicates tool

**Why:** Pre-write duplicate check. Currently `add_observations` fires similarity check post-write — observation is already persisted when caller sees the warning. `check_duplicates` lets Claude check BEFORE committing.

**Design spec reference:** §4 of `docs/superpowers/specs/2026-04-09-v1.1-enhancements-design.md`.

**types.ts additions:**
```typescript
/** Input for pre-write duplicate checking. */
export interface CheckDuplicateInput {
  entityName: string;
  content: string;
}

/** A single match found by the duplicate checker. */
export interface DuplicateMatch {
  content: string;
  similarity: number;  // cosine similarity 0.0-1.0
  createdAt: string;
}

/** Result for one candidate observation. */
export interface CheckDuplicateResult {
  entityName: string;
  candidateContent: string;
  matches: DuplicateMatch[];
}

/** Full response from checkDuplicates. */
export interface CheckDuplicatesResponse {
  results: CheckDuplicateResult[];
  modelReady: boolean;  // false if embeddings unavailable
}
```

Add `checkDuplicates(candidates: CheckDuplicateInput[]): Promise<CheckDuplicatesResponse>` to `GraphStore` interface.

**sqlite-store.ts — `checkDuplicates()` method:**
1. For each candidate, embed with `this.embeddingPipeline.embed(content)`
2. Query `vec_observations` for k=20 nearest neighbors
3. Filter to same-entity observations (join `observations` table on `observation_id`, then join `entities` on `entity_id`, match by normalized name)
4. Filter to cosine > 0.80 (slightly lower than the post-write check's 0.85, since this is advisory)
5. Filter to active observations only (`superseded_at = ''`)
6. Return matches sorted by similarity DESC
7. If embedding pipeline is not ready, return `{ results: [...empty matches...], modelReady: false }`

**jsonl-store.ts — `checkDuplicates()` method:**
- Return `{ results: [...empty matches...], modelReady: false }` (no vector search available, not an error)

**index.ts — `check_duplicates` tool:**
```typescript
// Input schema
{
  candidates: z.array(z.object({
    entityName: z.string().min(1).max(500),
    content: z.string().min(1).max(5000)
  })).min(1).max(50)
}
```
- Normalize entity names before passing to store
- Output: `CheckDuplicatesResponse`

**Tests:**
- Create entity with observations, check_duplicates with similar content → returns matches
- check_duplicates with unrelated content → returns empty matches
- check_duplicates with non-existent entity → returns empty matches (not an error)
- check_duplicates when vector search disabled → returns modelReady: false
- MCP tool test: Zod schema validation

### Task 3d: Update CLAUDE.md

After all server changes are implemented:
- Add `check_duplicates` to the MCP tools list in CLAUDE.md
- Add `memoryType` parameter documentation to the search_nodes and get_summary entries
- Update test counts
- Update version if warranted

### Verification for Phase 3

- [ ] `search_nodes` with `memoryType='procedure'` returns only entities with procedure-type observations
- [ ] `search_nodes` with `memoryType` + `query` filters by both
- [ ] `search_nodes` without `memoryType` returns all entities (backward compatible)
- [ ] `get_summary` with `memoryType` filters top observations and recent entities
- [ ] `get_summary` aggregate stats remain unfiltered
- [ ] `check_duplicates` returns similar existing observations without writing anything
- [ ] `check_duplicates` returns `modelReady: false` when vector search is off
- [ ] All existing tests still pass
- [ ] New tests pass for all three features
- [ ] CLAUDE.md updated with new tool and parameters
- [ ] cursor fingerprint incorporates memoryType (cross-filter pagination rejected)

---

## Phase 4: Scheduled Consolidation Agent — DONE

**Goal:** Ongoing maintenance that prevents re-accumulation of noise. A weekly agent audits and consolidates memory.

**Dependency:** Phase 1 (the agent follows the write policy) and Phase 3a (uses memoryType filter).

**Implementation note:** The original plan called for a CCR (Claude Code Remote) trigger, but CCR runs in Anthropic's cloud with no access to local MCP servers or local files. Since the consolidation agent needs both the local MCP memory server and file system read access to verify observations, the implementation uses `claude -p` (non-interactive print mode) invoked by a local systemd user timer.

### What was built

**Files created:**

| File | Purpose |
|------|---------|
| `~/.claude/prompts/memory-consolidation.md` | Self-contained prompt: write policy, 3-pass workflow (freshness → noise triage → consolidation), data preservation rules, time management |
| `~/.claude/consolidation-settings.json` | Stripped settings: opus model, high effort, no hooks, no auto-memory, extended thinking (128K tokens), adaptive thinking disabled |
| `~/.claude/consolidation-mcp.json` | MCP config with only the memory server (used with `--strict-mcp-config`) |
| `~/.claude/scripts/run-consolidation.sh` | Orchestrator: preflight checks, logging, `claude -p` invocation with `--settings`/`--strict-mcp-config`/`--tools`/`--system-prompt`, exit code capture, LAST_FAILURE file, log rotation (8 weeks) |
| `~/.config/systemd/user/memory-consolidation.service` | systemd oneshot service (31-minute timeout, no restart) |
| `~/.config/systemd/user/memory-consolidation.timer` | Weekly timer: Sunday 7pm Pacific, Persistent=true for catch-up |

**Key design decisions:**

- **`--settings` overlay with `"hooks": {}`**: Intended to suppress SessionEnd/PreCompact hooks. In practice, `--settings` merges additively (doesn't replace user hooks). The hooks fire but agent-type hooks fail harmlessly in `-p` mode ("not yet supported outside REPL"). Cosmetic log noise only.
- **`--system-prompt` override**: Prevents CLAUDE.md Session Protocol from competing with consolidation instructions. The agent follows only its prompt.
- **`--strict-mcp-config` + `--mcp-config`**: Locks MCP to memory server only. No GitHub, Playwright, Firecrawl, etc.
- **`--tools "Bash,Read,Glob,Grep"`**: Read-only built-in tools. MCP tools (memory server) load separately.
- **No `--max-budget-usd`**: User is on Max subscription (flat fee). The 30-minute timeout is the safety valve.
- **No `--bare`**: Would disable OAuth (Max auth). Discovered during testing — "Not logged in" error.
- **Time-based budget, not entity count**: Agent processes all entities and reserves ~3 minutes for summary report. Better than a fixed 50-entity cap with no resume mechanism.
- **`set +e` around pipe**: `set -eo pipefail` would kill the script before error handling runs if `claude -p` exits non-zero.

### First run results (2026-04-13)

- 100 entities scanned (all), 43 observations superseded, ~6 minutes runtime
- Pass A (freshness): corrected stale version claim (v1.1.1 → v1.1.0), demoted stale L1 observations
- Pass B (noise): superseded 26 noise observations (SQL detail, function signatures, line numbers, call sites)
- Pass C (consolidation): merged overlapping status/feature observations on dustin-space and voice-assistant entities
- Zero new entities or observations created
- All 50+ fully-superseded entities scanned and confirmed clean

### Verification for Phase 4

- [x] Timer enabled and active: `systemctl --user list-timers memory-consolidation.timer` shows next run Sun Apr 19 7pm PDT
- [x] Manual run completed successfully (exit 0, ~6 minutes)
- [x] Agent correctly identified and superseded 43 stale/noise observations
- [x] Agent followed the write policy (did not create new noise observations)
- [x] Agent report includes: entities checked (100), observations superseded (43), entities verified clean
- [x] Schedule confirmed: weekly, Sunday 7pm Pacific (Persistent=true for catch-up)
- [x] Failure detection: LAST_FAILURE file written on error/timeout, cleared on success
- [x] Log retention: 8-week rotation via `find -mtime +56 -delete`

---

## Phase 5: SessionStart Retrieval Enhancement

**Goal:** Update the session-start protocol to use the clean, classified data from Phases 1-4 effectively. This is the payoff — structured briefing instead of raw data dump.

**Dependency:** Phases 1-4 must be complete. This retrieval flow only works with classified data.

**Files to modify:**
- `~/.claude/settings.json` — SessionStart hook prompt, PostCompact hook prompt
- `~/Claude/CLAUDE.md` — Session Protocol section

### Task 5a: Update SessionStart hook

Replace the SessionStart hook's first command (the echo that prints session protocol instructions) with updated instructions:

**New SessionStart protocol:**
1. Read MEMORY.md and relevant memory files for the current project
2. Call `get_context_layers(projectId)` → L0 (always-in-context rules) + L1 (status, recent decisions, active procedures)
3. Call `get_summary(projectId, excludeContextLayers=true, limit=10)` → top non-L0/L1 observations by importance
4. Call `search_nodes(query=projectName, memoryType='procedure')` → relevant procedures
5. State what you found: project name, status, active decisions, available procedures, any warnings

This replaces the current "search for project name and dump everything" with: rules → status → decisions → procedures.

### Task 5b: Update PostCompact hook

Update the PostCompact agent prompt to follow the same retrieval flow (steps 2-5 above) instead of the current generic "query MCP memory server for the current project name" instruction.

### Task 5c: Update ~/Claude/CLAUDE.md Session Protocol

Update the "Session Protocol" section to match the new retrieval flow. This ensures Claude follows the protocol even if hooks don't fire.

### Verification for Phase 5

- [x] SessionStart hook prints the new protocol with `get_context_layers` → `get_summary` → `search_nodes(memoryType='procedure')` flow
- [x] PostCompact agent follows the same retrieval flow (8-step structured prompt)
- [x] `~/Claude/CLAUDE.md` Session Protocol section matches (7-step flow, updated Memory Priority description)
- [x] Memory Priority description updated: MCP memory server now described as storing "decisions, architecture patterns, procedures, lessons learned" (not the old "function signatures, variable names, file inventories")
- [x] settings.json validates as JSON (jq -e on both hook paths)
- [ ] A fresh session on mcp-memory-server loads: L0/L1 observations, top-importance observations, available procedures *(verify on next session start)*
- [ ] The session-start context is structured and concise (not a raw dump of all observations) *(verify on next session start)*

---

## Phase 6: Confidence Decay (CONDITIONAL)

**Goal:** Per-observation confidence signal visible at retrieval time.

**Condition:** Evaluate after Phases 1-5 are complete and have been running for at least 2 weeks. If Claude sessions are trusting and effectively using memory (acting on recalled information without re-verifying everything, and the recalled information is accurate), this phase is unnecessary. If trust is still low despite clean data, implement this.

**Trigger for implementation:** If ANY of these are observed after Phase 5:
- Claude consistently re-reads files it has memory observations for (doesn't trust the observations)
- Claude adds "I recall from memory that X, let me verify..." preambles before acting
- The consolidation agent (Phase 4) consistently finds a high rate of stale observations (>20% per run)

**If triggered, implement:**

1. **Schema v10 migration:** `ALTER TABLE observations ADD COLUMN last_verified_at TEXT NOT NULL DEFAULT ''`
   - Backfill: `UPDATE observations SET last_verified_at = created_at WHERE last_verified_at = ''`
   - This means all existing observations start with their creation time as verification time

2. **Verification refresh in supersede_observations:** When the new content is identical to the old content (pure verification, no change), update `last_verified_at` instead of creating a new row. Add a path in `supersedeObservations()`:
   ```
   if (oldContent === newContent) {
     UPDATE observations SET last_verified_at = ? WHERE entity_id = ? AND content = ? AND superseded_at = ''
     // Don't create a new row, don't invalidate embedding
   }
   ```

3. **Computed confidence in query responses:** In `getSummary()` and `getContextLayers()`, compute and include:
   ```
   confidence = max(0.1, 1.0 - decayRate * monthsSince(last_verified_at))
   ```
   Where `decayRate` varies by context_layer:
   - L0: 0.02/month (rules barely decay)
   - L1: 0.05/month (status decays moderately)
   - null/L2: 0.15/month (on-demand detail decays fast)

4. **Tests:** verification refresh, confidence computation, decay rate differentiation

**If NOT triggered:** Close this phase. The freshness system (Tier 1 mtime flags + Tier 2 PreCompact audit) and the consolidation agent (Phase 4) are sufficient.

---

## Open Issues That Interact With This Plan

These existing GitHub issues are related but not addressed by this plan:

- **#59 (zero-width Unicode, HIGH):** Normalization gap — zero-width characters in entity names could bypass Layer 1 normalization. Should be fixed independently, before or during Phase 3.
- **#53 (semantic alias, MEDIUM/deferred):** Layer 2 name normalization — embedding-based similar-name detection at create time. Deferred in the v1.1 design spec. Not in this plan.
- **#30 (FTS5, LOW):** Full-text search upgrade from LIKE. Would improve search quality but is orthogonal to this plan's focus on write policy and classification.
- **#20 (JSDoc, LOW):** Documentation. Orthogonal.

---

## What This Plan Explicitly Does NOT Include

| Feature | Why excluded |
|---------|-------------|
| Local LLM for classification or consolidation | Rejected after evaluation — see "Local LLM evaluation" in the preamble |
| Audit log (§5 of design spec) | Forensics, not usability. Doesn't serve any pillar or goal directly. |
| `graph_stats` tool (§6 of design spec) | Mostly covered by `get_summary` aggregate stats. Missing fields are diagnostics. |
| Importance-weighted ranking in `search_nodes` | Would break keyset pagination. Role split is cleaner: search_nodes for targeted lookup (recency), get_summary for orientation (importance). |
| Retrieval-driven auto-importance in the server hot path | Adds hot-path complexity for marginal gain. The consolidation agent adjusts importance weekly based on observed patterns — same outcome, no runtime cost. |
| Entity name Layer 2 (semantic similarity warning) | Deferred in design spec, still not urgent. Layer 1 prevents mechanical drift. |
| Automatic L0/L1 promotion/demotion | Out of scope — classification remains caller-managed. The write policy and consolidation agent handle this behaviorally. |
| Contradiction detection | Needs LLM-in-the-loop for semantic comparison. v2.0 candidate. |

---

## Post-Implementation Deviation Review (2026-04-13)

### D1: Phase 4 changed from CCR to local systemd timer + `claude -p`

**What changed:** Plan said "Phase 4 is a scheduled CCR agent" (using Anthropic's cloud infrastructure). Shipped as a local systemd user timer invoking `claude -p`.

**Why:** CCR runs in Anthropic's cloud with no access to local MCP servers or local files. The consolidation agent needs both — the local MCP memory server to query/supersede observations, and file system access to verify cited files against current content.

**Principle:** Goal A (reduce drift) — verification requires reading the actual files. A cloud agent that can't read the files can't verify observations, defeating the purpose.

**Impact:** The agent runs only when the machine is on. `Persistent=true` catches missed runs, but extended offline periods mean consolidation pauses. No risk to data — just delayed maintenance.

**Worth it because:** A consolidation agent that can't verify observations against files is theater, not maintenance. The whole point is catching drift between memory and reality.

### D2: Consolidation prompt grew from 3 passes to 4

**What changed:** Plan described a 3-pass workflow (freshness → noise triage → consolidation). Shipped with 4 passes: freshness → noise triage → consolidation → classification check.

**Why:** The 6-agent review (architect agent) flagged that the consolidation agent had no instruction to verify or correct `memoryType`, `importance`, and `contextLayer` metadata. Without Pass D, observations with wrong classifications would persist indefinitely — the only other fixer is `set_observation_metadata` invoked manually.

**Principle:** Goal A (reduce drift) — wrong metadata is a form of drift. An observation classified as `procedure` when it's really a `decision` degrades the memoryType filter's usefulness.

**Impact:** Slightly longer consolidation runs (~1 minute). Marginal — the agent already reads every observation for Passes A-C.

**Worth it because:** Without Pass D, the memoryType filter (Phase 3a) returns wrong results. Classification correctness is as important as content correctness.

### D3: `check_duplicates` gained `errorCount` field

**What changed:** Plan's `CheckDuplicatesResponse` had `results` and `modelReady`. Shipped with an additional `errorCount: number` field.

**Why:** Silent-failure-hunter flagged that embedding errors per-candidate were caught but invisible to callers. An empty `matches` array meant either "no duplicates" or "check failed" — callers couldn't distinguish.

**Principle:** Goal A (reduce drift) — if a caller trusts "no duplicates" when the check actually errored, they write a duplicate. The flag makes failure visible.

**Impact:** All callers must now check `errorCount > 0` to know whether empty matches are trustworthy. Minor API surface growth.

**Worth it because:** Silent failures in deduplication defeat the purpose of the deduplication check.

### D4: `addObservations` gained `similarityCheckFailed` flag

**What changed:** Plan didn't specify any change to `addObservations` error surfacing. Shipped with `similarityCheckFailed?: boolean` on `AddObservationResult`.

**Why:** Same principle as D3 — the post-write similarity check catches errors internally but the caller sees only the absence of `similarExisting`, which looks identical to "no similar observations found."

**Principle:** Goal A — same as D3. Silent failure in similarity checks leads to uncaught duplicates.

**Impact:** Callers that check `similarExisting` should also check `similarityCheckFailed`. Backward compatible (field is optional, undefined = check ran normally).

**Worth it because:** Consistent with D3. If error surfacing matters for pre-write checks, it matters for post-write checks too.

### D5: KNN k boosted for memoryType-filtered queries

**What changed:** Plan didn't address the interaction between memoryType filtering and vector search. Shipped with `knnK = min(max(baseK, 200), 500)` when memoryType is set, up from `min(baseK, 200)` default.

**Why:** Architect agent identified that KNN retrieves top-k globally, then filters by `memory_type` in post-processing. Sparse types (e.g., `procedure` with 5 observations in a corpus of 1500) would rarely appear in the global top-k, making the vector search path effectively useless for them.

**Principle:** Goal B (faithful recall) — if procedures exist but search can't find them, the procedure library (Pillar 4) is broken.

**Impact:** Slightly slower vector queries when memoryType is set (~200-500 KNN neighbors vs ~80). At current scale (<2000 observations), sub-millisecond difference. At 50K+, could matter — but that's when ANN indexes would be needed anyway.

**Worth it because:** The memoryType filter is the key Phase 3 feature. If it doesn't work for sparse types, it's unreliable in exactly the cases it's most needed.

### D6: `busy_timeout` pragma added to SQLite store

**What changed:** Plan didn't mention concurrency handling. Shipped with `PRAGMA busy_timeout = 5000` after WAL mode.

**Why:** Security-auditor flagged that `better-sqlite3` defaults to 0ms busy timeout — any concurrent write contention throws `SQLITE_BUSY` immediately. The consolidation agent (Phase 4) and normal Claude sessions can write concurrently.

**Principle:** Goal A — a consolidation agent that crashes on `SQLITE_BUSY` because it ran during a session is unreliable maintenance.

**Impact:** Writers wait up to 5 seconds instead of failing instantly. In WAL mode, readers never block, so the practical impact is only on concurrent writers (consolidation agent vs live session). No risk of deadlock — SQLite's internal timeout handles retry.

**Worth it because:** Without this, the consolidation agent would intermittently fail every time it overlapped with a live session's write. That's a near-certainty given Claude sessions write to memory.

### D7: Security hardening of consolidation-settings.json

**What changed:** Plan specified stripped settings (no hooks, opus model). Shipped with a full `permissions` block: allow-list of read-only Bash commands, deny-list of destructive commands.

**Why:** Security-auditor flagged that `--dangerously-skip-permissions` with no `permissions.deny` meant the consolidation agent had unrestricted Bash access. A prompt injection via a malicious observation could execute arbitrary commands.

**Principle:** Defense-in-depth. The prompt is trustworthy, but the data it processes (observations) comes from prior sessions that may have been compromised. The deny-list is a safety net.

**Impact:** The consolidation agent can't run `rm`, `mv`, `cp`, `curl`, `wget`, `sudo`, `chmod`, `shred`, `dd`, `truncate`, or `mkfs`. It can still `cat`, `grep`, `ls`, `head`, `tail`, `stat`, `date`, and `wc` — everything it needs for verification.

**Worth it because:** The cost of the deny-list is one JSON block in a config file. The cost of not having it is unbounded if an observation ever contains injected instructions.

### D8: `sanitize-network-output.py` fail-closed error handling

**What changed:** Plan didn't address existing hook security. Shipped with try/except wrapping + `sys.exit(2)` on any unhandled exception, plus a 4-second `SIGALRM` timeout.

**Why:** Silent-failure-hunter flagged that the network sanitization hook was fail-open — any exception (malformed JSON, regex error, unexpected field type) would let sensitive data pass through to the transcript unredacted.

**Principle:** Security hooks must fail closed. A security mechanism that fails open is worse than none — it creates a false sense of protection.

**Impact:** If the hook crashes for any reason, tool output is blocked (exit 2) instead of passed through. False positives (blocking clean output on hook error) are preferable to false negatives (leaking sensitive data).

**Worth it because:** This hook guards secrets, API keys, and credentials in Bash output. The fail-open window existed since the hook was created.

### D9: `check-memory-noise.py` stderr logging on JSON parse failure

**What changed:** Plan didn't specify error handling for the noise guardrail hook. Shipped with `print(f"...", file=sys.stderr)` on `json.JSONDecodeError`.

**Why:** Silent-failure-hunter flagged that the hook silently returned on parse failure — if stdin was malformed, the hook did nothing and nobody knew.

**Principle:** Observability. A guardrail that silently fails gives no signal about why observations aren't being flagged.

**Impact:** Parse errors now appear in stderr (visible in `--debug` mode). The hook still doesn't block writes — it just logs the error instead of swallowing it.

**Worth it because:** Zero-cost diagnostic that makes debugging hook failures possible.

### D10: `run-consolidation.sh` pre-flight failure marker + `--kill-after=10`

**What changed:** Plan specified a simple run script. Shipped with: (a) failure marker written BEFORE `claude -p` runs (cleared on success), and (b) `timeout --kill-after=10 1800` instead of `timeout 1800`.

**Why:** (a) Adversarial tester: if the script is killed mid-run (OOM, power loss), no failure is recorded — the next timer fires and may hit the same problem. Pre-flight marker means any incomplete run is detectable. (b) `timeout` sends SIGTERM by default; `claude -p` may not clean up within the default grace period, leaving orphaned processes.

**Principle:** Goal A (reliability) — a maintenance system that silently fails is maintenance debt.

**Impact:** (a) A stale `LAST_FAILURE` file now means either "run failed" or "run is in progress" — disambiguated by whether the service is active. (b) After SIGTERM, `claude -p` gets 10 seconds before SIGKILL.

**Worth it because:** Without (a), a consistently-failing consolidation agent could run for months without anyone noticing. Without (b), zombie processes could accumulate.

### D11: Supersession verification instruction in consolidation prompt

**What changed:** Plan's consolidation prompt didn't address the exact-match requirement of `supersede_observations`. Shipped with an explicit instruction: "re-read the entity to get the exact current text — don't guess or paraphrase from memory."

**Why:** The adversarial tester initially claimed `supersede_observations` silently skips mismatches. Investigation proved it actually throws and rolls back the entire batch. The real risk is worse: one hallucinated `oldContent` kills all 100 supersessions in the batch. The consolidation agent runs with extended context and processes many entities — hallucinating an observation's exact text after reading 50 entities is plausible.

**Principle:** Goal A — a consolidation run that fails at the `supersede_observations` step and rolls back wastes the entire session's work.

**Impact:** The agent is instructed to copy-paste exact text rather than paraphrasing from its context window. Slightly more tool calls (re-reading entities before superseding), slightly more reliable batches.

**Worth it because:** A single mismatched oldContent in a batch of 100 supersessions rolls back all 100. The cost of re-reading is trivial; the cost of a rolled-back batch is the entire run.

### Cross-cutting behaviors

1. **Security hardening was the largest category of deviations (D7, D8, D9, D10, D11).** The plan focused on usability — "make memory useful" — and treated the consolidation agent and hooks as trusted infrastructure. The 6-agent review surfaced that these components process untrusted data (observations from prior sessions, Bash output from arbitrary commands) and need defensive design. The plan's threat model was implicitly too trusting.

2. **Error surfacing was a recurring theme (D3, D4, D9).** Three deviations independently addressed the same anti-pattern: operations that catch errors internally but present success to callers. This suggests the codebase had a systematic bias toward graceful degradation (good for availability) at the expense of caller awareness (bad for correctness). The fixes add flags, not blocks — callers can still proceed, but they know when the check didn't actually run.

3. **The plan underestimated the CCR→local gap (D1).** The plan was written assuming CCR could reach local resources. This is a fundamental architectural constraint of CCR, not an oversight that could have been avoided. Future plans involving scheduled agents should start with: "Does this need local file/MCP access? If yes, use local systemd + `claude -p`, not CCR."

4. **No deviations reduced scope.** Every deviation added to the plan. This is consistent with the user's principle — "if it's worth fixing later, it's worth fixing now" — but means the shipped implementation is a superset of the plan. Future work referencing this plan should read the deviation review, not just the phase descriptions.
