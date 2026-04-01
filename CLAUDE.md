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
- Single entry point: `index.ts` (~490 lines)
- `KnowledgeGraphManager` class: all CRUD operations on the graph
- `ensureMemoryFilePath()`: resolves storage path with backward-compat migration from .json to .jsonl
- MCP tools registered via `server.registerTool()` with Zod schemas
- Storage: JSONL file, full load/save on every operation (no incremental writes yet)
- Data path: `MEMORY_FILE_PATH` env var, or `memory.jsonl` alongside index.ts

## Tests
- `__tests__/knowledge-graph.test.ts` — 36 tests covering all CRUD operations, deduplication, search, and edge cases
- `__tests__/file-path.test.ts` — 9 tests covering path resolution and .json→.jsonl migration

## Planned Phases
1. **Timestamps** — add created_at/updated_at to observations for staleness detection
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
