# Full-Project QA Plan — mcp-memory-server v0.10.1

> **Purpose:** Holistic QA of the entire mcp-memory-server after all 4 phases are complete. This is NOT a Phase 4-only review — it covers the full codebase as a cohesive system.

**Goal:** Validate that all 4 phases work together correctly to provide persistent, project-scoped, paginated memory to Claude across sessions and compactions.

**Primary goals being validated:**
1. Give Claude persistent memory that survives compaction and session termination
2. Make it easy to find memories related to the current project at search time
3. Contextualize prompts within general, non-project-specific memory
4. Reduce drift in project design and dev decisions between compactions/session boundaries

**Current state:** v0.10.1, 217 tests passing, 5 source files, 3 test files, commit 776cb4a

---

## Source Files Under Review

| File | Lines | Purpose |
|---|---|---|
| `types.ts` | ~156 | Shared interfaces: Entity, Relation, KnowledgeGraph, GraphStore, pagination types |
| `cursor.ts` | ~129 | Shared cursor utilities: encode/decode, fingerprinting, clampLimit |
| `jsonl-store.ts` | ~587 | JSONL flat-file backend implementing GraphStore |
| `sqlite-store.ts` | ~931 | SQLite backend implementing GraphStore (WAL, FK, keyset pagination) |
| `index.ts` | ~406 | MCP server entry point: tool registration, store selection, Zod schemas |

## Test Files Under Review

| File | Tests | Purpose |
|---|---|---|
| `__tests__/knowledge-graph.test.ts` | ~202 | Parameterized suite: 89 shared + JSONL-specific + SQLite-specific |
| `__tests__/file-path.test.ts` | 10 | StoreConfig routing, extension handling, legacy migration |
| `__tests__/migration.test.ts` | 5 | JSONL→SQLite auto-migration: data transfer, .bak rename, idempotency |

---

## Pass 1: Parallel Agent Review (8 agents)

All agents receive the same file list and project context. Each produces findings independently.

### Agent 1: code-reviewer

```
Review the entire mcp-memory-server codebase for bugs, logic errors, edge cases, and style issues.

Files to review:
- /home/dustin/Claude/mcp-memory-server/types.ts
- /home/dustin/Claude/mcp-memory-server/cursor.ts
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts
- /home/dustin/Claude/mcp-memory-server/index.ts
- /home/dustin/Claude/mcp-memory-server/__tests__/knowledge-graph.test.ts
- /home/dustin/Claude/mcp-memory-server/__tests__/file-path.test.ts
- /home/dustin/Claude/mcp-memory-server/__tests__/migration.test.ts

This is a knowledge-graph-based MCP memory server with two storage backends (JSONL and SQLite). It was built in 4 phases:
1. Timestamps on observations
2. SQLite storage backend with auto-migration from JSONL
3. Project filtering (optional projectId scoping)
4. Cursor-based pagination

Focus areas:
- Behavioral parity between JsonlStore and SqliteStore (same interface, different implementations)
- Cursor-based pagination correctness (keyset on updatedAt DESC, id DESC)
- Project filtering edge cases (null=global, normalization, cross-project visibility)
- Migration safety (JSONL→SQLite data transfer, legacy format handling)
- Deduplication logic (entity names, relation composites, observation content)
- Relation filtering logic differences (OR vs AND logic depending on context)
- Entity timestamp consistency (updatedAt bumped on observation changes, createdAt immutable)

Report findings with file paths, line numbers, severity (critical/important/minor/nitpick), and confidence level.
```

### Agent 2: security-auditor

```
Audit the mcp-memory-server for security vulnerabilities. This is an MCP server that stores and retrieves knowledge graph data.

Files to audit:
- /home/dustin/Claude/mcp-memory-server/types.ts
- /home/dustin/Claude/mcp-memory-server/cursor.ts
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts
- /home/dustin/Claude/mcp-memory-server/index.ts
- /home/dustin/Claude/mcp-memory-server/package.json

Focus areas:
1. SQL injection — entity names, observation content, and relation fields go into SQL queries. Verify parameterized queries throughout.
2. Path traversal — MEMORY_FILE_PATH env var resolves to a file path. Check for directory traversal.
3. Cursor tampering — cursors are base64-encoded JSON. Check if a crafted cursor can cause SQL injection, denial of service, or information leakage.
4. File system attacks — JSONL store writes temp files then renames. Check for symlink attacks, race conditions.
5. Denial of service — check for unbounded allocations, regex DoS, exponential blowup.
6. Dependency audit — check better-sqlite3, @modelcontextprotocol/sdk, zod for known vulnerabilities.
7. Information leakage — can error messages expose internal paths or data?
8. Input validation gaps — are there any paths where user input reaches SQL or filesystem without validation?

Report each finding with: vulnerability type, affected file:line, severity (critical/high/medium/low), exploitability, and recommended fix.
```

### Agent 3: test-analyzer

```
Analyze test coverage and quality for mcp-memory-server. The project has 217 tests across 3 files.

Test files:
- /home/dustin/Claude/mcp-memory-server/__tests__/knowledge-graph.test.ts (~202 tests, parameterized)
- /home/dustin/Claude/mcp-memory-server/__tests__/file-path.test.ts (10 tests)
- /home/dustin/Claude/mcp-memory-server/__tests__/migration.test.ts (5 tests)

Source files:
- /home/dustin/Claude/mcp-memory-server/types.ts
- /home/dustin/Claude/mcp-memory-server/cursor.ts
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts
- /home/dustin/Claude/mcp-memory-server/index.ts

Analyze:
1. Coverage gaps — which code paths have no test? Focus on error branches, edge cases, and migration paths.
2. Test quality — are assertions meaningful? Do tests verify behavior or just "no crash"?
3. Missing test categories:
   - MCP tool handler integration tests (index.ts registerTool callbacks)
   - normalizeProjectId edge cases (NFC normalization, empty after trim)
   - ensureMemoryFilePath with various env var values
   - SQLite migration from pre-Phase-3 and pre-Phase-4 schemas
   - Concurrent access patterns (especially JSONL)
   - Large dataset behavior (1000+ entities)
   - Unicode entity names and observation content
   - Cursor reuse after entity mutation (documented edge case)
4. Test isolation — do tests clean up properly? Could parallel execution cause flakes?
5. Parameterized test coverage — which tests run against both stores vs only one?

Rate each gap as: critical (likely to hide bugs), important (should add), or nice-to-have.
```

### Agent 4: silent-failure-hunter

```
Hunt for silent failures, swallowed errors, empty catch blocks, and fallback logic that masks real problems in mcp-memory-server.

Files to examine:
- /home/dustin/Claude/mcp-memory-server/types.ts
- /home/dustin/Claude/mcp-memory-server/cursor.ts
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts
- /home/dustin/Claude/mcp-memory-server/index.ts

Known patterns to check:
1. JSONL loadGraph skips malformed lines — is this logged adequately? Could valid data be silently dropped?
2. JSONL saveGraph has a try/catch on tmpfile unlink — is this the right behavior?
3. Migration code catches FK violations and logs them — could this mask data loss?
4. SQLite close() sets db to null — what happens if methods are called after close?
5. SIGINT/SIGTERM handlers catch errors during close — appropriate?
6. ensureMemoryFilePath migration catches errors — could a partial migration be silently accepted?
7. INSERT OR IGNORE throughout SQLite — does "ignore" ever hide a real problem vs dedup?
8. deleteObservations bumps updatedAt unconditionally even if no observations matched — is this a silent behavior mismatch?
9. Are there any code paths where an error is caught and execution continues with stale/wrong data?

For each finding: describe what fails silently, what the consequence is (data loss, wrong results, corruption), and whether it needs fixing or is an acceptable tradeoff.
```

### Agent 5: adversarial-tester

```
Think like a hostile user or chaotic environment trying to break mcp-memory-server. Find edge cases, boundary conditions, race conditions, and unexpected inputs.

Files:
- /home/dustin/Claude/mcp-memory-server/types.ts
- /home/dustin/Claude/mcp-memory-server/cursor.ts
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts
- /home/dustin/Claude/mcp-memory-server/index.ts

Attack vectors to explore:
1. Entity names with special characters: null bytes, newlines, SQL special chars, Unicode normalization edge cases (NFD vs NFC), zero-width characters, extremely long names (500 chars at the Zod limit)
2. Observation content with JSON-breaking characters, multi-megabyte strings (5000 chars at Zod limit)
3. Cursor manipulation: valid base64 but wrong JSON shape, huge cursor strings (10000 char limit), cursors referencing deleted entities, cursors with future timestamps
4. Concurrent JSONL access: two processes reading/writing the same .jsonl file simultaneously
5. SQLite WAL corruption: what happens if the process crashes mid-transaction? Is WAL recovery correct?
6. Migration edge cases: JSONL file with 0 bytes, JSONL with only relations (no entities), JSONL with circular relations, JSONL with entity names that are SQL reserved words
7. Pagination boundary attacks: limit=0, limit=-1, limit=Infinity, cursor from page 1 reused after data mutation
8. Project filtering: projectId with only whitespace, projectId with null bytes, projectId that normalizes to empty string
9. Memory exhaustion: JSONL store loads entire graph into memory — what's the limit? Can a 100MB JSONL file cause OOM?
10. Graceful degradation: what happens when disk is full during JSONL saveGraph? During SQLite write?

For each scenario: describe the attack, the expected behavior, the actual behavior (or likely behavior from code review), and the severity.
```

### Agent 6: performance-analyst

```
Analyze mcp-memory-server for performance problems. This server provides persistent memory to AI assistants, so it's called frequently during conversations.

Files:
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts
- /home/dustin/Claude/mcp-memory-server/cursor.ts
- /home/dustin/Claude/mcp-memory-server/index.ts

Focus areas:
1. JSONL store: full load/save on every operation. At what entity count does this become a bottleneck? Profile the hot paths (loadGraph, saveGraph, searchNodes).
2. SQLite store: are the right indexes being used? Run EXPLAIN QUERY PLAN mentally for readGraph, searchNodes, openNodes queries.
3. buildEntities N+1 pattern: does the chunked observation fetch avoid N+1? Is the chunk size (900) optimal?
4. searchNodes subquery pattern: is the LEFT JOIN + DISTINCT + IN subquery efficient? Would a CTE be better?
5. totalCount queries: searchNodes runs a separate COUNT(DISTINCT) with 3 LIKE patterns — is this expensive? Could it be cached or eliminated?
6. Cursor encode/decode: Buffer.from + JSON.parse on every page fetch — is this a bottleneck with high page counts?
7. Memory usage: JSONL loads entire graph into memory. SQLite uses prepared statements — are they properly cached?
8. getConnectedRelations: fetches with OR logic then deduplicates — could this return huge result sets?
9. Deduplication: JSON.stringify for composite keys — is this efficient for large relation sets?
10. Startup cost: init() runs migrations, creates indexes, drops old indexes — what's the cold-start latency?

For each finding: estimate the impact (at what scale does it matter?), suggest a fix if warranted, and rate as critical/important/minor.
```

### Agent 7: architect

```
Evaluate the architecture and module design of mcp-memory-server. It was built incrementally across 4 phases and now needs a holistic assessment.

Files:
- /home/dustin/Claude/mcp-memory-server/types.ts (~156 lines)
- /home/dustin/Claude/mcp-memory-server/cursor.ts (~129 lines)
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts (~587 lines)
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts (~931 lines)
- /home/dustin/Claude/mcp-memory-server/index.ts (~406 lines)
- /home/dustin/Claude/mcp-memory-server/CLAUDE.md

Evaluate:
1. Module boundaries: Is the split between types.ts, cursor.ts, jsonl-store.ts, sqlite-store.ts, and index.ts clean? Does each file have one clear responsibility?
2. GraphStore interface: Does it properly abstract the differences between JSONL and SQLite? Are there any leaky abstractions?
3. normalizeProjectId placement: It's in index.ts but both stores also normalize internally. Is this redundant? Should normalization happen in one place?
4. Relation filtering inconsistency: OR logic (at least one endpoint matches) for unscoped queries, AND logic (both endpoints in result) for project-scoped. Is this the right design?
5. Pagination design: Keyset on (updatedAt DESC, id DESC) for SQLite, (updatedAt DESC, name ASC) for JSONL. Do these produce consistent results across backends?
6. Error handling strategy: InvalidCursorError is a class, other errors are generic Error. Is the error hierarchy sufficient?
7. Known limitations: Entity names globally unique, project filtering advisory not security, LIKE-based search ASCII-only case-insensitive. Are these properly documented and defended?
8. Future extensibility: How hard would it be to add FTS5 search, entity update/rename, or graph traversal?
9. Type safety: Are there any `as any` casts or unsafe type assertions that could hide bugs?
10. Configuration: Store selection by file extension, default to SQLite. Is this the right approach?

For each finding: describe the issue, its impact on maintainability/correctness, and whether it needs action now or is acceptable as-is.
```

### Agent 8: debugger (migration-focused)

```
Trace the complete JSONL→SQLite migration path end-to-end for mcp-memory-server. Verify there are no data loss scenarios.

Files to trace:
- /home/dustin/Claude/mcp-memory-server/sqlite-store.ts (init method, migrateFromJsonl method)
- /home/dustin/Claude/mcp-memory-server/jsonl-store.ts (loadGraph, normalizeObservation)
- /home/dustin/Claude/mcp-memory-server/index.ts (ensureMemoryFilePath)
- /home/dustin/Claude/mcp-memory-server/__tests__/migration.test.ts

Trace these scenarios:
1. Happy path: User has memory.jsonl with entities, relations, observations. They switch to SQLite. Does every field migrate correctly?
   - Entity: name, entityType, project, updatedAt, createdAt, observations
   - Relation: from, to, relationType
   - Observation: content, createdAt (both 'unknown' legacy and ISO 8601 modern)

2. Legacy data: JSONL file with old-format string observations (no createdAt). Do they get createdAt='unknown' after migration?

3. Pre-Phase-3 data: JSONL entities with no project field. Does project default to null in SQLite?

4. Pre-Phase-4 data: JSONL entities with no updatedAt/createdAt. Do they get the sentinel value in SQLite?

5. Corrupted JSONL: Duplicate entity names, malformed lines, entities with non-string project values. Does migration handle these gracefully?

6. Dangling relations: Relations pointing to entities that don't exist in the JSONL. Are they silently skipped?

7. Post-migration: After migration, the .jsonl file is renamed to .jsonl.bak. On next startup, SqliteStore sees the .db exists and skips migration. Verified?

8. Race condition: What if the process crashes after creating the .db but before renaming .jsonl to .bak? Does the next startup handle this?

9. Schema evolution: If a user migrates from a very old JSONL (pre-timestamps) to SQLite, does the Phase 4 migration (ALTER TABLE + backfill) run correctly on the just-migrated data?

For each scenario: trace the exact code path (file:line), identify any gaps, and rate the risk of data loss.
```

---

## Pass 2: Cross-Examination

After Pass 1 completes, each agent receives a summary of ALL Pass 1 findings and is asked:
1. Do you agree with the other agents' findings?
2. Do any findings change your own analysis?
3. Are there any contradictions between agents?
4. What is the consensus priority order for fixes?

---

## Parallel Validation: Migration Safety

Create a test script that:
1. Creates a realistic JSONL file with all data variants (legacy strings, modern observations, projects, globals, relations, timestamps, pre-Phase-3/4 data)
2. Opens it with SqliteStore to trigger migration
3. Reads back every entity, relation, and observation
4. Compares field-by-field with the original data
5. Verifies the .jsonl.bak rename happened

## Parallel Validation: SQLite Memory Retrieval

Query the live MCP memory server with sample prompts:
1. `search_nodes("mcp-memory-server")` — should find the project entity
2. `search_nodes("cursor")` — should find cursor-related entities
3. `read_graph()` with pagination — verify nextCursor works
4. `open_nodes(["mcp-memory-server"])` — should return full entity with observations

---

## Deferred Items from Phase 4 Review (for reference, not in scope)

These were identified during the Phase 4 review and deferred:
- FTS5 search for non-ASCII case-insensitive matching
- normalizeProjectId placement consolidation
- OR NULL index optimization for SQLite
- MCP adapter test suite (testing tool handlers directly)
- Unpaginated path safety (readGraph without pagination returns everything)
- Optional totalCount (skip the COUNT query when not needed)
