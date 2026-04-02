# mcp-memory-server — Knowledge Graph MCP Server

Standalone fork of @modelcontextprotocol/server-memory. Provides persistent memory to MCP clients via a knowledge graph of entities, observations, and relations stored in SQLite (default) or JSONL.

## Tech Stack
- TypeScript, Node.js 22, ES modules
- MCP SDK: @modelcontextprotocol/sdk (stdio transport)
- better-sqlite3 for SQLite storage (native C addon — requires C build tools at install time)
- Zod for input/output schema validation
- Vitest for testing
- Build: `npm run build` (tsc)
- Test: `npm test` (vitest run)

## Architecture

The server is split across 4 source files:

### `types.ts` (~155 lines)
- Defines the `Entity`, `Relation`, `KnowledgeGraph`, and `Observation` types
- `Entity.project: string | null` — scopes the entity to a project (`null` = global, never `undefined`)
- `Entity.updatedAt: string` and `Entity.createdAt: string` — ISO 8601 UTC timestamps (sentinel `'0000-00-00T00:00:00.000Z'` for legacy data)
- `CreateEntitiesResult` and `SkippedEntity` types — collision reporting when entity names already exist
- `PaginationParams`, `PaginatedKnowledgeGraph`, `InvalidCursorError` types for cursor-based pagination
- Defines the `GraphStore` interface — the contract both storage backends must implement
- All CRUD methods are declared here; both `JsonlStore` and `SqliteStore` implement this interface
- Updated `GraphStore.readGraph` and `GraphStore.searchNodes` signatures accept `PaginationParams` and return `PaginatedKnowledgeGraph`
- `Observation` type: `{ content: string; createdAt: string }` — each observation carries an ISO 8601 UTC timestamp (or `'unknown'` for data migrated from old string format)

### `jsonl-store.ts` (~647 lines)
- `JsonlStore` class: JSONL flat-file backend (renamed from `KnowledgeGraphManager`)
- Implements the `GraphStore` interface
- Optional `project` field on entity JSONL lines (`null`/missing = global)
- `updatedAt` and `createdAt` fields serialized/deserialized with sentinel fallback for legacy files
- Atomic writes: saves to a `.tmp` file then uses `fs.rename` to swap it in — prevents partial writes from corrupting the file
- `loadGraph()` uses per-line error isolation — malformed JSONL lines are logged to stderr and skipped, so one bad line doesn't kill the whole graph
- Full graph is loaded from disk and saved back on every operation (no partial updates)
- In-memory cursor-based pagination with entity name as tiebreaker

### `sqlite-store.ts` (~979 lines)
- `SqliteStore` class: SQLite backend using `better-sqlite3`
- Implements the `GraphStore` interface
- `project TEXT` nullable column on entities table — `NULL` means global (visible to all projects)
- `updated_at` and `created_at` columns on entities table (sentinel default for legacy data, backfilled from observation timestamps during migration)
- Migration via `pragma('table_info(entities)')` for existing databases that lack the `project` column
- `idx_entities_project` and `idx_relations_to_entity` indexes for query performance on project-filtered reads and relation lookups
- `idx_entities_project_updated(project, updated_at DESC, id DESC)` and `idx_entities_updated(updated_at DESC, id DESC)` indexes for paginated reads
- Opens the database with WAL mode (Write-Ahead Logging) — allows reads to proceed concurrently with writes
- `foreign_keys = ON` is set per connection — SQLite does not enable FK constraints by default, so this must be set explicitly each time the connection opens
- Deduplication is enforced at the database level via `UNIQUE` constraints on entity names, relation triples, and (entity + observation content) pairs — `INSERT OR IGNORE` silently skips duplicate inserts
- Relations must reference existing entity names (FK constraints), so adding a relation with a missing endpoint throws rather than silently creating a dangling edge
- Cursor-based keyset pagination on `(updated_at DESC, id DESC)` with opaque base64-encoded cursors

### `index.ts` (~405 lines)
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
- `cursor` and `limit` optional parameters on `read_graph` and `search_nodes` tools
- `nextCursor` and `totalCount` in paginated responses
- `PaginatedOutputSchema` for shared output validation
- `list_projects` tool returns distinct project names from the store
- MCP tools registered with separate input/output Zod schemas
- Zod schemas enforce `.min(1)` on all string inputs, `.max(500)` on names / `.max(5000)` on observation content, and `.max(100)` on all input arrays
- All dedup operations use Set-based O(1) lookups (entity names, JSON-serialized composite relation keys, observation content) with within-batch dedup (Sets updated during iteration)
- Delete operations are idempotent (silently ignore missing targets); add operations throw on missing entities

## Known Limitations
- **Entity names are globally unique** across all projects — permanent architectural constraint because relations use entity names as foreign keys
- **Project filtering is advisory, not a security boundary** — it scopes queries for convenience but does not enforce access control. Entity name collisions across projects are reported (not silently dropped), and global entities (project=null) are visible to all project-scoped queries by design.
- **JSONL backend**: no file locking for concurrent access; no FK validation that relation endpoints reference existing entities
- **SQLite backend**: LIKE-based search is case-insensitive for ASCII only — non-ASCII Unicode characters (e.g. accented letters, CJK) may not match case-insensitively as expected
- **Paginated relation coverage is incomplete** — relations are only included when both endpoints appear on the same page. Paginating through all pages and unioning results does not yield complete relation coverage. Use `open_nodes` for full relation context on specific entities.
- **Cursor stability under mutation** — if an entity's `updatedAt` changes between page fetches (e.g., observations added), the entity may appear on two pages or be skipped. This is inherent to keyset pagination with a mutable sort key and is the correct tradeoff for a memory server (freshness > perfect enumeration). Note: SQLite gracefully continues past deleted cursor targets (keyset WHERE clause skips missing rows); JSONL throws `InvalidCursorError` if the cursor target entity was deleted between pages (strict findIndex match).

## Tests
- `__tests__/knowledge-graph.test.ts` — parameterized suite (`describe.each`) running ~81 shared behavioral tests against both `JsonlStore` and `SqliteStore`, covering all CRUD operations, deduplication (within-entity, within-array, and within-batch), composite key safety, search, edge cases, observation timestamps, normalizeObservation validation, atomic writes (JSONL), idempotent delete edge cases, project filtering (create with projectId, readGraph/searchNodes/openNodes scoping, listProjects, collision reporting via CreateEntitiesResult), cursor-based pagination (limit, cursor navigation, totalCount, nextCursor, invalid cursor handling, empty results, project-scoped pagination, search pagination). Plus ~14 JSONL-specific tests (malformed line isolation, legacy .json migration) and ~9 SQLite-specific tests (FK enforcement, WAL mode, UNIQUE constraint dedup, project column migration)
- `__tests__/file-path.test.ts` — 10 tests covering `StoreConfig` return type, extension routing (.jsonl / .db / .sqlite / default), and legacy .json→.jsonl migration
- `__tests__/migration.test.ts` — 5 tests covering JSONL→SQLite auto-migration: data transfer, .jsonl.bak rename, idempotency when .db already exists, empty JSONL file handling

## Planned Phases
1. ~~**Timestamps**~~ — DONE: observations are `{ content, createdAt }` objects; legacy string observations auto-migrate with `createdAt: 'unknown'`
2. ~~**SQLite storage backend**~~ — DONE: SQLite default with JSONL fallback, GraphStore interface, auto-migration, FK constraints, parameterized tests
3. ~~**Project filtering**~~ — DONE: optional projectId parameter on tools, project column in SQLite, collision reporting via CreateEntitiesResult
4. ~~**Pagination**~~ — DONE: cursor-based pagination for read_graph and search_nodes, entity timestamps (updatedAt/createdAt), keyset ordering by recency

## Relevant Agents
- **code-reviewer** — logic errors, edge cases in graph operations
- **test-writer** — coverage for new features
- **security-auditor** — file path traversal, injection via entity names
- **performance-analyst** — load/save efficiency, memory usage at scale
- **adversarial-tester** — malformed JSONL, concurrent writes, huge graphs

## Relevant MCP Servers
- **memory** — this IS the memory server; test changes against the live instance
- **github** — repo management, issues, PRs
