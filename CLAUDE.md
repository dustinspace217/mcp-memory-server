# mcp-memory-server — Knowledge Graph MCP Server

Standalone fork of @modelcontextprotocol/server-memory. Provides persistent memory to MCP clients via a knowledge graph of entities, observations, and relations stored in SQLite (default) or JSONL.

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

### `types.ts` (~155 lines)
- Defines the `Entity`, `Relation`, `KnowledgeGraph`, and `Observation` types
- `Entity.project: string | null` — scopes the entity to a project (`null` = global, never `undefined`)
- `Entity.updatedAt: string` and `Entity.createdAt: string` — ISO 8601 UTC timestamps (sentinel `'0000-00-00T00:00:00.000Z'` for legacy data)
- `CreateEntitiesResult` and `SkippedEntity` types — collision reporting when entity names already exist
- `PaginationParams`, `PaginatedKnowledgeGraph`, `InvalidCursorError` types for cursor-based pagination
- `SupersedeInput` type: `{ entityName, oldContent, newContent }` for observation supersede operations
- Defines the `GraphStore` interface — the contract both storage backends must implement
- All CRUD methods are declared here; both `JsonlStore` and `SqliteStore` implement this interface
- `supersedeObservations(supersessions: SupersedeInput[])` method on `GraphStore` — atomically retires old observations and inserts replacements
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

### `embedding.ts` (~155 lines)
- `EmbeddingPipeline` class: wraps `@huggingface/transformers` for local ONNX embedding generation
- `VectorState` type: `{ status: 'loading' } | { status: 'ready'; pipeline } | { status: 'failed'; error; failedAt } | { status: 'unavailable' }` — logged at every transition
- `startLoading(onReady?)`: background model load via dynamic `import('@huggingface/transformers')`. Calls `onReady` callback when model is ready.
- `embed(text)`: single text → Float32Array(384) embedding with circuit breaker (5 consecutive failures → 'failed')
- `embedBatch(items)`: sequential per-item embedding with error isolation (failed items skipped, rest continue)
- `EMBEDDING_DIM = 384` constant (matches all-MiniLM-L6-v2 output dimensionality)
- Model: `Xenova/all-MiniLM-L6-v2` ONNX — ~23MB download on first use, cached thereafter

### `jsonl-store.ts` (~575 lines)
- `JsonlStore` class: JSONL flat-file backend (renamed from `KnowledgeGraphManager`)
- Implements the `GraphStore` interface
- Optional `project` field on entity JSONL lines (`null`/missing = global)
- `updatedAt` and `createdAt` fields serialized/deserialized with sentinel fallback for legacy files
- Atomic writes: saves to a `.tmp` file then uses `fs.rename` to swap it in — prevents partial writes from corrupting the file
- `loadGraph()` uses per-line error isolation — malformed JSONL lines are logged to stderr and skipped, so one bad line doesn't kill the whole graph
- Full graph is loaded from disk and saved back on every operation (no partial updates)
- In-memory cursor-based pagination with entity name as tiebreaker
- Imports cursor utilities from `cursor.ts`

### `sqlite-store.ts` (~1400 lines)
- `SqliteStore` class: SQLite backend using `better-sqlite3`
- Implements the `GraphStore` interface
- `project TEXT` nullable column on entities table — `NULL` means global (visible to all projects)
- `updated_at` and `created_at` columns on entities table (sentinel default for legacy data, backfilled from observation timestamps during migration in a transaction)
- `superseded_at TEXT NOT NULL DEFAULT ''` on observations — empty string sentinel means active, ISO timestamp means superseded. `UNIQUE(entity_id, content, superseded_at)` constraint. All queries filter `WHERE superseded_at = ''` to exclude retired observations.
- `idx_observations_active` partial index on `observations(entity_id) WHERE superseded_at = ''`
- `supersedeObservations()` atomically retires old observations and inserts replacements in a single transaction
- Migration via `pragma('table_info')` for existing databases — table rebuild migration for superseded_at column
- Phase 4 migration (timestamps) wrapped in explicit transaction — prevents crash between ALTER TABLE and backfill from leaving permanent sentinel timestamps
- **Vector search**: loads `sqlite-vec` extension, creates `vec_observations` virtual table (`vec0` with 384-dim float vectors + `+observation_id TEXT NOT NULL` auxiliary column). Startup orphan cleanup removes vec rows without matching active observations. Background embedding sweep generates embeddings for un-embedded observations after model loads.
- `syncEmbedding()` centralized helper — all 5 mutation paths (create, add, delete, deleteEntity, supersede) call it to keep `vec_observations` in sync. Never throws (best-effort).
- Hybrid `searchNodes()`: runs LIKE query first, then augments with KNN vector results if embedding model is ready. Vector-only matches are appended to LIKE results, deduped against full LIKE match set across all pages.
- `idx_relations_to_entity` index for relation lookups; `idx_entities_project_updated(project, updated_at DESC, id DESC)` and `idx_entities_updated(updated_at DESC, id DESC)` indexes for paginated reads
- Single-column `idx_entities_project` dropped on startup (redundant — covered by composite `idx_entities_project_updated`)
- Opens the database with WAL mode (Write-Ahead Logging) — allows reads to proceed concurrently with writes
- `foreign_keys = ON` is set per connection — SQLite does not enable FK constraints by default, so this must be set explicitly each time the connection opens
- Deduplication is enforced at the database level via `UNIQUE` constraints on entity names, relation triples, and (entity + observation content + superseded_at) — `INSERT OR IGNORE` silently skips duplicate inserts
- Relations must reference existing entity names (FK constraints), so adding a relation with a missing endpoint throws rather than silently creating a dangling edge
- Cursor-based keyset pagination on `(updated_at DESC, id DESC)` — imports cursor utilities from `cursor.ts`
- `openNodes` uses IN-clause chunking (CHUNK_SIZE=900) for consistency with other methods

### `index.ts` (~430 lines)
- Entry point: registers all MCP tools via `server.registerTool()`
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
- **Embedding latency on writes** — embedding generation adds ~5-15ms per observation after the transaction commits. Async and doesn't block the response, but embedding may not be searchable until the next query.
- **vec0 is brute-force KNN** — at current scale (~1500 observations), sub-millisecond. At ~50,000+, consider switching to ANN index (sqlite-vec supports IVF).
- **Pagination sorts by `updatedAt`, not semantic relevance** — vector search improves recall (finding entities LIKE would miss) but does not affect ranking.

## Tests
- `__tests__/knowledge-graph.test.ts` — parameterized suite (`describe.each`) running ~99 shared behavioral tests against both `JsonlStore` and `SqliteStore`, covering all CRUD operations, deduplication, composite key safety, search, edge cases, observation timestamps, normalizeObservation validation, atomic writes (JSONL), idempotent delete edge cases, project filtering, cursor-based pagination, supersedeObservations (10 tests: basic supersede, idempotent, missing oldContent/entity throws, updatedAt bump, invisibility to searchNodes/openNodes, batch atomicity, rollback on failure). Plus ~14 JSONL-specific tests and ~9 SQLite-specific tests.
- `__tests__/vector-search.test.ts` — 4 tests: vector state reporting, MEMORY_VECTOR_SEARCH=off degradation, LIKE fallback while loading, superseded observations excluded from LIKE search
- `__tests__/file-path.test.ts` — 10 tests covering `StoreConfig` return type, extension routing (.jsonl / .db / .sqlite / default), and legacy .json→.jsonl migration
- `__tests__/migration.test.ts` — 5 tests covering JSONL→SQLite auto-migration: data transfer, .jsonl.bak rename, idempotency when .db already exists, empty JSONL file handling
- `__tests__/smoke-test-vec.ts` — one-off script (not a vitest test) validating sqlite-vec + better-sqlite3 + @huggingface/transformers compatibility on this platform

## Planned Phases
1. ~~**Timestamps**~~ — DONE: observations are `{ content, createdAt }` objects; legacy string observations auto-migrate with `createdAt: 'unknown'`
2. ~~**SQLite storage backend**~~ — DONE: SQLite default with JSONL fallback, GraphStore interface, auto-migration, FK constraints, parameterized tests
3. ~~**Project filtering**~~ — DONE: optional projectId parameter on tools, project column in SQLite, collision reporting via CreateEntitiesResult
4. ~~**Pagination**~~ — DONE: cursor-based pagination for read_graph and search_nodes, entity timestamps (updatedAt/createdAt), keyset ordering by recency
5. ~~**Memory enhancements**~~ — DONE: observation supersede mechanism (superseded_at column, supersede_observations tool), vector search (sqlite-vec + @huggingface/transformers, hybrid LIKE+KNN search), hook updates for supersede guidance

## Relevant Agents
- **code-reviewer** — logic errors, edge cases in graph operations
- **test-writer** — coverage for new features
- **security-auditor** — file path traversal, injection via entity names
- **performance-analyst** — load/save efficiency, memory usage at scale
- **adversarial-tester** — malformed JSONL, concurrent writes, huge graphs

## Relevant MCP Servers
- **memory** — this IS the memory server; test changes against the live instance
- **github** — repo management, issues, PRs
