# mcp-memory-server — Knowledge Graph MCP Server

Standalone fork of @modelcontextprotocol/server-memory. Provides persistent memory to MCP clients via a knowledge graph of entities, observations, and relations stored in JSONL.

## Tech Stack
- TypeScript, Node.js 22, ES modules
- MCP SDK: @modelcontextprotocol/sdk (stdio transport)
- Zod for input/output schema validation
- Vitest for testing
- Build: `npm run build` (tsc)
- Test: `npm test` (vitest run)

## Architecture
- Single entry point: `index.ts` (~690 lines)
- `KnowledgeGraphManager` class: all CRUD operations on the graph
- `Observation` type: `{ content: string; createdAt: string }` — each observation carries an ISO 8601 UTC timestamp (or `'unknown'` for data migrated from old string format)
- `ensureMemoryFilePath()`: resolves storage path with backward-compat migration from .json to .jsonl
- `normalizeObservation()`: validates observation shape (structural check, not unsafe cast); throws on invalid format
- `createObservation()`: creates new observations with current UTC timestamp
- MCP tools registered via `server.registerTool()` with separate input/output Zod schemas
- Zod schemas enforce `.min(1)` on all string inputs and `.max(500)` on names / `.max(5000)` on observation content
- Storage: JSONL file with atomic writes (temp file + `fs.rename`), full load/save on every operation
- `loadGraph()` uses per-line error isolation — malformed JSONL lines are logged to stderr and skipped
- All dedup operations use Set-based O(1) lookups (entity names, composite relation keys, observation content)
- Delete operations are idempotent (silently ignore missing targets); add operations throw on missing entities
- Data path: `MEMORY_FILE_PATH` env var, or `memory.jsonl` alongside index.ts

## Known Limitations
- No file locking for concurrent access (resolved by Phase 2 SQLite)
- No validation that relation endpoints reference existing entities (resolved by Phase 2 FK constraints)

## Tests
- `__tests__/knowledge-graph.test.ts` — 52 tests covering all CRUD operations, deduplication (including within-entity and within-array bugs), search, edge cases, observation timestamps, malformed JSONL isolation, normalizeObservation validation, and atomic writes
- `__tests__/file-path.test.ts` — 9 tests covering path resolution and .json→.jsonl migration

## Planned Phases
1. ~~**Timestamps**~~ — DONE: observations are `{ content, createdAt }` objects; legacy string observations auto-migrate with `createdAt: 'unknown'`
2. **SQLite + FTS5** — replace JSONL with SQLite for indexed search and concurrent access
3. **Project filtering** — scope entities to projects so multi-project memory stays clean
4. **Pagination** — cursor-based pagination for read_graph and search_nodes

## Relevant Agents
- **code-reviewer** — logic errors, edge cases in graph operations
- **test-writer** — coverage for new features
- **security-auditor** — file path traversal, injection via entity names
- **performance-analyst** — load/save efficiency, memory usage at scale
- **adversarial-tester** — malformed JSONL, concurrent writes, huge graphs

## Relevant MCP Servers
- **memory** — this IS the memory server; test changes against the live instance
- **github** — repo management, issues, PRs
