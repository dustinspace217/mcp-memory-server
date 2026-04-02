# MCP Memory Server

A knowledge-graph-based persistent memory server for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Stores entities, observations, and relations in a persistent knowledge graph (SQLite default, JSONL fallback) that MCP clients (like Claude Code) can query across sessions.

## Attribution

This project is derived from [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) by Anthropic, PBC, originally published under the MIT License as part of the [MCP Servers](https://github.com/modelcontextprotocol/servers) monorepo. The original LICENSE file is preserved in this repository.

## What's Different

This fork adds features tailored for long-running, multi-session workflows:

- **Timestamped observations** — each observation is a `{ content, createdAt }` object with an ISO 8601 UTC timestamp for staleness detection
- **SQLite storage backend** — default backend with WAL mode, foreign key constraints, and database-level deduplication; JSONL available as a fallback
- **Auto-migration** — upgrading from JSONL to SQLite is automatic on first run
- *(Planned)* Project-scoped entities for multi-project filtering
- *(Planned)* Paginated results for large graphs

## Installation

```bash
npm install
npm run build
```

> **Note:** `better-sqlite3` is a native C addon. You'll need C build tools (gcc, make) installed on your system. On Fedora: `sudo dnf install gcc make`. If you can't install build tools, use the JSONL fallback (see below).

## Usage

### As an MCP server (stdio transport)

```bash
node dist/index.js
```

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

The `MEMORY_FILE_PATH` environment variable is optional. If omitted, the server stores data in `memory.db` alongside the server script.

## Tools

| Tool | Description |
|------|-------------|
| `create_entities` | Create new entities in the knowledge graph |
| `create_relations` | Create relations between entities (active voice) |
| `add_observations` | Add observations to existing entities |
| `delete_entities` | Delete entities and their associated relations |
| `delete_observations` | Delete specific observations from entities |
| `delete_relations` | Delete relations between entities |
| `read_graph` | Read the entire knowledge graph |
| `search_nodes` | Search entities by name, type, or observation content |
| `open_nodes` | Retrieve specific entities by name |

## Data Model

The server uses a knowledge graph with three primitives:

- **Entities** — named nodes with a type and a list of observations
- **Relations** — directed edges between entities with a relation type
- **Observations** — `{ content, createdAt }` objects attached to an entity (the atomic unit of knowledge). `createdAt` is an ISO 8601 UTC timestamp, or `'unknown'` for data migrated from the original string format

## Storage Backends

### SQLite (default)

SQLite is the default backend. Data is stored in `memory.db` with:
- WAL mode for concurrent read performance
- Foreign key constraints preventing dangling relations
- Database-level deduplication via UNIQUE constraints

The file extension determines which backend is used: `.db` or `.sqlite` routes to SQLite; `.jsonl` routes to JSONL. No extension (or omitting `MEMORY_FILE_PATH` entirely) defaults to `memory.db`.

### JSONL (fallback)

For environments without C build tools (needed for `better-sqlite3`), set `MEMORY_FILE_PATH` to a `.jsonl` path:

```json
{
  "args": ["node", "dist/index.js"],
  "env": {
    "MEMORY_FILE_PATH": "/path/to/memory.jsonl"
  }
}
```

The JSONL backend writes the full graph as newline-delimited JSON on every save. It uses atomic writes (temp file + rename) to prevent corruption, and skips malformed lines on load rather than crashing.

### Migration

When upgrading from JSONL to SQLite:
1. Change `MEMORY_FILE_PATH` to a `.db` path (or remove it to use the default `memory.db`)
2. On first run, the server auto-migrates data from the `.jsonl` file (same base name, same directory)
3. The original JSONL file is renamed to `.jsonl.bak`
4. To roll back: rename `.jsonl.bak` to `.jsonl`, delete the `.db` file, and set `MEMORY_FILE_PATH` back to the `.jsonl` path

## Development

```bash
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```

## License

See [LICENSE](LICENSE) for the full text and original copyright notices. The upstream project is transitioning from MIT to Apache-2.0; documentation is licensed under CC-BY-4.0.
