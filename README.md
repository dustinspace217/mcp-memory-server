# MCP Memory Server

A knowledge-graph-based persistent memory server for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Stores entities, observations, and relations in a JSONL-backed graph that MCP clients (like Claude Code) can query across sessions.

## Attribution

This project is derived from [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) by Anthropic, PBC, originally published under the MIT License as part of the [MCP Servers](https://github.com/modelcontextprotocol/servers) monorepo. The original LICENSE file is preserved in this repository.

## What's Different

This fork adds features tailored for long-running, multi-session workflows:

- **Timestamped observations** — observations can carry `[YYYY-MM-DD HH:MM UTC]` prefixes for staleness detection
- *(Planned)* SQLite + FTS5 backend for faster search and concurrent access
- *(Planned)* Project-scoped entities for multi-project filtering
- *(Planned)* Paginated results for large graphs

## Installation

```bash
npm install
npm run build
```

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
        "MEMORY_FILE_PATH": "/path/to/your/memory.jsonl"
      }
    }
  }
}
```

The `MEMORY_FILE_PATH` environment variable is optional. If omitted, the server stores data in `memory.jsonl` alongside the server script.

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

- **Entities** — named nodes with a type and a list of observation strings
- **Relations** — directed edges between entities with a relation type
- **Observations** — free-text strings attached to an entity (the atomic unit of knowledge)

Data is stored as newline-delimited JSON (JSONL) for simplicity and append-friendliness.

## Development

```bash
npm test           # run tests once
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```

## License

MIT — see [LICENSE](LICENSE) for the full text and original copyright notices.
