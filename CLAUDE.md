# mcp-memory-server — Knowledge Graph MCP Server

Standalone fork of @modelcontextprotocol/server-memory. Provides persistent memory to MCP clients via a knowledge graph of entities, observations, and relations stored in SQLite (default) or JSONL.

## Project Goals

This project exists to make a memory server that **actually helps Claude across sessions and compactions** — not to chase theoretical completeness, and not to become a bloated, practically useless mess. The end user is Claude itself: the memory server's job is to be the kind of tool a Claude session would *want* to use — fast, accurate, drift-resistant, and directly useful in the moment.

Every feature must answer the question: *"does this make a real, meaningful improvement to how Claude works across sessions and compactions?"* If the answer isn't a confident yes, the feature doesn't ship. A useless feature isn't neutral — it's friction that crowds out the useful ones and adds maintenance, test surface, and cognitive load with no payback.

### The three durable goals (A/B/C)

These are the evaluation criteria for every design decision in this project. Originally established for the memory freshness hook system (`~/.claude/projects/-home-dustin-Claude/memory/project_memory_system_goals.md`), they apply identically here because the freshness system and the memory server serve the same end: trustworthy, useful recall.

- **A. Reduce drift and hallucination risk.** Stale facts must surface, not be silently recalled as truth. Every code path that exposes data is responsible for distinguishing "currently true" from "was true at time T."
- **B. Faithful recall of who/what/when/where/why/how** for projects, conversations, actions, decisions. The memory server is the canonical record of how a body of work came to be the way it is. Losing that history defeats the purpose.
- **C. Enhance meaningful conversations and quality code.** These are the two end-uses memory serves. A feature that doesn't trace back to one of them — directly or one hop away — doesn't belong in this project.

### Goal-first evaluation

When a design decision arises (coverage gap, scope ambiguity, trade-off), map the options against the three goals and the practical principle above, and pick the option that serves them best. **Implementation conventions are means, not ends.** If a convention conflicts with a goal, the goal wins. Don't escalate to the user until goal-first analysis fails to produce a clear answer. (Durable workflow rule from `feedback_goal_first_evaluation.md`.)

### Anti-bloat gate (mandatory before adding any new tool, schema column, or code path)

1. **Goal trace.** Does this serve A, B, or C in a way the existing tools don't already cover? Name the gap.
2. **Practical use test.** Would a Claude session actually reach for this in the moment, or is it shelf decoration nobody invokes?
3. **Cost proportionality.** Is the cost (complexity, maintenance, test surface, RAM at runtime) proportional to the practical benefit?

If any answer is no, drop it or defer it to a later version. **Three usable tools beat ten clever ones nobody reaches for.** When in doubt, leave it out — features can always be added later if the gap proves real, but removing a shipped feature is much harder.

### Why these goals are written here

This section exists so any future Claude session opening this project sees the *animating purpose* before the *technical detail*. The risk this guards against is straightforward: a memory server that grows feature-by-feature without a north star eventually becomes the thing it was supposed to replace — slow, noisy, and untrustworthy. The goals above are the north star.

## Tech Stack
- TypeScript, Node.js 22, ES modules
- MCP SDK: @modelcontextprotocol/sdk (stdio transport)
- better-sqlite3 for SQLite storage (native C addon — requires C build tools at install time)
- sqlite-vec for vector similarity search (native SQLite extension via npm)
- @huggingface/transformers for local ONNX embedding generation (all-MiniLM-L6-v2, 384 dimensions)
- Zod for input/output schema validation
- Vitest for testing
- Build: `npm run build` (tsc)
- Test: `npm test` (vitest run)

## Architecture

The server is split across 6 source files:

### `types.ts` (~330 lines)
- Defines the `Entity`, `Relation`, `KnowledgeGraph`, and `Observation` types
- `RelationInput` type: 3-field input (from, to, relationType) for creating/deleting relations — callers never construct temporal fields
- `Relation` type: 5-field output (from, to, relationType, createdAt, supersededAt) — temporal fields are system-managed
- `InvalidateRelationInput` type: identifies relations to retire via `invalidateRelations()`
- `Entity.project: string | null` — scopes the entity to a project (`null` = global, never `undefined`)
- `Entity.updatedAt: string` and `Entity.createdAt: string` — ISO 8601 UTC timestamps (sentinel `'0000-00-00T00:00:00.000Z'` for legacy data)
- `CreateEntitiesResult` and `SkippedEntity` types — collision reporting when entity names already exist
- `PaginationParams`, `PaginatedKnowledgeGraph`, `InvalidCursorError` types for cursor-based pagination
- `SupersedeInput` type: `{ entityName, oldContent, newContent }` for observation supersede operations
- `SetObservationMetadataInput` type: `{ entityName, content, importance?, contextLayer?, memoryType? }` — updates metadata on active observations without superseding. Uses `'key in object'` checks to distinguish "omitted" from "explicitly null".
- `ContextLayerObservation` and `ContextLayersResult` types — return types for `getContextLayers()`. L0 observations omit `updatedAt`, L1 includes it. `tokenEstimate` is chars / 4.
- `TimelineObservation`, `TimelineRelation`, `EntityTimelineResult` types for full entity history (active + superseded items with computed `status` field)
- `SimilarObservation` type: `{ content, similarity }` returned when newly added observations are semantically close to existing ones (cosine > 0.85)
- `AddObservationResult` includes optional `similarExisting?: SimilarObservation[]` for similarity warnings
- Defines the `GraphStore` interface — the contract both storage backends must implement
- All CRUD methods are declared here; both `JsonlStore` and `SqliteStore` implement this interface
- `createRelations(relations: RelationInput[])` and `deleteRelations(relations: RelationInput[])` use the input type; return `Relation[]` (with temporal fields)
- `invalidateRelations(relations: InvalidateRelationInput[])` — marks relations as superseded (idempotent)
- `entityTimeline(entityName, projectId?)` — returns full history including superseded observations and invalidated relations
- `supersedeObservations(supersessions: SupersedeInput[])` method on `GraphStore` — atomically retires old observations and inserts replacements
- `getContextLayers(projectId?, layers?)` method on `GraphStore` — returns L0/L1 observations with token budget enforcement
- `getSummary(projectId?, excludeContextLayers?, limit?)` method on `GraphStore` — returns session-start briefing snapshot: top observations by importance, recently updated entities, aggregate stats
- `setObservationMetadata(updates: SetObservationMetadataInput[])` method on `GraphStore` — updates importance/contextLayer/memoryType in-place on active observations; returns count updated
- Updated `GraphStore.readGraph` and `GraphStore.searchNodes` signatures accept `PaginationParams` and return `PaginatedKnowledgeGraph`
- `Observation` type: `{ content: string; createdAt: string }` — each observation carries an ISO 8601 UTC timestamp (or `'unknown'` for data migrated from old string format)

### `cursor.ts` (~120 lines)
- Shared cursor utilities for keyset pagination — used by both store backends
- `CursorPayload` interface: `{ u, i, n?, q }` — sort position + query fingerprint
- `encodeCursor()` / `decodeCursor()`: base64 JSON encoding with structural validation
- `decodeCursor` validates: `i` is non-negative finite integer, `n` is string if present, `q` matches expected fingerprint
- `clampLimit()`: clamps page size to [1, MAX_PAGE_SIZE] with DEFAULT_PAGE_SIZE fallback
- `readGraphFingerprint()` / `searchNodesFingerprint()`: build query fingerprints using null byte (`\0`) separator to prevent collision when projectId/query contains delimiter characters
- Constants: `DEFAULT_PAGE_SIZE = 40`, `MAX_PAGE_SIZE = 100`

### `normalize-name.ts` (~80 lines)
- `normalizeEntityName(input: string): string` — Layer 1 entity-name normalizer used as the identity key throughout the store
- Deterministic, no semantic understanding: trim → Unicode NFC → lowercase → strip separators (`/[\s\-_/.\\:]+/g`) → reject empty
- Why NFC (not NFKC): NFC preserves visual identity. NFKC would collapse typographic forms like `ﬁ → fi` and `Ⅸ → IX`, destroying information when the user genuinely meant the ligature or roman numeral.
- Callers: `SqliteStore` mutation/lookup paths (entities + relation endpoints) and `index.ts` tool boundary handlers — surface variants like `Dustin-Space`, `dustin/space`, `DUSTIN SPACE`, and `dustinspace` all map to the same identity key `dustinspace`.
- Display form is preserved in the `entities.name` column (see `sqlite-store.ts`); this module only produces the identity key.
- Turkish dotted-I caveat: `toLowerCase()` uses default locale — `İ` → `i̇` (i + combining dot). Acceptable for English-dominant projects; documented limitation.
- Throws `Error` on empty input or input that normalizes to empty (e.g. whitespace-only or separator-only name).

### `embedding.ts` (~155 lines)
- `EmbeddingPipeline` class: wraps `@huggingface/transformers` for local ONNX embedding generation
- `VectorState` type: `{ status: 'loading' } | { status: 'ready'; pipeline } | { status: 'failed'; error; failedAt } | { status: 'unavailable' }` — logged at every transition
- `startLoading(onReady?)`: background model load via dynamic `import('@huggingface/transformers')`. Calls `onReady` callback when model is ready.
- `embed(text)`: single text → Float32Array(384) embedding with circuit breaker (5 consecutive failures → 'failed')
- `embedBatch(items)`: sequential per-item embedding with error isolation (failed items skipped, rest continue)
- `EMBEDDING_DIM = 384` constant (matches all-MiniLM-L6-v2 output dimensionality)
- Model: `Xenova/all-MiniLM-L6-v2` ONNX — ~23MB download on first use, cached thereafter

### `jsonl-store.ts` (~700 lines) — DEPRECATED
- `JsonlStore` class: JSONL flat-file backend — **deprecated**, maintained only for environments without C build tools
- Does NOT support: vector search, temporal relations, entity timeline, invalidate_relations, similarity check, setObservationMetadata
- `invalidateRelations()`, `entityTimeline()`, and `setObservationMetadata()` throw "not supported in JSONL backend"
- `getContextLayers()` IS supported — filters observations in-memory (no vector search or index needed)
- Implements the `GraphStore` interface
- Optional `project` field on entity JSONL lines (`null`/missing = global)
- `updatedAt` and `createdAt` fields serialized/deserialized with sentinel fallback for legacy files
- Backward-compat deserialization for temporal fields on relations (defaults added on read)
- Atomic writes: saves to a `.tmp` file then uses `fs.rename` to swap it in — prevents partial writes from corrupting the file
- `loadGraph()` uses per-line error isolation — malformed JSONL lines are logged to stderr and skipped, so one bad line doesn't kill the whole graph
- Full graph is loaded from disk and saved back on every operation (no partial updates)
- In-memory cursor-based pagination with entity name as tiebreaker
- Imports cursor utilities from `cursor.ts`

### `sqlite-store.ts` (~2650 lines)
- `SqliteStore` class: SQLite backend using `better-sqlite3`
- Implements the `GraphStore` interface
- **Schema version tracking**: `schema_version` table with `CHECK(id=1)` single-row constraint. Versions 1–8 tracked. Legacy databases detected via column existence heuristics and assigned an initial version. All migrations run in sequence on startup.
- **Entity name normalization (v8)**: `entities.normalized_name` is the identity key (lowercased + NFC + separators stripped, produced by `normalize-name.ts`). `entities.name` preserves the original display form the user typed. All lookups and uniqueness constraints use `normalized_name`; tool output surfaces `name`. Partial unique index `idx_entities_normalized_active ON entities(normalized_name) WHERE superseded_at = ''` enforces one active identity per normalized key.
- **Relations store normalized endpoints (v8)**: `relations.from_entity` and `relations.to_entity` hold the normalized identity keys — not display names — so lookups work regardless of which surface variant the caller used. `readGraph()` and `searchNodes()` translate endpoints back to display form via `LEFT JOIN entities ON ... COALESCE(e.name, r.from_entity)` so output always shows the user's original capitalization/separators. v6→v7 migration drops the FK clause from `relations.from_entity`/`to_entity` (the underlying `entities.name` UNIQUE constraint is now partial, and partial unique indexes don't qualify as FK targets in SQLite); integrity is enforced by the v8 migration's explicit orphan check and the tool-boundary normalization.
- `project TEXT` nullable column on entities table — `NULL` means global (visible to all projects)
- `updated_at` and `created_at` columns on entities table (sentinel default for legacy data, backfilled from observation timestamps during migration in a transaction)
- `superseded_at TEXT NOT NULL DEFAULT ''` on observations — empty string sentinel means active, ISO timestamp means superseded. `UNIQUE(entity_id, content, superseded_at)` constraint. All queries filter `WHERE superseded_at = ''` to exclude retired observations.
- `idx_observations_active` partial index on `observations(entity_id) WHERE superseded_at = ''`
- **Temporal relations**: `created_at TEXT NOT NULL DEFAULT ''` and `superseded_at TEXT NOT NULL DEFAULT ''` on relations table. `UNIQUE(from_entity, to_entity, relation_type, superseded_at)` constraint. Active queries filter `WHERE superseded_at = ''`. Schema v4→v5 migration uses table rebuild pattern.
- `invalidateRelations()`: sets `superseded_at` to current timestamp on matching active relations. Idempotent — ignores already-invalidated relations.
- `entityTimeline()`: returns full history of an entity — ALL observations and relations (active + superseded) sorted chronologically with computed `status` field.
- `supersedeObservations()` atomically retires old observations and inserts replacements in a single transaction
- Migration via `pragma('table_info')` for existing databases — table rebuild migration for superseded_at column
- Phase 4 migration (timestamps) wrapped in explicit transaction — prevents crash between ALTER TABLE and backfill from leaving permanent sentinel timestamps
- **Vector search**: loads `sqlite-vec` extension, creates `vec_observations` virtual table (`vec0` with 384-dim float vectors + `+observation_id TEXT NOT NULL` auxiliary column). Startup orphan cleanup removes vec rows without matching active observations. Background embedding sweep generates embeddings for un-embedded observations after model loads. Sweep has `.catch()` on the promise (prevents unhandled rejection crash), try-catch around batch INSERTs, and DELETE-before-INSERT to prevent duplicate vec rows from races with `syncEmbedding()`.
- `syncEmbedding()` centralized helper — all 5 mutation paths (create, add, delete, deleteEntity, supersede) fire-and-forget it to keep `vec_observations` in sync. Never throws (internal try-catch), never awaited on mutation paths so MCP responses return immediately after the sync transaction.
- **Similarity check** in `addObservations()`: after inserting new observations, embeds them and runs KNN search against same-entity observations. Returns `similarExisting` array (cosine > 0.85) in the response for deduplication awareness.
- Hybrid `searchNodes()`: runs LIKE query first, then augments with KNN vector results if embedding model is ready. Vector-only matches are appended to LIKE results, deduped against full LIKE match set across all pages.
- `idx_relations_to_entity_active` partial index on `relations(to_entity) WHERE superseded_at = ''`; `idx_entities_project_updated(project, updated_at DESC, id DESC)` and `idx_entities_updated(updated_at DESC, id DESC)` indexes for paginated reads
- Single-column `idx_entities_project` dropped on startup (redundant — covered by composite `idx_entities_project_updated`)
- **Graceful shutdown**: `private shuttingDown` flag checked in `runEmbeddingSweep` loop. `shutdown()` method sets the flag. Called from SIGINT/SIGTERM handlers before `close()`.
- Opens the database with WAL mode (Write-Ahead Logging) — allows reads to proceed concurrently with writes
- `foreign_keys = ON` is set per connection — SQLite does not enable FK constraints by default, so this must be set explicitly each time the connection opens
- Deduplication is enforced at the database level via `UNIQUE` constraints on entity names, relation triples (+ superseded_at), and (entity + observation content + superseded_at) — `INSERT OR IGNORE` silently skips duplicate inserts
- Relations must reference existing entity names (FK constraints), so adding a relation with a missing endpoint throws rather than silently creating a dangling edge
- Cursor-based keyset pagination on `(updated_at DESC, id DESC)` — imports cursor utilities from `cursor.ts`
- `openNodes` uses IN-clause chunking (CHUNK_SIZE=900) for consistency with other methods

### `index.ts` (~760 lines)
- Entry point: registers 16 MCP tools via `server.registerTool()`
- `StoreConfig` type and `ensureMemoryFilePath()`: resolves the storage path from `MEMORY_FILE_PATH` env var and returns which store class to use
  - `.jsonl` extension → `JsonlStore`
  - `.db` or `.sqlite` extension → `SqliteStore`
  - No extension / omitted → defaults to `memory.db` (SQLite)
- Auto-migration: on first run, if a `.db` path is requested but doesn't exist yet and a `.jsonl` file is found at the same base path, the server migrates all data from JSONL into SQLite in a single transaction, then renames the original `.jsonl` to `.jsonl.bak`
- `normalizeProjectId()`: trims whitespace, lowercases, NFC-normalizes Unicode, and converts empty/undefined to undefined (global scope)
- `normalizeObservation()`: validates observation shape (structural check, not unsafe cast); throws on invalid format
- `createObservation()`: creates new observations with current UTC timestamp
- `projectId` optional parameter on `create_entities`, `read_graph`, `search_nodes`, `open_nodes` tools — scopes operations to a project
- `cursor` (`.max(10000)`) and `limit` optional parameters on `read_graph` and `search_nodes` tools
- `nextCursor` and `totalCount` in paginated responses
- `PaginatedOutputSchema` for shared output validation
- `list_projects` tool returns distinct project names from the store
- `supersede_observations` tool atomically retires old observations and inserts replacements via `store.supersedeObservations()`
- `invalidate_relations` tool marks relations as superseded (idempotent — ignores already-invalidated)
- `entity_timeline` tool returns full history of an entity (active + superseded observations and relations with computed status field)
- `set_observation_metadata` tool updates importance, context layer, and/or memory type on existing active observations without superseding them. Resolves entity names via normalized_name lookup. Returns count of observations updated.
- `get_context_layers` tool returns L0 and L1 observations sorted by importance DESC. Enforces soft token budgets (~100 tokens L0, ~800 tokens L1). Designed for SessionStart/PostCompact hooks. Supports project scoping and layer filtering.
- `get_summary` tool returns a session-start briefing snapshot: top observations by importance DESC then recency DESC, 5 most recently updated entities with observation counts, and aggregate stats (total entities/observations/relations/projects). `excludeContextLayers` boolean omits L0/L1 observations for dedup with `get_context_layers`. `limit` caps top observations (default 20).
- `add_observations` response includes optional `similarExisting` field with similarity warnings (cosine > 0.85)
- `RelationInputSchema` (3-field input) and `RelationOutputSchema` (5-field with temporal columns) — separate schemas for input validation vs. output serialization
- SIGINT/SIGTERM handlers call `store.shutdown()` for graceful embedding sweep termination before `store.close()`
- MCP tools registered with separate input/output Zod schemas
- Zod schemas enforce `.min(1)` on all string inputs, `.max(500)` on names / `.max(5000)` on observation content, and `.max(100)` on all input arrays
- All dedup operations use Set-based O(1) lookups (entity names, JSON-serialized composite relation keys, observation content) with within-batch dedup (Sets updated during iteration)
- Delete operations are idempotent (silently ignore missing targets); add operations throw on missing entities

## Memory Maintenance

### Observation write guidance
- **Supersede** when an observation states a fact that has changed (status, counts, signatures, descriptions). Use `supersede_observations` to atomically retire the old observation and insert the updated version. The old observation remains in the database (with a `superseded_at` timestamp) for history but is filtered from all active queries.
- **Append** when an observation adds a genuinely new fact that doesn't contradict or update any existing observation. Use `add_observations` as before.
- **Never delete** observations to "clean up" — supersede preserves history and avoids accidental data loss.

### Vector search
- Vector search uses sqlite-vec + @huggingface/transformers (all-MiniLM-L6-v2, 384 dimensions)
- LIKE substring search always runs; vector search adds supplementary semantic matches when the model is loaded
- Set `MEMORY_VECTOR_SEARCH=off` env var to disable vector search entirely
- JSONL backend does not support vector search or observation supersede
- On first startup, the model downloads ~23MB (cached thereafter). Embedding sweep runs in background.
- `syncEmbedding()` in sqlite-store.ts is the centralized helper — all mutation paths call it

## Known Limitations
- **Entity names are globally unique** across all projects — permanent architectural constraint because relations use entity names as foreign keys
- **Project filtering is advisory, not a security boundary** — it scopes queries for convenience but does not enforce access control. Entity name collisions across projects are reported (not silently dropped), and global entities (project=null) are visible to all project-scoped queries by design.
- **JSONL backend**: no file locking for concurrent access; no FK validation that relation endpoints reference existing entities
- **SQLite backend**: LIKE-based search is case-insensitive for ASCII only — non-ASCII Unicode characters (e.g. accented letters, CJK) may not match case-insensitively as expected
- **Paginated relation coverage is incomplete** — relations are only included when both endpoints appear on the same page. Paginating through all pages and unioning results does not yield complete relation coverage. Use `open_nodes` for full relation context on specific entities.
- **Cursor stability under mutation** — if an entity's `updatedAt` changes between page fetches (e.g., observations added), the entity may appear on two pages or be skipped. This is inherent to keyset pagination with a mutable sort key and is the correct tradeoff for a memory server (freshness > perfect enumeration). Note: SQLite gracefully continues past deleted cursor targets (keyset WHERE clause skips missing rows); JSONL throws `InvalidCursorError` if the cursor target entity was deleted between pages (strict findIndex match).
- **Vector search is best-effort** — if the model fails to load, the extension is unavailable, or embedding fails for specific observations, the system degrades gracefully to LIKE-only. No data is lost.
- **Embedding latency on writes** — embedding generation is fire-and-forget after the sync transaction commits (does not block MCP response). Embedding may not be searchable until the next query (~5-15ms per observation).
- **vec0 is brute-force KNN** — at current scale (~1500 observations), sub-millisecond. At ~50,000+, consider switching to ANN index (sqlite-vec supports IVF).
- **Pagination sorts by `updatedAt`, not semantic relevance** — vector search improves recall (finding entities LIKE would miss) but does not affect ranking.

## Schema Migrations
Database schema is versioned in the single-row `schema_version` table (CHECK constraint enforces one row). Migrations run in sequence on startup in `sqlite-store.ts`; each one is idempotent and wrapped in a transaction except where noted.

- **v1→v2:** Baseline schema for initial entity/observation/relation tables.
- **v2→v3:** `project TEXT` nullable column on entities (NULL = global).
- **v3→v4:** `updated_at` / `created_at` columns on entities with observation-timestamp backfill in a single transaction.
- **v4→v5:** Temporal relations — `created_at` + `superseded_at` on relations with `UNIQUE(from_entity, to_entity, relation_type, superseded_at)`. Table-rebuild migration.
- **v5→v6:** Observation metadata — `importance REAL DEFAULT 3.0`, `context_layer TEXT NULL`, `memory_type TEXT NULL` on observations.
- **v6→v7:** Soft-delete on entities — `superseded_at TEXT NOT NULL DEFAULT ''` column, partial unique index `idx_entities_name_active ON entities(name) WHERE superseded_at = ''`. FK clauses on `relations.from_entity`/`to_entity` are dropped in this migration because partial unique indexes don't qualify as FK targets in SQLite.
- **v7→v8:** Entity name normalization — adds `normalized_name` column on entities (the identity key), rewrites `relations.from_entity`/`to_entity` to normalized form, drops `idx_entities_name_active`, creates `idx_entities_normalized_active ON entities(normalized_name) WHERE superseded_at = ''`. Collision check before index creation aborts the migration (rollback) if two active rows normalize to the same key, naming both display forms and the collision key. Wrapped with `PRAGMA foreign_keys = OFF/ON` (outside the transaction) to tolerate historical databases that arrived at v7 with stale FK clauses still attached; integrity is enforced by an explicit orphan check inside the migration.

## Tests (496 total across 8 test files)
- `__tests__/knowledge-graph.test.ts` (352 tests) — parameterized suite (`describe.each`) running shared behavioral tests against both `JsonlStore` and `SqliteStore`, covering all CRUD operations, deduplication, composite key safety, search, edge cases, observation timestamps, normalizeObservation validation, atomic writes (JSONL), idempotent delete edge cases, project filtering, cursor-based pagination, supersedeObservations, temporal relations (createdAt/supersededAt on relations, invalidateRelations, entityTimeline), similarity check, totalCount accuracy, entity name normalization behavioral tests, setObservationMetadata (importance/contextLayer/memoryType updates, entity not found, observation not found, surface variant lookup, timestamp bumps, superseded exclusion, batch updates), getContextLayers (empty result, importance sorting, layer filtering, project scoping, L2 exclusion, L1 token budget truncation), getSummary (empty result, importance+recency sorting, observation counts, limit param, project scoping, excludeContextLayers, aggregate stats). Plus JSONL-specific and SQLite-specific tests (including `entity name normalization (Layer 1)` block exercising surface variants on create/read/delete/supersede/invalidate/timeline).
- `__tests__/mcp-tools.test.ts` (78 tests) — integration tests for MCP tool handlers including invalidate_relations, entity_timeline, normalization at the tool boundary, set_observation_metadata Zod schema validation (name normalization, importance range, contextLayer enum, null demotion), and get_summary Zod schema validation (limit range, valid input acceptance)
- `__tests__/normalize-name.test.ts` (17 tests) — unit tests for `normalizeEntityName()`: NFC equivalence, case fold, separator stripping, Turkish dotted-I behavior, empty/whitespace/separator-only rejection
- `__tests__/file-path.test.ts` (16 tests) — `StoreConfig` return type, extension routing (.jsonl / .db / .sqlite / default), and legacy .json→.jsonl migration
- `__tests__/migration.test.ts` (5 tests) — JSONL→SQLite auto-migration: data transfer, .jsonl.bak rename, idempotency when .db already exists, empty JSONL file handling
- `__tests__/migration-validation.test.ts` (14 tests) — schema version tracking and migration validation across versions 1–8, including v7→v8 forward-migration test (display preservation + relation rewrite) and collision-abort test (two active entities normalizing to same key → rollback)
- `__tests__/vector-search.test.ts` (4 tests) — vector state reporting, MEMORY_VECTOR_SEARCH=off degradation, LIKE fallback while loading, superseded observations excluded from LIKE search
- `__tests__/vector-integration.test.ts` (6 tests) — end-to-end tests with real embedding model: semantic search, LIKE+vector dedup, superseded observation exclusion, similarExisting check, as_of recovery of superseded matches, soft-deleted entity exclusion. Skip with `SKIP_VECTOR_INTEGRATION=1`.
- `__tests__/smoke-test-vec.ts` — one-off script (not a vitest test) validating sqlite-vec + better-sqlite3 + @huggingface/transformers compatibility on this platform

**Test pool discipline:** The suite runs in two commands. Pool 1 (non-vector, 490 tests): `MEMORY_VECTOR_SEARCH=off SKIP_VECTOR_INTEGRATION=1 npx vitest run --exclude '**/vector-integration.test.ts'`. Pool 2 (vector integration, 6 tests): `MEMORY_VECTOR_SEARCH=on npx vitest run __tests__/vector-integration.test.ts --pool=forks --poolOptions.forks.singleFork=true`. See `feedback_local_llm_test_pool_discipline.md` for the reasoning (the local ONNX model load must be isolated and single-fork to avoid hard-reboots).

## Version History
- **v1.0.0** — Temporal relations (superseded_at on relations, invalidate_relations + entity_timeline tools), similarity check on addObservations, schema version tracking (versions 1–5), graceful shutdown, totalCount fix, JSONL backend deprecated
- **v0.11.0** — Observation supersede mechanism, vector search (sqlite-vec + all-MiniLM-L6-v2), hybrid LIKE+KNN search
- **v0.10.0** — Cursor-based pagination, entity timestamps (updatedAt/createdAt)
- **v0.9.0** — Project filtering, collision reporting
- **v0.8.0** — SQLite storage backend, auto-migration from JSONL
- **v0.7.0** — Timestamped observations

## Relevant Agents
- **code-reviewer** — logic errors, edge cases in graph operations
- **test-writer** — coverage for new features
- **security-auditor** — file path traversal, injection via entity names
- **performance-analyst** — load/save efficiency, memory usage at scale
- **adversarial-tester** — malformed JSONL, concurrent writes, huge graphs

## Relevant MCP Servers
- **memory** — this IS the memory server; test changes against the live instance
- **github** — repo management, issues, PRs
