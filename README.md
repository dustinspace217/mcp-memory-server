# MCP Memory Server

A knowledge-graph-based persistent memory server for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Stores entities, observations, and relations in SQLite with semantic vector search, temporal versioning, and cursor-based pagination.

## Attribution

This project is derived from [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) by Anthropic, PBC, originally published under the MIT License as part of the [MCP Servers](https://github.com/modelcontextprotocol/servers) monorepo. The original LICENSE file is preserved in this repository.

## Features

- **SQLite storage** with WAL mode, foreign key constraints, and database-level deduplication
- **Semantic vector search** via sqlite-vec + all-MiniLM-L6-v2 ONNX embeddings (automatic, no config needed)
- **Temporal versioning** — observations and relations track `superseded_at` timestamps; old data is preserved for history but hidden from active queries
- **Entity timeline** — view full change history (active + superseded observations and relations)
- **Similarity detection** — `add_observations` warns when new observations are semantically similar to existing ones
- **Cursor-based pagination** — sorted by most-recently-updated, stable under concurrent use
- **Project scoping** — optional `projectId` parameter isolates entities by project
- **Auto-migration** — upgrades from JSONL to SQLite automatically on first run

## Installation

```bash
npm install
npm run build
```

> **Note:** `better-sqlite3` is a native C addon. You'll need C build tools (gcc, make) installed. On Fedora: `sudo dnf install gcc make`. On Ubuntu/Debian: `sudo apt install build-essential`.

## Usage

### With Claude Code

Add to your MCP server configuration:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mcp-memory-server/dist/index.js"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/your/memory.db"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_FILE_PATH` | `memory.db` (alongside script) | Path to database file. Extension determines backend: `.db`/`.sqlite` → SQLite, `.jsonl` → JSONL |
| `MEMORY_VECTOR_SEARCH` | `on` | Set to `off` to disable vector search entirely |

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_entities` | Create new entities in the knowledge graph | `entities[]`, `projectId?` |
| `create_relations` | Create directed relations between entities | `relations[]` (from, to, relationType) |
| `add_observations` | Add observations to existing entities. Returns `similarExisting` when new observations are semantically close to existing ones | `observations[]` (entityName, contents[]) |
| `delete_entities` | Delete entities and their associated relations | `entityNames[]` |
| `delete_observations` | Delete specific observations from entities | `deletions[]` (entityName, contents[]) |
| `delete_relations` | Delete relations between entities | `relations[]` (from, to, relationType) |
| `supersede_observations` | Atomically retire old observations and insert replacements. Preserves history | `supersessions[]` (entityName, oldContent, newContent) |
| `invalidate_relations` | Mark relations as no longer active. Preserves history. Idempotent | `relations[]` (from, to, relationType) |
| `read_graph` | Read the knowledge graph (paginated, sorted by most recently updated) | `projectId?`, `cursor?`, `limit?` |
| `search_nodes` | Search entities by name, type, or observation content. LIKE + semantic vector search | `query`, `projectId?`, `cursor?`, `limit?` |
| `open_nodes` | Retrieve specific entities by name with full relations | `names[]`, `projectId?` |
| `list_projects` | List all project names in the knowledge graph | — |
| `entity_timeline` | Full change history for an entity (active + superseded observations and relations) | `entityName`, `projectId?` |

## Data Model

- **Entities** — named nodes with a type, a project scope, and timestamped observations
- **Relations** — directed edges between entities with temporal tracking (`createdAt`, `supersededAt`)
- **Observations** — `{ content, createdAt }` objects attached to an entity (the atomic unit of knowledge)

### Temporal Versioning

Observations and relations support a supersede/invalidate lifecycle:
- **Active** items (`supersededAt = ''`) appear in `read_graph`, `search_nodes`, and `open_nodes`
- **Superseded** items (with a `supersededAt` timestamp) are hidden from active queries but preserved in the database
- Use `entity_timeline` to see the full history of any entity

## Vector Search

Vector search is automatic when using the SQLite backend:
- Uses `sqlite-vec` (brute-force KNN) with `all-MiniLM-L6-v2` ONNX embeddings (384 dimensions)
- Model downloads ~23MB on first startup (cached thereafter)
- LIKE substring search always runs; vector search adds supplementary semantic matches
- Set `MEMORY_VECTOR_SEARCH=off` to disable
- If the model fails to load, the system degrades gracefully to LIKE-only search

## Storage Backends

### SQLite (default, recommended)

SQLite is the default and recommended backend. Features: WAL mode, FK constraints, database-level deduplication, vector search, temporal versioning, schema migrations.

### JSONL (deprecated)

The JSONL backend is maintained for environments without C build tools but does not support vector search, temporal relations, entity timeline, or the invalidate/supersede operations. Set `MEMORY_FILE_PATH` to a `.jsonl` path to use it.

### Migration from JSONL

1. Change `MEMORY_FILE_PATH` to a `.db` path (or remove it to use the default)
2. On first run, the server auto-migrates data from the `.jsonl` file
3. The original JSONL file is renamed to `.jsonl.bak`

## Known Limitations

- **Entity names are globally unique** across all projects (relations use names as FK)
- **Project filtering is advisory**, not a security boundary
- **Paginated relation coverage is incomplete** — use `open_nodes` for full relations on specific entities
- **Vector search is best-effort** — degrades to LIKE-only if model/extension unavailable
- **vec0 is brute-force KNN** — fine at current scale, consider ANN at ~50,000+ observations

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation and the full limitations list.

## Development

```bash
npm test           # run tests (310 tests across 7 test files)
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```

Set `SKIP_VECTOR_INTEGRATION=1` to skip the vector integration tests (which download the embedding model) for faster CI runs.

## License

See [LICENSE](LICENSE) for the full text and original copyright notices. The upstream project is transitioning from MIT to Apache-2.0; documentation is licensed under CC-BY-4.0.
