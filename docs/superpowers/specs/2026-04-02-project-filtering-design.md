# Phase 3: Project Filtering — Design Spec

## Goal

Scope entities to projects so multi-project memory stays clean, while preserving cross-project and global (unscoped) access.

## Core Decisions

- **Approach:** Optional `projectId` parameter on existing tools (Approach A from brainstorming)
- **Cardinality:** Each entity belongs to exactly one project, or is global (null). No multi-tagging.
- **Query behavior:** Project-scoped queries return project matches + globals. Unscoped queries return everything.
- **Naming:** Server-side normalization (lowercase, trim). Client-side CLAUDE.md conventions. `list_projects` tool for discovery.
- **Migration:** Additive. All existing entities become global (null). Zero breaking changes.

---

## Data Model

### SQLite

Add a nullable `project` column to the `entities` table:

```sql
ALTER TABLE entities ADD COLUMN project TEXT;
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
```

All existing rows get `NULL` (global). New entities are tagged with the client-provided `projectId` or `NULL` if omitted.

No changes to `observations` or `relations` tables. Observations inherit project scope through their `entity_id` FK to `entities`. Relations inherit scope through their `from_entity`/`to_entity` FKs to `entities.name`.

No separate `projects` table. Project identity is the normalized name string stored directly on `entities.project`. `list_projects` is `SELECT DISTINCT project FROM entities WHERE project IS NOT NULL`.

### JSONL

Each entity line gains an optional `"project"` field:

```json
{"type":"entity","name":"Foo","entityType":"bar","observations":[...],"project":"mcp-memory-server"}
```

Omitted or `null` means global. Parsed on load, written on save. No migration needed — existing lines without the field are global by default.

### Normalization

Project names are normalized before reaching the store:

- `trim()` — strip leading/trailing whitespace
- `toLowerCase()` — case-insensitive matching

Applied in the MCP tool handlers (index.ts), so both backends receive clean input. Empty string after trim is treated as `null` (global).

---

## GraphStore Interface Changes

### Modified Methods

```typescript
createEntities(entities: EntityInput[], projectId?: string): Promise<Readonly<Entity[]>>;
readGraph(projectId?: string): Promise<Readonly<KnowledgeGraph>>;
searchNodes(query: string, projectId?: string): Promise<Readonly<KnowledgeGraph>>;
openNodes(names: string[], projectId?: string): Promise<Readonly<KnowledgeGraph>>;
```

### New Method

```typescript
listProjects(): Promise<string[]>;
```

Returns distinct non-null project names currently in the database, sorted alphabetically.

### Unchanged Methods

These operate by exact entity name (globally unique) and don't need project scoping:

- `createRelations(relations)` — relations connect named entities; project affinity is inherited
- `addObservations(observations)` — targets entities by name
- `deleteEntities(entityNames)` — deletes by name
- `deleteObservations(deletions)` — targets entities by name
- `deleteRelations(relations)` — deletes by exact match on all three fields

---

## Query Semantics

### With `projectId` provided

| Operation | Behavior |
|-----------|----------|
| `create_entities` | New entities tagged with this project |
| `read_graph` | Returns entities where `project = :id OR project IS NULL`, plus relations with at least one endpoint in that set |
| `search_nodes` | Filters search results to entities in this project + globals, plus connected relations |
| `open_nodes` | Returns requested entities only if they belong to this project or are global, plus connected relations |

### Without `projectId` (omitted or null)

| Operation | Behavior |
|-----------|----------|
| `create_entities` | New entities are global (`project = NULL`) |
| `read_graph` | Returns the entire graph (all projects + globals) |
| `search_nodes` | Searches the entire graph |
| `open_nodes` | Returns all requested entities regardless of project |

This is identical to current behavior — full backward compatibility.

---

## MCP Tool Schema Changes

### Modified tools

Each gains an optional `projectId` parameter:

```typescript
projectId: z.string().min(1).max(500)
  .describe("Project scope for filtering. Omit for global/unscoped.")
  .optional()
```

Tools modified: `create_entities`, `read_graph`, `search_nodes`, `open_nodes`.

### New tool: list_projects

```typescript
server.registerTool("list_projects", {
  title: "List Projects",
  description: "List all project names in the knowledge graph",
  inputSchema: {},
  outputSchema: { projects: z.array(z.string()) }
}, async () => { ... });
```

### Entity output schema

Add `project` to the entity output schema:

```typescript
const EntityOutputSchema = z.object({
  name: z.string(),
  entityType: z.string(),
  observations: z.array(ObservationSchema),
  project: z.string().nullable().describe("Project this entity belongs to, or null for global"),
});
```

---

## Migration

### SQLite

On `init()`, detect whether the `project` column exists:

```typescript
const columns = this.db.pragma('table_info(entities)') as { name: string }[];
const hasProject = columns.some(c => c.name === 'project');
if (!hasProject) {
  this.db.exec(`
    ALTER TABLE entities ADD COLUMN project TEXT;
    CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
  `);
}
```

All existing rows get `NULL` (global). No data transformation.

### JSONL

No migration step. Missing `"project"` field is treated as `null` on load.

### JSONL-to-SQLite auto-migration

The existing `migrateFromJsonl()` in `SqliteStore` copies entities from JSONL into SQLite. It must also copy the `project` field if present on the JSONL entity.

---

## CLAUDE.md Conventions

Applied after Phase 3 implementation is complete and tools accept `projectId`.

### ~/Claude/CLAUDE.md (global)

```markdown
## Memory Server Project Naming
When using the memory MCP server's project-scoped tools, always pass the
project directory name (the folder under ~/Claude/) as the projectId,
lowercased. Example: working in ~/Claude/mcp-memory-server/ -> projectId
"mcp-memory-server". If unsure, call list_projects first to see existing
project names. Omit projectId for memories that aren't project-specific
(user preferences, system setup, workflow rules).
```

### Per-project CLAUDE.md

Each project adds:

```markdown
## Project Name
projectId for memory server: `<project-directory-name>`
```

---

## Entity Type Changes

The `Entity` interface gains an optional `project` field:

```typescript
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
  project?: string | null;  // null or undefined = global
}
```

`EntityInput` does NOT gain a project field. The `projectId` is passed as a separate parameter to `createEntities()`, not per-entity. This keeps the API clean — all entities in a single `create_entities` call share the same project scope. The `Entity` output type has `project` because it reflects what's stored.

---

## Test Plan

New test cases added to the existing parameterized suite (`describe.each` across both stores):

- Create entities with projectId, verify project is stored
- Create entities without projectId, verify project is null
- `search_nodes` with projectId returns project matches + globals, not other projects
- `search_nodes` without projectId returns everything
- `read_graph` with projectId returns project entities + globals
- `read_graph` without projectId returns everything
- `open_nodes` with projectId returns only matching/global entities
- `open_nodes` without projectId returns all requested entities
- `list_projects` returns distinct project names, sorted, excludes null
- `list_projects` on empty database returns empty array
- Normalization: uppercase/whitespace projectId is lowercased/trimmed
- Empty string projectId after trim is treated as global (null)
- Relations are included when at least one endpoint is in the filtered entity set
- Existing tests pass unchanged (backward compatibility)

SQLite-specific:
- Migration adds `project` column to existing database
- Index `idx_entities_project` is created

---

## Known Limitations

- Entity names remain globally unique across all projects. Two projects cannot have entities with the same name. This is consistent with the existing UNIQUE constraint and avoids ambiguity in relation endpoints.
- No tool for changing an entity's project after creation. If needed, delete and recreate. This avoids partial-update complexity.
- JSONL backend: no index on project — filtering is a linear scan (consistent with all other JSONL operations).

---

## Out of Scope

- **Pagination** — Phase 4, designed independently
- **Per-entity projectId in create_entities** — all entities in a batch share the same projectId. Per-entity scoping adds complexity with no clear use case.
- **Project metadata** — no descriptions, owners, or timestamps on projects themselves. Projects are just name strings.
