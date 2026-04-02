# Project Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional project scoping to the knowledge graph so entities can be tagged to projects and queries can filter by project while including globals.

**Architecture:** Add a `project: string | null` field to entities (nullable TEXT column in SQLite, optional JSON field in JSONL). Modified `GraphStore` interface methods accept an optional `projectId` parameter. Project-scoped queries return project matches + globals. New `list_projects` tool returns distinct project names. `createEntities` returns `{ created, skipped }` to report cross-project name collisions.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Zod, MCP SDK

**Spec:** `docs/superpowers/specs/2026-04-02-project-filtering-design.md`

---

## File Structure

| File | Change | Responsibility |
|------|--------|---------------|
| `types.ts` | Modify | Add `project` to `Entity`, add `CreateEntitiesResult`/`SkippedEntity` types, update `GraphStore` interface |
| `jsonl-store.ts` | Modify | Add project field to load/save/create/search/read/open/list |
| `sqlite-store.ts` | Modify | Add project column migration, update queries for project filtering, add `listProjects` |
| `index.ts` | Modify | Add `projectId` to Zod schemas, normalize input, wire up `list_projects` tool, update `create_entities` response |
| `__tests__/knowledge-graph.test.ts` | Modify | Add parameterized project filtering tests to shared suite |

---

### Task 1: Update types and GraphStore interface

**Files:**
- Modify: `types.ts:9-85`

- [ ] **Step 1: Write the failing test**

Add a test in `__tests__/knowledge-graph.test.ts` inside the shared `describe.each` block that verifies entities have a `project` field:

```typescript
// Add inside the shared describe.each block, in the createEntities describe:
it('should set project to null when no projectId provided', async () => {
  const result = await store.createEntities([
    { name: 'GlobalEntity', entityType: 'test', observations: ['global obs'] },
  ]);
  expect(result.created).toHaveLength(1);
  expect(result.created[0].project).toBeNull();
  expect(result.skipped).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: TypeScript compilation errors -- `project` does not exist on `Entity`, `created`/`skipped` do not exist on return type.

- [ ] **Step 3: Update types.ts with new types and interface changes**

In `types.ts`, make these changes:

Add `project` to the `Entity` interface (after `observations`):

```typescript
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
  project: string | null;  // null = global, never undefined
}
```

Add new types after `AddObservationResult`:

```typescript
/** An entity that was skipped during createEntities because its name
 *  already exists (possibly in a different project). */
export type SkippedEntity = {
  name: string;
  existingProject: string | null;
};

/** Return type for createEntities. Reports both created entities and
 *  skipped duplicates with their owning project for collision feedback. */
export type CreateEntitiesResult = {
  created: Entity[];
  skipped: SkippedEntity[];
};
```

Update `GraphStore` interface -- change `createEntities` return type and add `projectId` parameters plus `listProjects`:

```typescript
export interface GraphStore {
  init(): Promise<void>;
  close(): Promise<void>;

  createEntities(entities: EntityInput[], projectId?: string): Promise<Readonly<CreateEntitiesResult>>;
  createRelations(relations: Relation[]): Promise<Readonly<Relation[]>>;
  addObservations(observations: AddObservationInput[]): Promise<Readonly<AddObservationResult[]>>;
  deleteEntities(entityNames: string[]): Promise<void>;
  deleteObservations(deletions: DeleteObservationInput[]): Promise<void>;
  deleteRelations(relations: Relation[]): Promise<void>;
  readGraph(projectId?: string): Promise<Readonly<KnowledgeGraph>>;
  searchNodes(query: string, projectId?: string): Promise<Readonly<KnowledgeGraph>>;
  openNodes(names: string[], projectId?: string): Promise<Readonly<KnowledgeGraph>>;
  listProjects(): Promise<string[]>;
}
```

- [ ] **Step 4: Run build to verify types compile**

Run: `npm run build 2>&1 | head -30`
Expected: Compilation errors in `jsonl-store.ts` and `sqlite-store.ts` because their implementations don't match the new interface yet. This confirms the interface changes propagate correctly.

- [ ] **Step 5: Commit**

```bash
git add types.ts __tests__/knowledge-graph.test.ts
git commit -m "feat: add project field to Entity type and update GraphStore interface"
```

---

### Task 2: Implement project filtering in JsonlStore

**Files:**
- Modify: `jsonl-store.ts:90-337`

- [ ] **Step 1: Write failing tests for project filtering**

Add these tests inside the shared `describe.each` block (they run against both stores). Place them in a new `describe('project filtering', ...)` block after the existing `openNodes` describe:

```typescript
describe('project filtering', () => {
  it('should tag entities with projectId on create', async () => {
    const result = await store.createEntities(
      [{ name: 'ProjectEntity', entityType: 'test', observations: ['obs1'] }],
      'my-project'
    );
    expect(result.created).toHaveLength(1);
    expect(result.created[0].project).toBe('my-project');
    expect(result.skipped).toHaveLength(0);
  });

  it('should set project to null when projectId omitted', async () => {
    const result = await store.createEntities([
      { name: 'GlobalEntity', entityType: 'test', observations: ['obs1'] },
    ]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].project).toBeNull();
  });

  it('should normalize projectId to lowercase and trimmed', async () => {
    const result = await store.createEntities(
      [{ name: 'NormEntity', entityType: 'test', observations: ['obs1'] }],
      '  My-Project  '
    );
    expect(result.created[0].project).toBe('my-project');
  });

  it('should report skipped entities with existing project info', async () => {
    await store.createEntities(
      [{ name: 'Shared', entityType: 'test', observations: ['obs1'] }],
      'project-a'
    );
    const result = await store.createEntities(
      [{ name: 'Shared', entityType: 'test', observations: ['obs2'] }],
      'project-b'
    );
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({ name: 'Shared', existingProject: 'project-a' });
  });

  it('should filter readGraph by project + globals', async () => {
    await store.createEntities(
      [{ name: 'A', entityType: 'test', observations: ['a'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'B', entityType: 'test', observations: ['b'] }],
      'proj-2'
    );
    await store.createEntities([
      { name: 'G', entityType: 'test', observations: ['global'] },
    ]);

    const filtered = await store.readGraph('proj-1');
    const names = filtered.entities.map(e => e.name).sort();
    expect(names).toEqual(['A', 'G']);
  });

  it('should return entire graph when readGraph has no projectId', async () => {
    await store.createEntities(
      [{ name: 'A', entityType: 'test', observations: ['a'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'B', entityType: 'test', observations: ['b'] }],
      'proj-2'
    );
    await store.createEntities([
      { name: 'G', entityType: 'test', observations: ['global'] },
    ]);

    const all = await store.readGraph();
    expect(all.entities).toHaveLength(3);
  });

  it('should filter searchNodes by project + globals', async () => {
    await store.createEntities(
      [{ name: 'Alpha', entityType: 'test', observations: ['shared keyword'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'Beta', entityType: 'test', observations: ['shared keyword'] }],
      'proj-2'
    );
    await store.createEntities([
      { name: 'Gamma', entityType: 'test', observations: ['shared keyword'] },
    ]);

    const result = await store.searchNodes('shared', 'proj-1');
    const names = result.entities.map(e => e.name).sort();
    expect(names).toEqual(['Alpha', 'Gamma']);
  });

  it('should search entire graph when searchNodes has no projectId', async () => {
    await store.createEntities(
      [{ name: 'Alpha', entityType: 'test', observations: ['keyword'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'Beta', entityType: 'test', observations: ['keyword'] }],
      'proj-2'
    );

    const result = await store.searchNodes('keyword');
    expect(result.entities).toHaveLength(2);
  });

  it('should filter openNodes by project + globals', async () => {
    await store.createEntities(
      [{ name: 'X', entityType: 'test', observations: ['x'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'Y', entityType: 'test', observations: ['y'] }],
      'proj-2'
    );
    await store.createEntities([
      { name: 'Z', entityType: 'test', observations: ['z'] },
    ]);

    const result = await store.openNodes(['X', 'Y', 'Z'], 'proj-1');
    const names = result.entities.map(e => e.name).sort();
    expect(names).toEqual(['X', 'Z']);
  });

  it('should return all requested entities when openNodes has no projectId', async () => {
    await store.createEntities(
      [{ name: 'X', entityType: 'test', observations: ['x'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'Y', entityType: 'test', observations: ['y'] }],
      'proj-2'
    );

    const result = await store.openNodes(['X', 'Y']);
    expect(result.entities).toHaveLength(2);
  });

  it('should only include relations where both endpoints are in the result set', async () => {
    await store.createEntities(
      [{ name: 'P1', entityType: 'test', observations: ['p1'] }],
      'proj-1'
    );
    await store.createEntities(
      [{ name: 'P2', entityType: 'test', observations: ['p2'] }],
      'proj-2'
    );
    await store.createEntities([
      { name: 'Global', entityType: 'test', observations: ['g'] },
    ]);
    await store.createRelations([
      { from: 'P1', to: 'Global', relationType: 'uses' },
      { from: 'P1', to: 'P2', relationType: 'cross_project' },
      { from: 'P2', to: 'Global', relationType: 'also_uses' },
    ]);

    const result = await store.readGraph('proj-1');
    expect(result.entities.map(e => e.name).sort()).toEqual(['Global', 'P1']);
    // Only P1->Global should be included (both endpoints in result set)
    // P1->P2 excluded (P2 not in result), P2->Global excluded (P2 not in result)
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toEqual(
      expect.objectContaining({ from: 'P1', to: 'Global', relationType: 'uses' })
    );
  });

  it('should list distinct project names sorted alphabetically', async () => {
    await store.createEntities(
      [{ name: 'A', entityType: 'test', observations: ['a'] }],
      'zebra'
    );
    await store.createEntities(
      [{ name: 'B', entityType: 'test', observations: ['b'] }],
      'alpha'
    );
    await store.createEntities([
      { name: 'C', entityType: 'test', observations: ['c'] },
    ]);

    const projects = await store.listProjects();
    expect(projects).toEqual(['alpha', 'zebra']);
  });

  it('should return empty array from listProjects on empty database', async () => {
    const projects = await store.listProjects();
    expect(projects).toEqual([]);
  });

  it('should persist project field across store restarts', async () => {
    await store.createEntities(
      [{ name: 'Persistent', entityType: 'test', observations: ['data'] }],
      'my-project'
    );

    await store.close();
    const store2 = createStore(storePath);
    await store2.init();
    const graph = await store2.readGraph();
    await store2.close();

    store = createStore(storePath);
    await store.init();

    expect(graph.entities[0].project).toBe('my-project');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: Compilation errors -- `JsonlStore.createEntities` doesn't accept `projectId`, doesn't return `CreateEntitiesResult`, `listProjects` doesn't exist.

- [ ] **Step 3: Implement project filtering in JsonlStore**

**3a. Update imports** -- add `SkippedEntity` and `CreateEntitiesResult` to the imports from `./types.js`:

```typescript
import {
  createObservation,
  type Observation,
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
  type SkippedEntity,
  type CreateEntitiesResult,
} from './types.js';
```

**3b. Update `loadGraph` to parse `project` field** -- in `jsonl-store.ts`, find the entity push block (line ~128) and add `project`:

```typescript
graph.entities.push({
  name: item.name,
  entityType: item.entityType,
  observations: (item.observations || []).map(normalizeObservation),
  project: typeof item.project === 'string' ? item.project : null,
});
```

**3c. Update `saveGraph` to serialize `project` field** -- in `jsonl-store.ts`, line ~166:

```typescript
...graph.entities.map(e => JSON.stringify({
  type: "entity", name: e.name, entityType: e.entityType,
  observations: e.observations, project: e.project
})),
```

**3d. Rewrite `createEntities`** -- replace the existing method (line ~188):

```typescript
async createEntities(entities: EntityInput[], projectId?: string): Promise<CreateEntitiesResult> {
  const graph = await this.loadGraph();
  const normalizedProject = projectId?.trim().toLowerCase() || null;

  const normalized: Entity[] = entities.map(e => ({
    name: e.name,
    entityType: e.entityType,
    observations: [...new Map(
      e.observations.map(obs => {
        const o = typeof obs === 'string' ? createObservation(obs) : obs;
        return [o.content, o] as const;
      })
    ).values()],
    project: normalizedProject,
  }));

  // Build a map of existing entity names to their project for collision reporting
  const existingEntityMap = new Map(graph.entities.map(e => [e.name, e.project]));
  const created: Entity[] = [];
  const skipped: SkippedEntity[] = [];

  for (const e of normalized) {
    if (existingEntityMap.has(e.name)) {
      skipped.push({ name: e.name, existingProject: existingEntityMap.get(e.name)! });
    } else {
      existingEntityMap.set(e.name, e.project);
      created.push(e);
    }
  }

  graph.entities.push(...created);
  await this.saveGraph(graph);
  return { created, skipped };
}
```

**3e. Update `readGraph`** -- replace the existing method (line ~298):

```typescript
async readGraph(projectId?: string): Promise<KnowledgeGraph> {
  const graph = await this.loadGraph();
  if (!projectId) return graph;

  const normalizedProject = projectId.trim().toLowerCase();
  const filteredEntities = graph.entities.filter(e =>
    e.project === normalizedProject || e.project === null
  );
  const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  const filteredRelations = graph.relations.filter(r =>
    filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
  );
  return { entities: filteredEntities, relations: filteredRelations };
}
```

**3f. Update `searchNodes`** -- replace the existing method (line ~308):

```typescript
async searchNodes(query: string, projectId?: string): Promise<KnowledgeGraph> {
  const graph = await this.loadGraph();
  const lowerQuery = query.toLowerCase();
  const normalizedProject = projectId?.trim().toLowerCase();

  let filteredEntities = graph.entities.filter(e =>
    e.name.toLowerCase().includes(lowerQuery) ||
    e.entityType.toLowerCase().includes(lowerQuery) ||
    e.observations.some(o => o.content.toLowerCase().includes(lowerQuery))
  );

  if (normalizedProject) {
    filteredEntities = filteredEntities.filter(e =>
      e.project === normalizedProject || e.project === null
    );
  }

  const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  const filteredRelations = graph.relations.filter(r =>
    filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
  );
  return { entities: filteredEntities, relations: filteredRelations };
}
```

**3g. Update `openNodes`** -- replace the existing method (line ~327):

```typescript
async openNodes(names: string[], projectId?: string): Promise<KnowledgeGraph> {
  const graph = await this.loadGraph();
  const nameSet = new Set(names);
  const normalizedProject = projectId?.trim().toLowerCase();

  let filteredEntities = graph.entities.filter(e => nameSet.has(e.name));

  if (normalizedProject) {
    filteredEntities = filteredEntities.filter(e =>
      e.project === normalizedProject || e.project === null
    );
  }

  const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  const filteredRelations = graph.relations.filter(r =>
    filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
  );
  return { entities: filteredEntities, relations: filteredRelations };
}
```

**3h. Add `listProjects`** -- add after `openNodes`:

```typescript
async listProjects(): Promise<string[]> {
  const graph = await this.loadGraph();
  const projects = new Set<string>();
  for (const e of graph.entities) {
    if (e.project !== null) projects.add(e.project);
  }
  return [...projects].sort();
}
```

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -30`
Expected: JsonlStore tests should pass for project filtering. SqliteStore tests will still fail (not yet updated).

- [ ] **Step 5: Commit**

```bash
git add types.ts jsonl-store.ts __tests__/knowledge-graph.test.ts
git commit -m "feat: add project filtering to JsonlStore with collision reporting"
```

---

### Task 3: Implement project filtering in SqliteStore

**Files:**
- Modify: `sqlite-store.ts:64-547`

- [ ] **Step 1: Update imports**

Add `SkippedEntity` and `CreateEntitiesResult` to the imports from `./types.js`:

```typescript
import {
  createObservation,
  type Observation,
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
  type SkippedEntity,
  type CreateEntitiesResult,
} from './types.js';
```

- [ ] **Step 2: Add project column to schema and migration**

Update the `CREATE TABLE entities` statement in `init()` to include `project` for fresh databases:

```sql
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  project     TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
```

After the `CREATE TABLE` block, add the migration check for existing databases:

```typescript
// Migrate: add project column if upgrading from pre-Phase-3 schema
const columns = this.db.pragma('table_info(entities)') as { name: string }[];
const hasProject = columns.some(c => c.name === 'project');
if (!hasProject) {
  this.db.exec(`
    ALTER TABLE entities ADD COLUMN project TEXT;
    CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
  `);
}
```

- [ ] **Step 3: Update createEntities**

Replace the existing `createEntities` method (line ~227):

```typescript
async createEntities(entities: EntityInput[], projectId?: string): Promise<CreateEntitiesResult> {
  const normalizedProject = projectId?.trim().toLowerCase() || null;

  const insertEntity = this.db.prepare(
    'INSERT OR IGNORE INTO entities (name, entity_type, project) VALUES (?, ?, ?)'
  );
  const getEntityId = this.db.prepare(
    'SELECT id FROM entities WHERE name = ?'
  );
  const getEntityProject = this.db.prepare(
    'SELECT project FROM entities WHERE name = ?'
  );
  const insertObs = this.db.prepare(
    'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
  );

  const created: Entity[] = [];
  const skipped: SkippedEntity[] = [];

  const txn = this.db.transaction(() => {
    for (const e of entities) {
      const info = insertEntity.run(e.name, e.entityType, normalizedProject);
      if (info.changes === 0) {
        // Entity already exists -- report which project owns it
        const existing = getEntityProject.get(e.name) as { project: string | null } | undefined;
        skipped.push({ name: e.name, existingProject: existing?.project ?? null });
        continue;
      }

      const row = getEntityId.get(e.name) as { id: number };
      const observations: Observation[] = [];

      for (const obs of e.observations) {
        const o = typeof obs === 'string' ? createObservation(obs) : obs;
        const obsInfo = insertObs.run(row.id, o.content, o.createdAt);
        if (obsInfo.changes > 0) {
          observations.push(o);
        }
      }

      created.push({ name: e.name, entityType: e.entityType, observations, project: normalizedProject });
    }
  });
  txn();

  return { created, skipped };
}
```

- [ ] **Step 4: Update buildEntities to include project**

In `buildEntities` (line ~407), update the parameter type and return mapping:

```typescript
private buildEntities(entityRows: { name: string; entityType: string; project: string | null }[]): Entity[] {
  if (entityRows.length === 0) return [];

  const names = entityRows.map(e => e.name);

  const obsMap = new Map<string, Observation[]>();
  for (let i = 0; i < names.length; i += CHUNK_SIZE) {
    const chunk = names.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');

    const obsRows = this.db.prepare(`
      SELECT e.name AS entityName, o.content, o.created_at AS createdAt
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.name IN (${placeholders})
    `).all(...chunk) as { entityName: string; content: string; createdAt: string }[];

    for (const o of obsRows) {
      if (!obsMap.has(o.entityName)) obsMap.set(o.entityName, []);
      obsMap.get(o.entityName)!.push({ content: o.content, createdAt: o.createdAt });
    }
  }

  return entityRows.map(e => ({
    name: e.name,
    entityType: e.entityType,
    observations: obsMap.get(e.name) || [],
    project: e.project,
  }));
}
```

- [ ] **Step 5: Update getConnectedRelations to support both-endpoints mode**

Replace the existing `getConnectedRelations` (line ~447):

```typescript
private getConnectedRelations(entityNames: string[], bothEndpoints: boolean = false): Relation[] {
  if (entityNames.length === 0) return [];

  const entityNameSet = bothEndpoints ? new Set(entityNames) : null;
  const halfChunk = Math.floor(CHUNK_SIZE / 2);
  const results: Relation[] = [];

  for (let i = 0; i < entityNames.length; i += halfChunk) {
    const chunk = entityNames.slice(i, i + halfChunk);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType
      FROM relations
      WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})
    `).all(...chunk, ...chunk) as Relation[];
    results.push(...rows);
  }

  // Deduplicate cross-chunk results
  const seen = new Set<string>();
  const deduped = results.filter(r => {
    const key = JSON.stringify([r.from, r.to, r.relationType]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // If bothEndpoints is true, filter to relations where BOTH endpoints are in the set
  if (entityNameSet) {
    return deduped.filter(r => entityNameSet.has(r.from) && entityNameSet.has(r.to));
  }
  return deduped;
}
```

- [ ] **Step 6: Update readGraph with project filtering**

Replace the existing `readGraph` (line ~481):

```typescript
async readGraph(projectId?: string): Promise<KnowledgeGraph> {
  let entityRows: { name: string; entityType: string; project: string | null }[];

  if (projectId) {
    const normalizedProject = projectId.trim().toLowerCase();
    entityRows = this.db.prepare(
      'SELECT name, entity_type AS entityType, project FROM entities WHERE project = ? OR project IS NULL'
    ).all(normalizedProject) as { name: string; entityType: string; project: string | null }[];
  } else {
    entityRows = this.db.prepare(
      'SELECT name, entity_type AS entityType, project FROM entities'
    ).all() as { name: string; entityType: string; project: string | null }[];
  }

  const entities = this.buildEntities(entityRows);
  const entityNames = entityRows.map(e => e.name);

  let relations: Relation[];
  if (projectId) {
    relations = this.getConnectedRelations(entityNames, true);
  } else {
    relations = this.db.prepare(
      'SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType FROM relations'
    ).all() as Relation[];
  }

  return { entities, relations };
}
```

- [ ] **Step 7: Update searchNodes with project filtering**

Replace the existing `searchNodes` (line ~505):

```typescript
async searchNodes(query: string, projectId?: string): Promise<KnowledgeGraph> {
  const escaped = escapeLike(query);
  const pattern = `%${escaped}%`;
  const normalizedProject = projectId?.trim().toLowerCase();

  let entityRows: { name: string; entityType: string; project: string | null }[];

  if (normalizedProject) {
    entityRows = this.db.prepare(`
      SELECT DISTINCT e.name, e.entity_type AS entityType, e.project
      FROM entities e
      LEFT JOIN observations o ON o.entity_id = e.id
      WHERE (e.project = ? OR e.project IS NULL)
        AND (e.name LIKE ? ESCAPE '\\' OR e.entity_type LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\')
    `).all(normalizedProject, pattern, pattern, pattern) as { name: string; entityType: string; project: string | null }[];
  } else {
    entityRows = this.db.prepare(`
      SELECT DISTINCT e.name, e.entity_type AS entityType, e.project
      FROM entities e
      LEFT JOIN observations o ON o.entity_id = e.id
      WHERE e.name LIKE ? ESCAPE '\\' OR e.entity_type LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\'
    `).all(pattern, pattern, pattern) as { name: string; entityType: string; project: string | null }[];
  }

  const entities = this.buildEntities(entityRows);
  const bothEndpoints = !!normalizedProject;
  const relations = this.getConnectedRelations(entityRows.map(e => e.name), bothEndpoints);

  return { entities, relations };
}
```

- [ ] **Step 8: Update openNodes with project filtering**

Replace the existing `openNodes` (line ~535):

```typescript
async openNodes(names: string[], projectId?: string): Promise<KnowledgeGraph> {
  if (names.length === 0) return { entities: [], relations: [] };

  const normalizedProject = projectId?.trim().toLowerCase();
  const placeholders = names.map(() => '?').join(',');

  let entityRows: { name: string; entityType: string; project: string | null }[];

  if (normalizedProject) {
    entityRows = this.db.prepare(
      `SELECT name, entity_type AS entityType, project FROM entities WHERE name IN (${placeholders}) AND (project = ? OR project IS NULL)`
    ).all(...names, normalizedProject) as { name: string; entityType: string; project: string | null }[];
  } else {
    entityRows = this.db.prepare(
      `SELECT name, entity_type AS entityType, project FROM entities WHERE name IN (${placeholders})`
    ).all(...names) as { name: string; entityType: string; project: string | null }[];
  }

  const entities = this.buildEntities(entityRows);
  const bothEndpoints = !!normalizedProject;
  const relations = this.getConnectedRelations(entityRows.map(e => e.name), bothEndpoints);

  return { entities, relations };
}
```

- [ ] **Step 9: Add listProjects method**

Add after `openNodes`:

```typescript
async listProjects(): Promise<string[]> {
  const rows = this.db.prepare(
    'SELECT DISTINCT project FROM entities WHERE project IS NOT NULL ORDER BY project'
  ).all() as { project: string }[];
  return rows.map(r => r.project);
}
```

- [ ] **Step 10: Update migrateFromJsonl to copy project field**

In the `migrateFromJsonl` method, update the entity INSERT prepared statement:

```typescript
const insertEntity = this.db.prepare(
  'INSERT OR IGNORE INTO entities (name, entity_type, project) VALUES (?, ?, ?)'
);
```

And update the insert call:

```typescript
insertEntity.run(entity.name, entity.entityType, entity.project ?? null);
```

- [ ] **Step 11: Run all tests**

Run: `npm test 2>&1`
Expected: All project filtering tests pass for both JsonlStore and SqliteStore. All existing tests pass.

- [ ] **Step 12: Commit**

```bash
git add sqlite-store.ts
git commit -m "feat: add project filtering to SqliteStore with migration and collision reporting"
```

---

### Task 4: Fix existing tests for new createEntities return type

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts`

The existing tests call `store.createEntities()` and expect it to return `Entity[]`. Now it returns `CreateEntitiesResult` (`{ created, skipped }`). All existing tests that check the return value of `createEntities` must be updated.

- [ ] **Step 1: Update all existing createEntities test assertions**

Find every test that assigns the result of `store.createEntities(...)` to a variable and update using destructuring:

**Pattern:** Replace `const newEntities = await store.createEntities(...)` with `const { created: newEntities } = await store.createEntities(...)`

Key tests to update (search for `await store.createEntities` in the test file where the return value is assigned):

- `'should create new entities'` -- destructure to `{ created: newEntities }`
- `'should not create duplicate entities'` -- destructure to `{ created: newEntities }`
- `'should handle empty entity arrays'` -- destructure to `{ created: newEntities }`
- `'should deduplicate entities within the same batch'` -- destructure to `{ created: newEntities }`
- `'should deduplicate observations within a single entity'` -- destructure to `{ created: newEntities }`
- Any other test that checks the return value of `createEntities`

Tests that call `store.createEntities(...)` as setup (not checking the return value) don't need changes.

- [ ] **Step 2: Run all tests**

Run: `npm test 2>&1`
Expected: All tests pass (129+ existing tests plus ~15 new project filtering tests).

- [ ] **Step 3: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "fix: update existing tests for new createEntities return type"
```

---

### Task 5: Add SQLite-specific migration test

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts`

- [ ] **Step 1: Add migration test in the SQLite-specific section**

Find the `describe('SqliteStore-specific', ...)` section and add:

```typescript
it('should migrate existing database by adding project column', async () => {
  // Create a store and add an entity (simulates pre-Phase-3 database)
  const migrationPath = path.join(testDir, `test-migration-project-${Date.now()}.db`);
  const store1 = new SqliteStore(migrationPath);
  await store1.init();
  await store1.createEntities([
    { name: 'OldEntity', entityType: 'test', observations: ['old data'] },
  ]);
  await store1.close();

  // Re-open -- init() should detect missing project column and add it
  const store2 = new SqliteStore(migrationPath);
  await store2.init();

  const graph = await store2.readGraph();
  expect(graph.entities[0].project).toBeNull();

  // Verify new entities can be created with project
  await store2.createEntities(
    [{ name: 'NewEntity', entityType: 'test', observations: ['new data'] }],
    'test-project'
  );
  const graph2 = await store2.readGraph('test-project');
  const names = graph2.entities.map(e => e.name).sort();
  expect(names).toEqual(['NewEntity', 'OldEntity']); // OldEntity is global, included

  await store2.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { await fs.unlink(migrationPath + suffix); } catch { /* ignore */ }
  }
});
```

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1`
Expected: All tests pass including the new migration test.

- [ ] **Step 3: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "test: add SQLite migration test for project column"
```

---

### Task 6: Update MCP tool registrations in index.ts

**Files:**
- Modify: `index.ts:77-276`

- [ ] **Step 1: Update EntityOutputSchema to include project**

In `index.ts`, update the `EntityOutputSchema` (line ~93):

```typescript
const EntityOutputSchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(ObservationSchema).describe("An array of observations with content and timestamps"),
  project: z.string().nullable().describe("Project this entity belongs to, or null for global"),
});
```

- [ ] **Step 2: Add projectId Zod schema constant and normalizeProjectId helper**

After `RelationSchema` (line ~103), add:

```typescript
const ProjectIdSchema = z.string().min(1).max(500)
  .describe("Project scope for filtering. Omit for global/unscoped.")
  .optional();

/**
 * Normalizes a projectId input: trims whitespace, lowercases, and converts
 * empty/undefined to undefined (so the store treats it as global).
 * Called in tool handlers before passing to store methods.
 */
function normalizeProjectId(projectId?: string): string | undefined {
  if (!projectId) return undefined;
  const normalized = projectId.trim().toLowerCase();
  return normalized || undefined;
}
```

- [ ] **Step 3: Add SkippedEntity output schema**

After `ProjectIdSchema`, add:

```typescript
const SkippedEntitySchema = z.object({
  name: z.string(),
  existingProject: z.string().nullable(),
});
```

- [ ] **Step 4: Update create_entities tool**

Replace the `create_entities` tool registration (line ~110):

```typescript
server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntityInputSchema).max(100),
      projectId: ProjectIdSchema,
    },
    outputSchema: {
      created: z.array(EntityOutputSchema),
      skipped: z.array(SkippedEntitySchema),
    }
  },
  async ({ entities, projectId }) => {
    const result = await store.createEntities(entities, normalizeProjectId(projectId));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { created: result.created, skipped: result.skipped }
    };
  }
);
```

- [ ] **Step 5: Update read_graph tool**

Replace the `read_graph` tool registration (line ~227):

```typescript
server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: { projectId: ProjectIdSchema },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async ({ projectId }) => {
    const graph = await store.readGraph(normalizeProjectId(projectId));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);
```

- [ ] **Step 6: Update search_nodes tool**

Replace the `search_nodes` tool registration (line ~244):

```typescript
server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: {
      query: z.string().min(1).max(5000).describe("The search query to match against entity names, types, and observation content"),
      projectId: ProjectIdSchema,
    },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async ({ query, projectId }) => {
    const graph = await store.searchNodes(query, normalizeProjectId(projectId));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);
```

- [ ] **Step 7: Update open_nodes tool**

Replace the `open_nodes` tool registration (line ~261):

```typescript
server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string().min(1).max(500)).max(100).describe("An array of entity names to retrieve"),
      projectId: ProjectIdSchema,
    },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async ({ names, projectId }) => {
    const graph = await store.openNodes(names, normalizeProjectId(projectId));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);
```

- [ ] **Step 8: Add list_projects tool**

After the `open_nodes` registration, add:

```typescript
server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List all project names in the knowledge graph",
    inputSchema: {},
    outputSchema: { projects: z.array(z.string()) }
  },
  async () => {
    const projects = await store.listProjects();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(projects, null, 2) }],
      structuredContent: { projects }
    };
  }
);
```

- [ ] **Step 9: Update re-exports**

Update the re-exports (line ~70) to include the new types:

```typescript
export { type Observation, type Entity, type Relation, type KnowledgeGraph, type CreateEntitiesResult, type SkippedEntity } from './types.js';
```

- [ ] **Step 10: Bump version**

Update the server version (line ~107):

```typescript
const server = new McpServer({
  name: "memory-server",
  version: "0.9.0",
});
```

- [ ] **Step 11: Build and test**

Run: `npm run build && npm test 2>&1`
Expected: Build succeeds, all tests pass.

- [ ] **Step 12: Commit**

```bash
git add index.ts
git commit -m "feat: add projectId to MCP tools and register list_projects tool"
```

---

### Task 7: Update CLAUDE.md and bump package version

**Files:**
- Modify: `CLAUDE.md`
- Modify: `package.json`

- [ ] **Step 1: Update CLAUDE.md architecture section**

Update the architecture section to document project filtering. Key additions:

- Under `types.ts`: mention `project: string | null` on Entity, `CreateEntitiesResult`, `SkippedEntity` types
- Under `index.ts`: mention `projectId` parameter on tools, `normalizeProjectId()` helper, `list_projects` tool
- Under `sqlite-store.ts`: mention `project TEXT` column, migration via `table_info` pragma, `idx_entities_project` index
- Under `jsonl-store.ts`: mention optional `project` field on entity lines
- Under Known Limitations: add that entity names are globally unique across projects (permanent constraint due to relation FK design)
- Update Planned Phases: mark Phase 3 as DONE, keep Phase 4

- [ ] **Step 2: Bump package.json version**

Update `version` in `package.json` from `"0.8.0"` to `"0.9.0"`.

- [ ] **Step 3: Run build and tests one final time**

Run: `npm run build && npm test 2>&1`
Expected: All tests pass, build clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md package.json
git commit -m "docs: update CLAUDE.md for Phase 3, bump version to 0.9.0"
```
