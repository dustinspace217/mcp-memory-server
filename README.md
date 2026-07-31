# MCP Memory Server

A knowledge-graph-based persistent memory server for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Stores entities, observations, and relations in SQLite with semantic vector search, temporal versioning, and cursor-based pagination.

## Attribution

This project is derived from [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) by Anthropic, PBC, originally published under the MIT License as part of the [MCP Servers](https://github.com/modelcontextprotocol/servers) monorepo. The original LICENSE file is preserved in this repository.

## Features

- **SQLite storage** with WAL mode, foreign key constraints, and database-level deduplication
- **Semantic vector search** via sqlite-vec + local ONNX embeddings (384-dim; `all-MiniLM-L6-v2` by default, swappable via `MEMORY_EMBED_MODEL`)
- **Relevance-ranked search** — `search_nodes` with `orderBy: 'relevance'` fuses LIKE, BM25 full-text, vector, and activation signals via reciprocal-rank fusion
- **Temporal versioning** — observations and relations track `superseded_at` timestamps; old data is preserved for history but hidden from active queries
- **Point-in-time queries** — `as_of` parameter on read/search operations recovers the graph state at any past timestamp
- **Entity soft-delete** — `delete_entities` marks entities as superseded (preserving history) rather than hard-deleting
- **Entity name normalization** — surface variants like `Dustin-Space`, `dustin/space`, and `DUSTIN SPACE` all resolve to the same identity key
- **Observation metadata** — `importance` (1-5 scale), `context_layer` (L0/L1/null), `memory_type` classification, and caller-supplied valid-time (`validFrom`/`validUntil`) on observations
- **Context layers** — `get_context_layers` returns L0 (always-loaded rules) and a two-tier L1 (session-start context): a featured tier of full text plus a per-entity breadcrumb index for the overflow, both under char budgets
- **Session-start briefing** — `get_summary` returns top observations by importance, recently updated entities, and aggregate stats
- **Entity timeline** — view full change history (active + superseded + tombstoned observations and relations)
- **Similarity detection** — `add_observations` warns when new observations are semantically similar to existing ones
- **Four-tier eviction** — Active → Superseded → Tombstoned → Hard-deleted degradation chain with 6-month LRU shield and configurable size cap (default 1 GB)
- **Cursor-based pagination** — sorted by most-recently-updated, stable under concurrent use
- **Project scoping** — optional `projectId` parameter isolates entities by project
- **Auto-migration** — an existing JSONL file is upgraded to SQLite automatically on first run (the JSONL backend itself was retired in v1.6.0)
- **Knowledge Graph Visualization** — visual representation of the memory structure, both vectored in 3D space for relational visualization, and graphed in 2D space for readability

<img width="2926" height="1755" alt="Screenshot_20260731_132326" src="https://github.com/user-attachments/assets/54f0fc4e-0014-4969-9e0e-13f05eb16741" />


## Installation

```bash
npm install
npm run build
```

> **Note:** `better-sqlite3` is a native C addon. You'll need C build tools (gcc, make) installed. On Fedora: `sudo dnf install gcc make`. On Ubuntu/Debian: `sudo apt install build-essential`.

### Full harness install (recommended for Claude Code)

The server alone provides the storage layer. To replicate the full session-lifecycle integration — auto-loaded L0 context, freshness scanning, pre/post-compact agents, noise gating, `/audit-memory` and `/checkpoint` skills, custom QA agents — see [`harness/README.md`](harness/README.md):

```bash
cd harness
./install.sh
```

The installer is idempotent, backs up existing files, and prints the manual integration steps (settings.json merge, MCP registration, CLAUDE.md fragments) at the end.

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
| `MEMORY_FILE_PATH` | `memory.db` (alongside script) | Path to the SQLite database file (`.db`/`.sqlite`). A `.jsonl` path is accepted only for one-time migration: an existing file is upgraded into the sibling `.db`; a nonexistent one errors (the JSONL backend was retired in v1.6.0) |
| `MEMORY_VECTOR_SEARCH` | `on` | Set to `off` to disable vector search entirely |
| `MEMORY_SIZE_CAP_BYTES` | `1000000000` (1 GB) | Database size cap for the eviction system. Eviction triggers at 90% of cap |
| `MEMORY_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model ID. Switching models requires a restart; stale vectors are cleared and re-embedded automatically |
| `MEMORY_EMBED_POOLING` | `mean` | Pooling strategy (`mean` or `cls`). Must match the configured model — a mismatch is a silent cosine drift |
| `MEMORY_EMBED_QUERY_PREFIX` | `` (empty) | Instruction prefix applied to query-side embeddings only (for asymmetric retrieval models) |
| `MEMORY_SIMILAR_THRESHOLD` | `0.85` | Cosine gate for the `add_observations` similarity warning. Model-geometry-coupled — recalibrate when changing models |
| `MEMORY_DUPLICATE_THRESHOLD` | `0.80` | Cosine gate for `check_duplicates` |
| `MEMORY_PRECEDENT_FLOOR` | `0.25` | Minimum cosine for `find_precedents` results |
| `MEMORY_TRIGGER_THRESHOLD` | `0.50` | Cosine gate for `check_prospective_triggers` firing. Model-geometry-coupled — recalibrate when changing models |

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_entities` | Create new entities in the knowledge graph | `entities[]`, `projectId?`, `sourceRef?` |
| `create_relations` | Create directed relations between entities | `relations[]` (from, to, relationType) |
| `add_observations` | Add observations to existing entities. Returns `similarExisting` when new observations are semantically close to existing ones | `observations[]` (entityName, contents[], importances?[], contextLayers?[], memoryTypes?[]), `sourceRef?` |
| `delete_entities` | Soft-delete entities (preserves history for `as_of` and `entity_timeline`) | `entityNames[]` |
| `delete_observations` | Delete specific observations from entities | `deletions[]` (entityName, contents[]) |
| `delete_relations` | Delete relations between entities | `relations[]` (from, to, relationType) |
| `supersede_observations` | Atomically retire old observations and insert replacements. Preserves history | `supersessions[]` (entityName, oldContent, newContent), `sourceRef?` |
| `invalidate_relations` | Mark relations as no longer active. Preserves history. Idempotent | `relations[]` (from, to, relationType) |
| `set_observation_metadata` | Update importance, context layer, memory type, valid-time, and/or summary on existing observations in-place | `updates[]` (entityName, content, importance?, contextLayer?, memoryType?, validFrom?, validUntil?, summary?) |
| `read_graph` | Read the knowledge graph (paginated, sorted by most recently updated) | `projectId?`, `asOf?`, `cursor?`, `limit?` |
| `search_nodes` | Search entities by name, type, or observation content. LIKE + semantic vector search; optional relevance ranking | `query`, `projectId?`, `memoryType?`, `orderBy?`, `asOf?`, `cursor?`, `limit?` |
| `open_nodes` | Retrieve specific entities by name with full relations | `names[]`, `projectId?`, `asOf?` |
| `check_duplicates` | Pre-write semantic duplicate check — embeds candidates and reports similar existing observations without writing | `candidates[]` (entityName, content) |
| `get_connected_context` | Bounded multi-hop graph traversal from a seed entity. Structure-only, with directed-cycle detection | `seedEntity`, `maxHops?`, `direction?`, `maxNodes?`, `relationTypes?`, `projectId?`, `asOf?` |
| `find_precedents` | Similarity-ranked observation retrieval — the most semantically similar prior observations to a query, scored | `query`, `projectId?`, `memoryType?`, `limit?`, `minSimilarity?` |
| `list_projects` | List all project names in the knowledge graph | — |
| `entity_timeline` | Full change history for an entity (active + superseded + tombstoned items) | `entityName`, `projectId?` |
| `get_context_layers` | Returns L0/L1 observations sorted by importance with token budgets (two-tier L1: featured text + breadcrumb index) | `projectId?`, `layers?` |
| `get_summary` | Session-start briefing: top observations, recent entities, aggregate stats | `projectId?`, `excludeContextLayers?`, `limit?`, `memoryType?` |
| `set_prospective_trigger` | Store a "when situation X arises, remember Y" trigger, matched semantically against future context (one-shot) | `triggerText`, `payload`, `projectId?` |
| `check_prospective_triggers` | Fire any pending triggers whose condition semantically matches the current context. Call at session start / on project switch | `contextText`, `projectId?`, `threshold?` |
| `list_prospective_triggers` | List triggers (pending only by default) for management | `projectId?`, `includeFired?` |
| `delete_prospective_triggers` | Hard-delete triggers by id (deliberate exception to the preservation lifecycle — triggers are ephemeral intent). Idempotent | `ids[]` |

## Data Model

- **Entities** — named nodes with a type, a project scope, and timestamped observations. Entity names are normalized (case-insensitive, separator-insensitive) for identity matching while preserving the original display form.
- **Relations** — directed edges between entities with temporal tracking (`createdAt`, `supersededAt`)
- **Observations** — `{ content, createdAt, importance, contextLayer, memoryType }` objects attached to an entity (the atomic unit of knowledge)

### Temporal Versioning

Observations, relations, and entities support a four-tier lifecycle:
- **Active** items appear in `read_graph`, `search_nodes`, and `open_nodes`
- **Superseded** items are hidden from active queries but preserved for history and `as_of` recovery
- **Tombstoned** items have their content stripped by the eviction system but preserve the existence skeleton
- **Hard-deleted** items are permanently removed when under extreme size pressure
- Use `entity_timeline` to see the full history of any entity (all tiers)
- Use `as_of` parameter on `read_graph`/`search_nodes`/`open_nodes` to recover the graph at any past timestamp

## Vector Search

Vector search is automatic when using the SQLite backend:
- Uses `sqlite-vec` (brute-force KNN) with local ONNX embeddings (384 dimensions; `all-MiniLM-L6-v2` by default, configurable via `MEMORY_EMBED_MODEL`)
- Model downloads ~23MB on first startup (cached thereafter)
- LIKE substring search always runs; vector search adds supplementary semantic matches
- Set `MEMORY_VECTOR_SEARCH=off` to disable
- If the model fails to load, the system degrades gracefully to LIKE-only search

## Storage Backends

### SQLite (default, recommended)

SQLite is the default and recommended backend. Features: WAL mode, FK constraints, database-level deduplication, vector search, temporal versioning, schema migrations.

### JSONL (retired in v1.6.0)

The JSONL flat-file backend was deprecated since v1.0.0 and removed in v1.6.0. SQLite is now the only live backend. The one-time upgrade path remains: point `MEMORY_FILE_PATH` at an existing `.jsonl` file (or keep the same path across the upgrade) and the server migrates it into SQLite once. A `.jsonl` path with no file behind it errors, since there is nothing to migrate.

### Migration from JSONL

1. Change `MEMORY_FILE_PATH` to a `.db` path (or point it at your existing `.jsonl` — the server redirects to the sibling `.db`)
2. On first run, the server auto-migrates data from the `.jsonl` file into SQLite in a single transaction
3. The original JSONL file is renamed to `.jsonl.bak`

## Known Limitations

- **Entity names are globally unique** across all projects (relations use names as FK)
- **Project filtering is advisory**, not a security boundary
- **Paginated relations use either-endpoint semantics** — each page carries every relation touching one of its entities (the partner may be on another page; it's a name — `open_nodes` it for content). The deduped union across all pages is the complete active relation set
- **Vector search is best-effort** — degrades to LIKE-only if model/extension unavailable
- **vec0 is brute-force KNN** — fine at current scale, consider ANN at ~50,000+ observations
- **Context layers and memory types are caller-managed** — the server stores them but does not auto-classify

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation and the full limitations list.

## Development

```bash
npm test           # run tests (539 non-vector tests across 17 files, plus the opt-in 16-test vector-integration suite)
npm run test:watch # run tests in watch mode
npm run build      # compile TypeScript
npm run watch      # compile in watch mode
```

Set `SKIP_VECTOR_INTEGRATION=1` to skip the vector integration tests (which load the embedding model) for faster CI runs. The vector-integration suite should be run single-fork (it loads a real ONNX model) — see `MEMORY_VECTOR_SEARCH`/`SKIP_VECTOR_INTEGRATION` and the test-pool notes in CLAUDE.md.

## License

See [LICENSE](LICENSE) for the full text and original copyright notices. The upstream project is transitioning from MIT to Apache-2.0; documentation is licensed under CC-BY-4.0.
