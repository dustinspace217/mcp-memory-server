# Phase 4: Cursor-Based Pagination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cursor-based pagination to `read_graph` and `search_nodes` so memory retrieval fits inside Claude's context windows, reducing drift across sessions.

**Architecture:** Keyset pagination on `(updated_at DESC, id DESC)` with opaque base64-encoded cursors. Both backends (SQLite and JSONL) implement identical pagination behavior. Default page size of 40 entities, max 100. Entity timestamps (`updatedAt`, `createdAt`) track when entities were last modified for recency-based ordering.

**Tech Stack:** TypeScript, better-sqlite3, Zod, Vitest, Node.js Buffer API for base64 encoding

**Design spec:** `docs/superpowers/specs/2026-04-02-pagination-design.md`

---

## File Map

| File | Role | Changes |
|---|---|---|
| `types.ts` | Shared types and interfaces | Add `updatedAt`/`createdAt` to `Entity`, add `PaginationParams`, `PaginatedKnowledgeGraph`, `InvalidCursorError`, update `GraphStore` signatures |
| `sqlite-store.ts` | SQLite storage backend | Schema migration (columns + indexes + backfill), update write paths, implement keyset pagination in `readGraph`/`searchNodes` |
| `jsonl-store.ts` | JSONL storage backend | Read/write timestamps, update write paths, implement in-memory pagination in `readGraph`/`searchNodes` |
| `index.ts` | MCP server entry point | Update Zod schemas, tool descriptions, tool handlers to pass pagination params and return pagination metadata |
| `__tests__/knowledge-graph.test.ts` | Parameterized test suite | Entity timestamp tests, pagination tests (both backends) |

---

### Task 1: Add Entity Timestamps to types.ts

**Files:**
- Modify: `types.ts`

This task adds `updatedAt` and `createdAt` to the `Entity` interface and adds the `ENTITY_TIMESTAMP_SENTINEL` constant. No pagination types yet — just the entity-level timestamp foundation.

- [ ] **Step 1: Add sentinel constant and update Entity interface**

In `types.ts`, add the sentinel constant after the existing imports/types, and add the two new fields to `Entity`:

```typescript
// Add after the Observation interface (around line 12):

/**
 * Sentinel value for entity timestamps on legacy data that predates Phase 4.
 * Sorts last in DESC ordering (lexicographically before any real ISO 8601 timestamp).
 * Chosen over empty string to be self-documenting and avoid semantic collision.
 */
export const ENTITY_TIMESTAMP_SENTINEL = '0000-00-00T00:00:00.000Z';
```

Update the `Entity` interface to add `updatedAt` and `createdAt` after the `project` field:

```typescript
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
  project: string | null;  // null = global, never undefined
  updatedAt: string;       // ISO 8601 UTC, or ENTITY_TIMESTAMP_SENTINEL for legacy data
  createdAt: string;       // ISO 8601 UTC, or ENTITY_TIMESTAMP_SENTINEL for legacy data
}
```

- [ ] **Step 2: Run tests to see what breaks**

Run: `npm test 2>&1 | head -80`

Expected: Multiple test failures — existing code creates Entity objects without `updatedAt`/`createdAt` fields. This confirms the type change is propagating correctly. Don't fix anything yet — just verify the breakage pattern.

- [ ] **Step 3: Commit**

```bash
git add types.ts
git commit -m "feat(types): add updatedAt/createdAt to Entity interface"
```

---

### Task 2: Update SqliteStore for Entity Timestamps

**Files:**
- Modify: `sqlite-store.ts`

This task adds the `updated_at` and `created_at` columns to the SQLite schema, handles migration (column addition + backfill from observations), updates all write paths to set timestamps, and updates `buildEntities` to include the new fields in returned Entity objects.

- [ ] **Step 1: Add schema migration in init()**

In `sqlite-store.ts`, after the existing project column migration block (around line 147), add migration for the timestamp columns. Use the same `pragma('table_info(entities)')` pattern:

```typescript
// Add after the existing project column migration block:

// Migrate: add updated_at and created_at columns if upgrading from pre-Phase-4 schema.
const hasUpdatedAt = columns.some(c => c.name === 'updated_at');
if (!hasUpdatedAt) {
  this.db.exec(`
    ALTER TABLE entities ADD COLUMN updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}';
    ALTER TABLE entities ADD COLUMN created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}';
  `);
  // Backfill updated_at from the most recent observation timestamp.
  // Entities with no valid observation timestamps keep the sentinel value.
  this.db.exec(`
    UPDATE entities SET updated_at = (
      SELECT MAX(created_at) FROM observations
      WHERE entity_id = entities.id AND created_at != 'unknown'
    )
    WHERE updated_at = '${ENTITY_TIMESTAMP_SENTINEL}' AND EXISTS (
      SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
    );
  `);
  // Also backfill created_at from the earliest observation timestamp
  this.db.exec(`
    UPDATE entities SET created_at = (
      SELECT MIN(created_at) FROM observations
      WHERE entity_id = entities.id AND created_at != 'unknown'
    )
    WHERE created_at = '${ENTITY_TIMESTAMP_SENTINEL}' AND EXISTS (
      SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
    );
  `);
}
```

Add the `ENTITY_TIMESTAMP_SENTINEL` import at the top of the file:

```typescript
import {
  createObservation,
  ENTITY_TIMESTAMP_SENTINEL,
  // ... existing imports ...
} from './types.js';
```

- [ ] **Step 2: Add pagination indexes in init()**

After the existing index creation block (around line 155), add the pagination indexes:

```typescript
// Pagination indexes for keyset queries on (updated_at DESC, id DESC).
// The composite index with project as leftmost column supports project-scoped reads.
// The standalone index supports unscoped reads.
this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_project_updated ON entities(project, updated_at DESC, id DESC);');
this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC, id DESC);');
```

- [ ] **Step 3: Update createEntities to set timestamps**

In `createEntities` (around line 260), update the INSERT statement and the Entity object construction to include timestamps:

Change the prepared statement from:
```typescript
const insertEntity = this.db.prepare(
  'INSERT OR IGNORE INTO entities (name, entity_type, project) VALUES (?, ?, ?)'
);
```

To:
```typescript
const now = new Date().toISOString();
const insertEntity = this.db.prepare(
  'INSERT OR IGNORE INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, ?, ?, ?)'
);
```

Update the `insertEntity.run` call from:
```typescript
const info = insertEntity.run(e.name, e.entityType, normalizedProject);
```

To:
```typescript
const info = insertEntity.run(e.name, e.entityType, normalizedProject, now, now);
```

Update the Entity construction at the end of the loop to include timestamps:
```typescript
created.push({ name: e.name, entityType: e.entityType, observations, project: normalizedProject, updatedAt: now, createdAt: now });
```

- [ ] **Step 4: Update addObservations to bump updated_at**

In `addObservations` (around line 356), add a prepared statement to update the entity's `updated_at` after inserting observations. Add this after the existing `findEntity` and `insertObs` statements:

```typescript
const updateTimestamp = this.db.prepare(
  'UPDATE entities SET updated_at = ? WHERE id = ?'
);
```

Inside the transaction loop, after the observation insertion loop for each entity, add:

```typescript
// Bump the entity's updated_at if any observations were actually added
if (addedObservations.length > 0) {
  updateTimestamp.run(new Date().toISOString(), row.id);
}
```

- [ ] **Step 5: Update deleteObservations to bump updated_at**

In `deleteObservations` (around line 411), add the same timestamp update pattern. Add after the existing `findEntity` and `delObs` statements:

```typescript
const updateTimestamp = this.db.prepare(
  'UPDATE entities SET updated_at = ? WHERE id = ?'
);
```

Inside the transaction loop, after deleting observations for each entity, add:

```typescript
// Bump updated_at — the entity's content has changed
updateTimestamp.run(new Date().toISOString(), row.id);
```

Note: unlike `addObservations`, we always bump `updated_at` here even if no observations were actually deleted (the intent to modify counts — and the check would require counting deletions which adds complexity for no benefit).

- [ ] **Step 6: Update buildEntities to include timestamps**

In `buildEntities` (around line 456), update the entity query to select `updated_at` and `id`, and include them in the returned Entity objects.

Update the SQL in the observations query — no change needed there, it already works by entity name.

Update the `entityRows` parameter type and the return mapping:

Change the method signature from:
```typescript
private buildEntities(entityRows: { name: string; entityType: string; project: string | null }[]): Entity[] {
```

To:
```typescript
private buildEntities(entityRows: { name: string; entityType: string; project: string | null; updated_at: string; created_at: string }[]): Entity[] {
```

Update the return mapping at the end of the method from:
```typescript
return entityRows.map(e => ({
  name: e.name,
  entityType: e.entityType,
  observations: obsMap.get(e.name) || [],
  project: e.project,
}));
```

To:
```typescript
return entityRows.map(e => ({
  name: e.name,
  entityType: e.entityType,
  observations: obsMap.get(e.name) || [],
  project: e.project,
  updatedAt: e.updated_at,
  createdAt: e.created_at,
}));
```

- [ ] **Step 7: Update all SQL SELECT statements in readGraph, searchNodes, openNodes**

Every query that selects entity rows needs to include `updated_at` and `created_at`. Search for all `SELECT name, entity_type AS entityType, project FROM entities` patterns and change them to:

```sql
SELECT name, entity_type AS entityType, project, updated_at, created_at FROM entities
```

There are 6 occurrences across `readGraph` (2 queries — scoped and unscoped), `searchNodes` (2 queries), and `openNodes` (2 queries).

Also update the corresponding TypeScript `as` type casts from:
```typescript
as { name: string; entityType: string; project: string | null }[]
```
To:
```typescript
as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string }[]
```

- [ ] **Step 8: Update migrateFromJsonl to set timestamps**

In `migrateFromJsonl` (around line 183), update the INSERT statement to include timestamps:

Change the `insertEntity` prepared statement from:
```typescript
const insertEntity = this.db.prepare(
  'INSERT OR IGNORE INTO entities (name, entity_type, project) VALUES (?, ?, ?)'
);
```

To:
```typescript
const now = new Date().toISOString();
const insertEntity = this.db.prepare(
  'INSERT OR IGNORE INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, ?, ?, ?)'
);
```

Update the `insertEntity.run` call to include timestamps. Use the entity's `updatedAt`/`createdAt` if available (from JSONL files written after Phase 4), otherwise use the sentinel:

```typescript
const entityUpdatedAt = entity.updatedAt || ENTITY_TIMESTAMP_SENTINEL;
const entityCreatedAt = entity.createdAt || ENTITY_TIMESTAMP_SENTINEL;
insertEntity.run(entity.name, entity.entityType, migratedProject, entityUpdatedAt, entityCreatedAt);
```

- [ ] **Step 9: Run tests**

Run: `npm test 2>&1 | tail -20`

Expected: Some tests may still fail due to Entity objects in tests not having `updatedAt`/`createdAt`. The SQLite-specific tests should be closer to passing since the store now produces complete Entity objects. Don't worry about remaining failures — they'll be fixed in Tasks 3 and 4.

- [ ] **Step 10: Commit**

```bash
git add sqlite-store.ts
git commit -m "feat(sqlite): add entity timestamps, migration, and pagination indexes"
```

---

### Task 3: Update JsonlStore for Entity Timestamps

**Files:**
- Modify: `jsonl-store.ts`

This task updates the JSONL backend to read/write `updatedAt` and `createdAt` on entities, and updates all write paths to set timestamps.

- [ ] **Step 1: Add ENTITY_TIMESTAMP_SENTINEL import**

Add to the import block at the top of `jsonl-store.ts`:

```typescript
import {
  createObservation,
  ENTITY_TIMESTAMP_SENTINEL,
  // ... existing imports ...
} from './types.js';
```

- [ ] **Step 2: Update loadGraph to read timestamps**

In `loadGraph` (around line 137), update the entity parsing block to include `updatedAt` and `createdAt`. Change:

```typescript
graph.entities.push({
  name: item.name,
  entityType: item.entityType,
  observations: (item.observations || []).map(normalizeObservation),
  project: typeof item.project === 'string' ? item.project : null,
});
```

To:

```typescript
graph.entities.push({
  name: item.name,
  entityType: item.entityType,
  observations: (item.observations || []).map(normalizeObservation),
  project: typeof item.project === 'string' ? item.project : null,
  updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : ENTITY_TIMESTAMP_SENTINEL,
  createdAt: typeof item.createdAt === 'string' ? item.createdAt : ENTITY_TIMESTAMP_SENTINEL,
});
```

- [ ] **Step 3: Update saveGraph to write timestamps**

In `saveGraph` (around line 174), update the entity serialization to include `updatedAt` and `createdAt`. Change:

```typescript
...graph.entities.map(e => JSON.stringify({
  type: "entity", name: e.name, entityType: e.entityType,
  observations: e.observations, project: e.project
})),
```

To:

```typescript
...graph.entities.map(e => JSON.stringify({
  type: "entity", name: e.name, entityType: e.entityType,
  observations: e.observations, project: e.project,
  updatedAt: e.updatedAt, createdAt: e.createdAt
})),
```

- [ ] **Step 4: Update createEntities to set timestamps**

In `createEntities` (around line 205), update the normalized entity construction to include timestamps. Change:

```typescript
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
```

To:

```typescript
const now = new Date().toISOString();
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
  updatedAt: now,
  createdAt: now,
}));
```

- [ ] **Step 5: Update addObservations to bump updatedAt**

In `addObservations` (around line 264), after the observation insertion loop and before the return statement assembly, add:

```typescript
// Bump updatedAt — entity content has changed
if (newObservations.length > 0) {
  entity.updatedAt = new Date().toISOString();
}
```

This goes right after `entity.observations.push(...newObservations);` (around line 279).

- [ ] **Step 6: Update deleteObservations to bump updatedAt**

In `deleteObservations` (around line 302), after filtering the entity's observations, add:

```typescript
// Bump updatedAt — entity content has changed
entity.updatedAt = new Date().toISOString();
```

This goes right after the `entity.observations = entity.observations.filter(...)` line (around line 308).

- [ ] **Step 7: Run tests**

Run: `npm test 2>&1 | tail -20`

Expected: Tests should be much closer to passing now. Both stores produce Entity objects with `updatedAt` and `createdAt`. Some tests may still fail if they do strict equality checks on Entity objects without the new fields. These will be fixed in Task 4.

- [ ] **Step 8: Commit**

```bash
git add jsonl-store.ts
git commit -m "feat(jsonl): add entity timestamps to read/write paths"
```

---

### Task 4: Fix Existing Tests for Entity Timestamps

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts`

The existing tests use `expect.objectContaining` for most Entity assertions, which should tolerate the new fields. However, some tests do strict equality or structural checks that need updating. This task fixes all test failures caused by the new `updatedAt`/`createdAt` fields.

- [ ] **Step 1: Run tests and identify failures**

Run: `npm test 2>&1`

Read the full output carefully. Identify every failing test and the reason. Common patterns will be:
- Strict equality checks against Entity objects missing `updatedAt`/`createdAt`
- Tests that check `readGraph()` return type (now will include `updatedAt`/`createdAt` on entities)
- The `persist project field across store restarts` test — `graph.entities[0].project` should still work but may need adjustment

- [ ] **Step 2: Fix failing tests**

For each failing test, add `updatedAt` and `createdAt` expectations. Use `expect.objectContaining` with `expect.any(String)` for timestamp fields:

```typescript
expect(entity).toEqual(expect.objectContaining({
  name: 'Alice',
  entityType: 'person',
  updatedAt: expect.any(String),
  createdAt: expect.any(String),
}));
```

For tests that check Entity objects have no extra properties (like the "strip type field" JSONL tests), add `updatedAt` and `createdAt` to the expected properties:

```typescript
expect(entity).toHaveProperty('updatedAt');
expect(entity).toHaveProperty('createdAt');
```

- [ ] **Step 3: Add timestamp-specific tests to the parameterized suite**

Add a new `describe('entity timestamps')` block in the parameterized section (inside the `describe.each` block), after the existing `observation timestamps` section. This runs against both stores:

```typescript
describe('entity timestamps', () => {
  it('should set updatedAt and createdAt on entity creation', async () => {
    const before = new Date().toISOString();
    await store.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['test'] },
    ]);
    const after = new Date().toISOString();

    const graph = await store.readGraph();
    const alice = graph.entities[0];
    expect(alice.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(alice.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(alice.updatedAt >= before).toBe(true);
    expect(alice.updatedAt <= after).toBe(true);
    expect(alice.createdAt).toBe(alice.updatedAt);
  });

  it('should bump updatedAt when observations are added', async () => {
    await store.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['initial'] },
    ]);
    const graph1 = await store.readGraph();
    const originalUpdatedAt = graph1.entities[0].updatedAt;
    const originalCreatedAt = graph1.entities[0].createdAt;

    // Small delay so timestamps differ
    await new Promise(r => setTimeout(r, 10));

    await store.addObservations([
      { entityName: 'Alice', contents: ['new observation'] },
    ]);

    const graph2 = await store.readGraph();
    const alice = graph2.entities[0];
    expect(alice.updatedAt > originalUpdatedAt).toBe(true);
    expect(alice.createdAt).toBe(originalCreatedAt); // createdAt unchanged
  });

  it('should bump updatedAt when observations are deleted', async () => {
    await store.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['keep', 'remove'] },
    ]);
    const graph1 = await store.readGraph();
    const originalUpdatedAt = graph1.entities[0].updatedAt;

    await new Promise(r => setTimeout(r, 10));

    await store.deleteObservations([
      { entityName: 'Alice', contents: ['remove'] },
    ]);

    const graph2 = await store.readGraph();
    expect(graph2.entities[0].updatedAt > originalUpdatedAt).toBe(true);
  });

  it('should NOT bump updatedAt when relations are created', async () => {
    await store.createEntities([
      { name: 'Alice', entityType: 'person', observations: [] },
      { name: 'Bob', entityType: 'person', observations: [] },
    ]);
    const graph1 = await store.readGraph();
    const aliceUpdatedAt = graph1.entities.find(e => e.name === 'Alice')!.updatedAt;

    await new Promise(r => setTimeout(r, 10));

    await store.createRelations([
      { from: 'Alice', to: 'Bob', relationType: 'knows' },
    ]);

    const graph2 = await store.readGraph();
    expect(graph2.entities.find(e => e.name === 'Alice')!.updatedAt).toBe(aliceUpdatedAt);
  });

  it('should persist timestamps across store restarts', async () => {
    await store.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['test'] },
    ]);
    const graph1 = await store.readGraph();
    const originalUpdatedAt = graph1.entities[0].updatedAt;
    const originalCreatedAt = graph1.entities[0].createdAt;

    await store.close();
    const store2 = createStore(storePath);
    await store2.init();
    const graph2 = await store2.readGraph();
    await store2.close();

    store = createStore(storePath);
    await store.init();

    expect(graph2.entities[0].updatedAt).toBe(originalUpdatedAt);
    expect(graph2.entities[0].createdAt).toBe(originalCreatedAt);
  });
});
```

- [ ] **Step 4: Run tests — all should pass**

Run: `npm test`

Expected: All tests pass (existing + new entity timestamp tests).

- [ ] **Step 5: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "test: add entity timestamp tests, fix existing tests for new fields"
```

---

### Task 5: Add Pagination Types to types.ts

**Files:**
- Modify: `types.ts`

This task adds the pagination-specific types and updates the `GraphStore` interface signatures.

- [ ] **Step 1: Add PaginationParams, PaginatedKnowledgeGraph, and InvalidCursorError**

In `types.ts`, add these after the `KnowledgeGraph` interface (around line 34):

```typescript
/** Pagination parameters for readGraph and searchNodes. */
export interface PaginationParams {
  cursor?: string;   // Opaque base64-encoded cursor from a previous response
  limit?: number;    // 1-100, default 40
}

/**
 * Paginated knowledge graph result.
 * Extends KnowledgeGraph with cursor metadata for fetching subsequent pages.
 */
export interface PaginatedKnowledgeGraph extends KnowledgeGraph {
  nextCursor: string | null;  // null = no more pages
  totalCount: number;         // Total matching entities (may vary between pages if data mutates)
}

/**
 * Thrown when an opaque cursor string cannot be decoded or is structurally invalid.
 * Also thrown when a cursor from one query context is used with a different query.
 */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}
```

- [ ] **Step 2: Update GraphStore interface signatures**

Change the `readGraph` and `searchNodes` signatures in the `GraphStore` interface to accept pagination and return `PaginatedKnowledgeGraph`:

From:
```typescript
readGraph(projectId?: string): Promise<Readonly<KnowledgeGraph>>;
searchNodes(query: string, projectId?: string): Promise<Readonly<KnowledgeGraph>>;
```

To:
```typescript
readGraph(projectId?: string, pagination?: PaginationParams): Promise<Readonly<PaginatedKnowledgeGraph>>;
searchNodes(query: string, projectId?: string, pagination?: PaginationParams): Promise<Readonly<PaginatedKnowledgeGraph>>;
```

- [ ] **Step 3: Run tests to see compilation errors**

Run: `npm test 2>&1 | head -40`

Expected: Tests should fail because the store implementations don't match the new interface yet (wrong return type). This confirms the type change propagated correctly.

- [ ] **Step 4: Commit**

```bash
git add types.ts
git commit -m "feat(types): add PaginationParams, PaginatedKnowledgeGraph, InvalidCursorError"
```

---

### Task 6: Implement Pagination in SqliteStore

**Files:**
- Modify: `sqlite-store.ts`

This is the core task — implementing keyset pagination in the SQLite backend. Adds cursor encode/decode utilities and updates `readGraph` and `searchNodes` to accept pagination params and return paginated results.

**Important:** When `pagination` is `undefined` (direct API calls, not MCP tool calls), both `readGraph` and `searchNodes` must return ALL results with `nextCursor: null` and `totalCount` = full count, per the spec. Only apply limit/cursor logic when `pagination` is explicitly provided. This ensures backward compatibility for tests and migration code that call these methods directly.

- [ ] **Step 1: Add imports and constants**

At the top of `sqlite-store.ts`, add the new type imports:

```typescript
import {
  createObservation,
  ENTITY_TIMESTAMP_SENTINEL,
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
  type PaginationParams,
  type PaginatedKnowledgeGraph,
  InvalidCursorError,
} from './types.js';
```

Add constants after the existing `CHUNK_SIZE` constant:

```typescript
/** Default number of entities per page when limit is not specified. */
const DEFAULT_PAGE_SIZE = 40;

/** Maximum allowed page size to prevent excessive responses. */
const MAX_PAGE_SIZE = 100;
```

- [ ] **Step 2: Add cursor encode/decode utilities**

Add these as module-level functions after the constants (before the `SqliteStore` class):

```typescript
/**
 * Internal cursor payload — encoded as base64 JSON in the opaque cursor string.
 * u: updatedAt of last entity on page (sort key)
 * i: SQLite entity id (tiebreaker for stable ordering)
 * n: entity name (tiebreaker for JSONL backend — unused by SQLite but preserved for compatibility)
 * q: query fingerprint (prevents using a cursor from one query on a different query)
 */
interface CursorPayload {
  u: string;
  i: number;
  n?: string;
  q: string;
}

/**
 * Encodes a cursor payload as a base64 JSON string.
 * The cursor is opaque to callers — they pass it back verbatim on the next request.
 *
 * @param payload - Internal cursor data with sort position and query fingerprint
 * @returns Base64-encoded string
 */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Decodes and validates a base64 cursor string.
 * Checks structural validity (required fields and types) and query fingerprint match.
 * Throws InvalidCursorError on any problem — never silently falls back to page 1.
 *
 * @param cursor - Base64-encoded cursor string from the client
 * @param expectedFingerprint - The query fingerprint for the current request
 * @returns Validated CursorPayload
 * @throws InvalidCursorError if cursor is malformed or doesn't match the current query
 */
function decodeCursor(cursor: string, expectedFingerprint: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'number' || typeof parsed.q !== 'string') {
      throw new InvalidCursorError('Cursor has invalid structure');
    }
    if (parsed.q !== expectedFingerprint) {
      throw new InvalidCursorError('Cursor does not match current query');
    }
    return parsed;
  } catch (err) {
    if (err instanceof InvalidCursorError) throw err;
    throw new InvalidCursorError('Cursor is malformed');
  }
}

/**
 * Clamps a user-provided limit to the valid range [1, MAX_PAGE_SIZE],
 * defaulting to DEFAULT_PAGE_SIZE when not provided.
 *
 * @param limit - User-provided limit, may be undefined
 * @returns Clamped page size
 */
function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
}
```

- [ ] **Step 3: Rewrite readGraph with pagination**

Replace the entire `readGraph` method. The new version accepts `PaginationParams`, uses keyset queries for pagination, and returns `PaginatedKnowledgeGraph`:

```typescript
/**
 * Returns the knowledge graph, optionally filtered by project, with cursor-based pagination.
 * Entities are sorted by most recently updated first (updated_at DESC, id DESC).
 * When pagination is omitted, returns all matching entities.
 *
 * @param projectId - Optional project name to filter by
 * @param pagination - Optional cursor and limit for paginated results
 * @returns Paginated result with entities, relations, nextCursor, and totalCount
 */
async readGraph(projectId?: string, pagination?: PaginationParams): Promise<PaginatedKnowledgeGraph> {
  const limit = clampLimit(pagination?.limit);
  const fingerprint = `readGraph:${projectId ?? ''}`;

  let cursor: CursorPayload | undefined;
  if (pagination?.cursor) {
    cursor = decodeCursor(pagination.cursor, fingerprint);
  }

  const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

  // Build the WHERE clause dynamically based on project filter and cursor position
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (normalizedProject) {
    conditions.push('(project = ? OR project IS NULL)');
    params.push(normalizedProject);
  }

  if (cursor) {
    // Keyset condition: fetch entities "after" the cursor position in DESC order
    conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    params.push(cursor.u, cursor.u, cursor.i);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Fetch limit+1 to detect if there's a next page without a separate query
  const entityRows = this.db.prepare(`
    SELECT name, entity_type AS entityType, project, updated_at, created_at, id
    FROM entities
    ${whereClause}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(...params, limit + 1) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number }[];

  // Determine if there's a next page
  const hasMore = entityRows.length > limit;
  const pageRows = hasMore ? entityRows.slice(0, limit) : entityRows;

  // Build the next cursor from the last entity on this page
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({ u: last.updated_at, i: last.id, n: last.name, q: fingerprint });
  }

  // Count total matching entities (same WHERE but no cursor/limit)
  const countConditions: string[] = [];
  const countParams: (string | number)[] = [];
  if (normalizedProject) {
    countConditions.push('(project = ? OR project IS NULL)');
    countParams.push(normalizedProject);
  }
  const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
  const totalCount = (this.db.prepare(`SELECT COUNT(*) AS cnt FROM entities ${countWhere}`).get(...countParams) as { cnt: number }).cnt;

  const entities = this.buildEntities(pageRows);

  // Relations: only include where both endpoints are in the current page
  const entityNames = new Set(pageRows.map(e => e.name));
  const connectedRelations = this.getConnectedRelations(pageRows.map(e => e.name));
  const filteredRelations = connectedRelations.filter(r =>
    entityNames.has(r.from) && entityNames.has(r.to)
  );

  return { entities, relations: filteredRelations, nextCursor, totalCount };
}
```

- [ ] **Step 4: Rewrite searchNodes with pagination**

Replace the entire `searchNodes` method. Same pagination pattern as `readGraph` but with the additional LIKE search conditions:

```typescript
/**
 * Searches entities by case-insensitive substring match against name, entityType,
 * or observation content. Results are paginated by most recently updated first.
 *
 * @param query - Case-insensitive substring to search for
 * @param projectId - Optional project name; only returns entities in this project or global
 * @param pagination - Optional cursor and limit for paginated results
 * @returns Paginated result with matching entities, relations, nextCursor, and totalCount
 */
async searchNodes(query: string, projectId?: string, pagination?: PaginationParams): Promise<PaginatedKnowledgeGraph> {
  const limit = clampLimit(pagination?.limit);
  const fingerprint = `searchNodes:${projectId ?? ''}:${query}`;

  let cursor: CursorPayload | undefined;
  if (pagination?.cursor) {
    cursor = decodeCursor(pagination.cursor, fingerprint);
  }

  const escaped = escapeLike(query);
  const pattern = `%${escaped}%`;
  const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

  // The search query uses a subquery to find matching entity IDs first,
  // then applies keyset pagination on the outer query for correct ordering.
  // This avoids the DISTINCT + ORDER BY interaction issue.
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Search conditions (always present)
  conditions.push(`id IN (
    SELECT DISTINCT e2.id FROM entities e2
    LEFT JOIN observations o ON o.entity_id = e2.id
    WHERE (e2.name LIKE ? ESCAPE '\\' OR e2.entity_type LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\')
    ${normalizedProject ? 'AND (e2.project = ? OR e2.project IS NULL)' : ''}
  )`);
  params.push(pattern, pattern, pattern);
  if (normalizedProject) {
    params.push(normalizedProject);
  }

  // Cursor condition
  if (cursor) {
    conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    params.push(cursor.u, cursor.u, cursor.i);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const entityRows = this.db.prepare(`
    SELECT name, entity_type AS entityType, project, updated_at, created_at, id
    FROM entities
    ${whereClause}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(...params, limit + 1) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number }[];

  const hasMore = entityRows.length > limit;
  const pageRows = hasMore ? entityRows.slice(0, limit) : entityRows;

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    nextCursor = encodeCursor({ u: last.updated_at, i: last.id, n: last.name, q: fingerprint });
  }

  // Count total matching entities (same search/project conditions, no cursor/limit)
  const countParams: (string | number)[] = [pattern, pattern, pattern];
  let countSql = `
    SELECT COUNT(DISTINCT e2.id) AS cnt FROM entities e2
    LEFT JOIN observations o ON o.entity_id = e2.id
    WHERE (e2.name LIKE ? ESCAPE '\\' OR e2.entity_type LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\')
  `;
  if (normalizedProject) {
    countSql += ' AND (e2.project = ? OR e2.project IS NULL)';
    countParams.push(normalizedProject);
  }
  const totalCount = (this.db.prepare(countSql).get(...countParams) as { cnt: number }).cnt;

  const entities = this.buildEntities(pageRows);

  // Relations: both endpoints must be in the current page
  const entityNames = new Set(pageRows.map(e => e.name));
  const connectedRelations = this.getConnectedRelations(pageRows.map(e => e.name));
  const filteredRelations = connectedRelations.filter(r =>
    entityNames.has(r.from) && entityNames.has(r.to)
  );

  return { entities, relations: filteredRelations, nextCursor, totalCount };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -30`

Expected: Existing tests should mostly pass. Some tests that assert on `readGraph()` or `searchNodes()` return shapes may need adjustment for the new `nextCursor` and `totalCount` fields — but since `PaginatedKnowledgeGraph extends KnowledgeGraph`, destructuring `{ entities, relations }` still works.

- [ ] **Step 6: Commit**

```bash
git add sqlite-store.ts
git commit -m "feat(sqlite): implement keyset pagination in readGraph and searchNodes"
```

---

### Task 7: Implement Pagination in JsonlStore

**Files:**
- Modify: `jsonl-store.ts`

This task implements in-memory pagination for the JSONL backend. Same interface, same cursor format, but operates on in-memory arrays instead of SQL queries.

- [ ] **Step 1: Add imports and cursor utilities**

Add imports at the top of `jsonl-store.ts`:

```typescript
import {
  createObservation,
  ENTITY_TIMESTAMP_SENTINEL,
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
  type PaginationParams,
  type PaginatedKnowledgeGraph,
  InvalidCursorError,
} from './types.js';
```

Add the same cursor utilities and constants as SqliteStore (same functions, same logic — kept in each file since they're small and avoids a shared module for 3 functions):

```typescript
const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;

interface CursorPayload {
  u: string;
  i: number;
  n?: string;
  q: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(cursor: string, expectedFingerprint: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'number' || typeof parsed.q !== 'string') {
      throw new InvalidCursorError('Cursor has invalid structure');
    }
    if (parsed.q !== expectedFingerprint) {
      throw new InvalidCursorError('Cursor does not match current query');
    }
    return parsed;
  } catch (err) {
    if (err instanceof InvalidCursorError) throw err;
    throw new InvalidCursorError('Cursor is malformed');
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
}
```

- [ ] **Step 2: Add paginateEntities helper**

Add a private helper method to the `JsonlStore` class that takes a filtered entity array, pagination params, and query fingerprint, and returns the paginated result. This avoids duplicating the sort/slice/cursor logic between `readGraph` and `searchNodes`:

```typescript
/**
 * Sorts entities by updatedAt DESC (name ASC as tiebreaker), applies cursor-based
 * pagination, and returns the paginated result with nextCursor and totalCount.
 * The full relation-filtering logic is handled by the caller.
 *
 * @param allEntities - Pre-filtered entity array (project/search filtering already applied)
 * @param allRelations - All relations in the graph (caller will filter)
 * @param fingerprint - Query fingerprint for cursor validation
 * @param pagination - Optional cursor and limit
 * @returns PaginatedKnowledgeGraph with sorted, paginated entities
 */
private paginateEntities(
  allEntities: Entity[],
  allRelations: Relation[],
  fingerprint: string,
  pagination?: PaginationParams,
): PaginatedKnowledgeGraph {
  const limit = clampLimit(pagination?.limit);
  const totalCount = allEntities.length;

  // Sort by updatedAt DESC, then by name ASC for deterministic tiebreaking
  const sorted = [...allEntities].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt > b.updatedAt ? -1 : 1;  // DESC
    }
    return a.name < b.name ? -1 : 1;  // ASC tiebreaker
  });

  // Find the cursor position if a cursor was provided
  let startIndex = 0;
  if (pagination?.cursor) {
    const cursor = decodeCursor(pagination.cursor, fingerprint);
    // Find the entity matching the cursor — the next page starts AFTER this entity
    const cursorIndex = sorted.findIndex(e =>
      e.updatedAt === cursor.u && e.name === (cursor.n ?? '')
    );
    if (cursorIndex === -1) {
      // Cursor entity was deleted or mutated — start from the beginning
      // (this is a documented edge case of keyset pagination with mutable sort keys)
      throw new InvalidCursorError('Cursor position not found — entity may have been modified or deleted');
    }
    startIndex = cursorIndex + 1;
  }

  // Slice the page plus one extra to detect if there's a next page
  const pageWithExtra = sorted.slice(startIndex, startIndex + limit + 1);
  const hasMore = pageWithExtra.length > limit;
  const pageEntities = hasMore ? pageWithExtra.slice(0, limit) : pageWithExtra;

  // Build next cursor from the last entity on this page
  let nextCursor: string | null = null;
  if (hasMore && pageEntities.length > 0) {
    const last = pageEntities[pageEntities.length - 1];
    nextCursor = encodeCursor({
      u: last.updatedAt,
      i: 0,  // JSONL has no integer id — uses name as tiebreaker
      n: last.name,
      q: fingerprint,
    });
  }

  // Filter relations: both endpoints must be in the current page
  const pageEntityNames = new Set(pageEntities.map(e => e.name));
  const filteredRelations = allRelations.filter(r =>
    pageEntityNames.has(r.from) && pageEntityNames.has(r.to)
  );

  return { entities: pageEntities, relations: filteredRelations, nextCursor, totalCount };
}
```

- [ ] **Step 3: Rewrite readGraph with pagination**

Replace the existing `readGraph` method:

```typescript
/**
 * Returns the knowledge graph, optionally filtered by project, with cursor-based pagination.
 * Entities are sorted by most recently updated first.
 *
 * @param projectId - Optional project name to filter by
 * @param pagination - Optional cursor and limit for paginated results
 */
async readGraph(projectId?: string, pagination?: PaginationParams): Promise<PaginatedKnowledgeGraph> {
  const graph = await this.loadGraph();
  const fingerprint = `readGraph:${projectId ?? ''}`;

  if (!projectId && !pagination) {
    // Fast path: no filtering, no pagination — return everything
    return { ...graph, nextCursor: null, totalCount: graph.entities.length };
  }

  let filteredEntities = graph.entities;
  let filteredRelations = graph.relations;

  if (projectId) {
    const normalizedProject = projectId.trim().toLowerCase().normalize('NFC');
    filteredEntities = graph.entities.filter(e =>
      e.project === normalizedProject || e.project === null
    );
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );
  }

  return this.paginateEntities(filteredEntities, filteredRelations, fingerprint, pagination);
}
```

- [ ] **Step 4: Rewrite searchNodes with pagination**

Replace the existing `searchNodes` method:

```typescript
/**
 * Searches for entities matching the query. Results are paginated by most recently updated first.
 *
 * @param query - Case-insensitive substring to search for
 * @param projectId - Optional project name; only returns entities in this project or global
 * @param pagination - Optional cursor and limit for paginated results
 */
async searchNodes(query: string, projectId?: string, pagination?: PaginationParams): Promise<PaginatedKnowledgeGraph> {
  const graph = await this.loadGraph();
  const lowerQuery = query.toLowerCase();
  const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');
  const fingerprint = `searchNodes:${projectId ?? ''}:${query}`;

  // First filter: match by name, type, or observation content
  let filteredEntities = graph.entities.filter(e =>
    e.name.toLowerCase().includes(lowerQuery) ||
    e.entityType.toLowerCase().includes(lowerQuery) ||
    e.observations.some(o => o.content.toLowerCase().includes(lowerQuery))
  );

  // Second filter: restrict to project + globals if a projectId was given
  if (normalizedProject) {
    filteredEntities = filteredEntities.filter(e =>
      e.project === normalizedProject || e.project === null
    );
  }

  // Build the full relation set before pagination slices the entities
  const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  const filteredRelations = normalizedProject
    ? graph.relations.filter(r => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to))
    : graph.relations.filter(r => filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to));

  return this.paginateEntities(filteredEntities, filteredRelations, fingerprint, pagination);
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`

Expected: All existing tests should pass. The parameterized tests run against both backends, so both stores now return `PaginatedKnowledgeGraph` with `nextCursor: null` and `totalCount` when called without pagination params.

- [ ] **Step 6: Commit**

```bash
git add jsonl-store.ts
git commit -m "feat(jsonl): implement in-memory pagination in readGraph and searchNodes"
```

---

### Task 8: Add Pagination Tests

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts`

This task adds comprehensive pagination tests to the parameterized test suite (runs against both backends).

- [ ] **Step 1: Add pagination test block**

Add a new `describe('pagination')` block in the parameterized section, after the existing `entity timestamps` section. Import `InvalidCursorError` at the top of the test file:

```typescript
// Add to imports at the top:
import type { GraphStore, Relation, PaginatedKnowledgeGraph } from '../types.js';
import { InvalidCursorError } from '../types.js';
```

```typescript
describe('pagination', () => {
  // Helper: create N entities with staggered timestamps
  async function createStaggeredEntities(store: GraphStore, count: number, projectId?: string): Promise<void> {
    for (let i = 0; i < count; i++) {
      await store.createEntities(
        [{ name: `Entity-${String(i).padStart(3, '0')}`, entityType: 'test', observations: [`obs for ${i}`] }],
        projectId,
      );
      // Small delay so updatedAt values differ
      if (i < count - 1) {
        await new Promise(r => setTimeout(r, 5));
      }
    }
  }

  it('should return all entities with nextCursor null when count <= limit', async () => {
    await createStaggeredEntities(store, 3);

    const result = await store.readGraph(undefined, { limit: 10 });
    expect(result.entities).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
    expect(result.totalCount).toBe(3);
  });

  it('should paginate readGraph with default limit', async () => {
    // Create more entities than the default page size (40)
    await createStaggeredEntities(store, 45);

    const page1 = await store.readGraph();
    expect(page1.entities).toHaveLength(40);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.totalCount).toBe(45);

    const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor! });
    expect(page2.entities).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    expect(page2.totalCount).toBe(45);
  });

  it('should paginate with custom limit', async () => {
    await createStaggeredEntities(store, 10);

    const page1 = await store.readGraph(undefined, { limit: 3 });
    expect(page1.entities).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.totalCount).toBe(10);

    const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 3 });
    expect(page2.entities).toHaveLength(3);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await store.readGraph(undefined, { cursor: page2.nextCursor!, limit: 3 });
    expect(page3.entities).toHaveLength(3);
    expect(page3.nextCursor).not.toBeNull();

    const page4 = await store.readGraph(undefined, { cursor: page3.nextCursor!, limit: 3 });
    expect(page4.entities).toHaveLength(1);
    expect(page4.nextCursor).toBeNull();
  });

  it('should return entities sorted by most recently updated first', async () => {
    await createStaggeredEntities(store, 5);

    const result = await store.readGraph(undefined, { limit: 5 });
    // Most recently created entity should be first (Entity-004)
    expect(result.entities[0].name).toBe('Entity-004');
    expect(result.entities[4].name).toBe('Entity-000');
  });

  it('should not return duplicate entities across pages', async () => {
    await createStaggeredEntities(store, 10);

    const allNames: string[] = [];
    let cursor: string | undefined;

    // Paginate through everything with limit=3
    for (let page = 0; page < 10; page++) {
      const result = await store.readGraph(undefined, { cursor, limit: 3 });
      allNames.push(...result.entities.map(e => e.name));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(allNames).toHaveLength(10);
    expect(new Set(allNames).size).toBe(10); // No duplicates
  });

  it('should paginate searchNodes', async () => {
    await createStaggeredEntities(store, 10);

    const page1 = await store.searchNodes('Entity', undefined, { limit: 3 });
    expect(page1.entities).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.totalCount).toBe(10);

    const page2 = await store.searchNodes('Entity', undefined, { cursor: page1.nextCursor!, limit: 3 });
    expect(page2.entities).toHaveLength(3);
    expect(page2.nextCursor).not.toBeNull();
  });

  it('should respect project filter during pagination', async () => {
    await createStaggeredEntities(store, 5, 'proj-a');
    // Create 3 global entities with unique names (can't reuse Entity-00N — names are globally unique)
    await store.createEntities([
      { name: 'Global-1', entityType: 'test', observations: ['g1'] },
      { name: 'Global-2', entityType: 'test', observations: ['g2'] },
      { name: 'Global-3', entityType: 'test', observations: ['g3'] },
    ]);

    const result = await store.readGraph('proj-a', { limit: 100 });
    // Should include proj-a entities + global entities
    const projANames = result.entities.filter(e => e.project === 'proj-a').map(e => e.name);
    const globalNames = result.entities.filter(e => e.project === null).map(e => e.name);
    expect(projANames).toHaveLength(5);
    expect(globalNames.length).toBeGreaterThanOrEqual(3);
  });

  it('should throw InvalidCursorError for malformed cursor', async () => {
    await expect(
      store.readGraph(undefined, { cursor: 'not-valid-base64!!!' })
    ).rejects.toThrow(InvalidCursorError);
  });

  it('should throw InvalidCursorError for cursor from different query', async () => {
    await createStaggeredEntities(store, 5);

    const page1 = await store.readGraph(undefined, { limit: 2 });
    expect(page1.nextCursor).not.toBeNull();

    // Use readGraph cursor with searchNodes — should fail
    await expect(
      store.searchNodes('Entity', undefined, { cursor: page1.nextCursor! })
    ).rejects.toThrow(InvalidCursorError);
  });

  it('should throw InvalidCursorError for cursor from different projectId', async () => {
    await createStaggeredEntities(store, 5, 'proj-a');
    await store.createEntities(
      [{ name: 'B-Entity', entityType: 'test', observations: ['b'] }],
      'proj-b',
    );

    const page1 = await store.readGraph('proj-a', { limit: 2 });
    expect(page1.nextCursor).not.toBeNull();

    // Use proj-a cursor with proj-b — should fail
    await expect(
      store.readGraph('proj-b', { cursor: page1.nextCursor! })
    ).rejects.toThrow(InvalidCursorError);
  });

  it('should clamp limit to max 100', async () => {
    await createStaggeredEntities(store, 5);

    // Requesting limit=200 should be clamped to 100 (but we only have 5 entities)
    const result = await store.readGraph(undefined, { limit: 200 });
    expect(result.entities).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it('should return only relations where both endpoints are in current page', async () => {
    // Create 4 entities with relations spanning pages
    await store.createEntities([
      { name: 'A', entityType: 'test', observations: ['a'] },
    ]);
    await new Promise(r => setTimeout(r, 10));
    await store.createEntities([
      { name: 'B', entityType: 'test', observations: ['b'] },
    ]);
    await new Promise(r => setTimeout(r, 10));
    await store.createEntities([
      { name: 'C', entityType: 'test', observations: ['c'] },
    ]);
    await new Promise(r => setTimeout(r, 10));
    await store.createEntities([
      { name: 'D', entityType: 'test', observations: ['d'] },
    ]);

    await store.createRelations([
      { from: 'A', to: 'B', relationType: 'knows' },    // Both on page 2
      { from: 'C', to: 'D', relationType: 'knows' },    // Both on page 1
      { from: 'B', to: 'D', relationType: 'cross' },    // Spans pages
    ]);

    // Page 1 (limit=2): D and C (most recent)
    const page1 = await store.readGraph(undefined, { limit: 2 });
    expect(page1.entities.map(e => e.name)).toEqual(['D', 'C']);
    // Only C->D relation (both on page 1)
    expect(page1.relations).toHaveLength(1);
    expect(page1.relations[0]).toEqual(expect.objectContaining({ from: 'C', to: 'D' }));

    // Page 2 (limit=2): B and A
    const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 2 });
    expect(page2.entities.map(e => e.name)).toEqual(['B', 'A']);
    // Only A->B relation (both on page 2)
    expect(page2.relations).toHaveLength(1);
    expect(page2.relations[0]).toEqual(expect.objectContaining({ from: 'A', to: 'B' }));
    // B->D relation is NOT on either page (endpoints span pages)
  });

  it('should handle empty graph with pagination', async () => {
    const result = await store.readGraph(undefined, { limit: 10 });
    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    expect(result.totalCount).toBe(0);
  });

  it('should return totalCount reflecting full result set', async () => {
    await createStaggeredEntities(store, 15);

    const page1 = await store.readGraph(undefined, { limit: 5 });
    expect(page1.totalCount).toBe(15);

    const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 5 });
    expect(page2.totalCount).toBe(15);
  });
});
```

- [ ] **Step 2: Run tests — all should pass**

Run: `npm test`

Expected: All tests pass (existing + entity timestamps + pagination tests). The parameterized suite runs every pagination test against both JsonlStore and SqliteStore.

- [ ] **Step 3: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "test: add comprehensive pagination tests for both backends"
```

---

### Task 9: Update MCP Tool Schemas and Handlers

**Files:**
- Modify: `index.ts`

This task updates the MCP tool registrations to accept cursor/limit params, return nextCursor/totalCount, and use updated tool descriptions.

- [ ] **Step 1: Add new imports and update re-exports**

At the top of `index.ts`, update the re-exports to include new types:

```typescript
export { type Observation, type Entity, type Relation, type KnowledgeGraph, type CreateEntitiesResult, type SkippedEntity, type PaginationParams, type PaginatedKnowledgeGraph, InvalidCursorError } from './types.js';
```

- [ ] **Step 2: Add output schemas for pagination**

After the existing `SkippedEntitySchema` (around line 136), add output schemas for the pagination metadata:

```typescript
// Pagination output schema — included in read_graph and search_nodes responses
const PaginatedOutputSchema = {
  entities: z.array(EntityOutputSchema),
  relations: z.array(RelationSchema),
  nextCursor: z.string().nullable().describe("Cursor for the next page, or null if this is the last page"),
  totalCount: z.number().describe("Total number of matching entities across all pages"),
};
```

- [ ] **Step 3: Update EntityOutputSchema for timestamps**

Update `EntityOutputSchema` to include `updatedAt` and `createdAt`:

```typescript
const EntityOutputSchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(ObservationSchema).describe("An array of observations with content and timestamps"),
  project: z.string().nullable().describe("Project this entity belongs to, or null for global"),
  updatedAt: z.string().describe("ISO 8601 UTC timestamp of last update, or sentinel for legacy data"),
  createdAt: z.string().describe("ISO 8601 UTC timestamp of creation, or sentinel for legacy data"),
});
```

- [ ] **Step 4: Update read_graph tool**

Replace the `read_graph` tool registration:

```typescript
server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the knowledge graph. Returns entities sorted by most recently updated, paginated. Use the returned nextCursor to fetch subsequent pages. Omit cursor for the first page.",
    inputSchema: {
      projectId: ProjectIdSchema,
      cursor: z.string().optional().describe("Opaque cursor from a previous response for fetching the next page. Omit for first page."),
      limit: z.number().int().min(1).max(100).optional().default(40).describe("Max entities per page (default 40, max 100)"),
    },
    outputSchema: PaginatedOutputSchema,
  },
  async ({ projectId, cursor, limit }) => {
    const result = await store.readGraph(normalizeProjectId(projectId), { cursor, limit });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { ...result }
    };
  }
);
```

- [ ] **Step 5: Update search_nodes tool**

Replace the `search_nodes` tool registration:

```typescript
server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph. Returns matching entities sorted by most recently updated, paginated. Use the returned nextCursor to fetch subsequent pages. Omit cursor for the first page.",
    inputSchema: {
      query: z.string().min(1).max(5000).describe("The search query to match against entity names, types, and observation content"),
      projectId: ProjectIdSchema,
      cursor: z.string().optional().describe("Opaque cursor from a previous response for fetching the next page. Omit for first page."),
      limit: z.number().int().min(1).max(100).optional().default(40).describe("Max entities per page (default 40, max 100)"),
    },
    outputSchema: PaginatedOutputSchema,
  },
  async ({ query, projectId, cursor, limit }) => {
    const result = await store.searchNodes(query, normalizeProjectId(projectId), { cursor, limit });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { ...result }
    };
  }
);
```

- [ ] **Step 6: Bump version**

In `index.ts`, update the server version:

```typescript
const server = new McpServer({
  name: "memory-server",
  version: "0.10.0",
});
```

- [ ] **Step 7: Build and run tests**

Run: `npm run build && npm test`

Expected: Build succeeds with no TypeScript errors. All tests pass.

- [ ] **Step 8: Commit**

```bash
git add index.ts
git commit -m "feat(tools): add cursor/limit to read_graph and search_nodes, update descriptions"
```

---

### Task 10: Update CLAUDE.md and package.json

**Files:**
- Modify: `CLAUDE.md`
- Modify: `package.json`

- [ ] **Step 1: Update package.json version**

Change `"version": "0.9.0"` to `"version": "0.10.0"`.

- [ ] **Step 2: Update CLAUDE.md**

Update the following sections:

In the **Architecture** section, update `index.ts` description to mention pagination params:
- Add: `cursor` and `limit` optional parameters on `read_graph` and `search_nodes` tools
- Add: `nextCursor` and `totalCount` in responses

Update `sqlite-store.ts` line count and description:
- Add: `idx_entities_updated` and `idx_entities_project_updated` indexes for pagination
- Add: `updated_at` and `created_at` columns on entities table

Update `types.ts` line count and description:
- Add: `PaginationParams`, `PaginatedKnowledgeGraph`, `InvalidCursorError`
- Add: `Entity.updatedAt` and `Entity.createdAt` fields

Update `jsonl-store.ts` line count and description:
- Add: In-memory cursor-based pagination

In the **Known Limitations** section, add:
- **Paginated relation coverage is incomplete** — relations are only included when both endpoints appear on the same page. Paginating through all pages and unioning results does not yield complete relation coverage. Use `open_nodes` for full relation context on specific entities.
- **Cursor stability under mutation** — if an entity's `updatedAt` changes between page fetches (e.g., observations added), the entity may appear on two pages or be skipped. This is inherent to keyset pagination with a mutable sort key and is the correct tradeoff for a memory server (freshness > perfect enumeration).

In the **Tests** section, update the test count and add pagination test descriptions.

In the **Planned Phases** section, mark Phase 4 as DONE:
```
4. ~~**Pagination**~~ — DONE: cursor-based pagination for read_graph and search_nodes, entity timestamps (updatedAt/createdAt), keyset ordering by recency
```

- [ ] **Step 3: Build and run full test suite**

Run: `npm run build && npm test`

Expected: Build succeeds. All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md package.json
git commit -m "docs: update CLAUDE.md and bump version to 0.10.0 for Phase 4"
```

---

### Task 11: SQLite Timestamp Column Migration Test

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts`

Add a SQLite-specific migration test (in the `SqliteStore-specific` section) that verifies the `updated_at`/`created_at` column migration works on pre-Phase-4 databases.

- [ ] **Step 1: Add migration test**

Add to the `SqliteStore-specific` section, after the existing `project column migration` describe block:

```typescript
describe('timestamp column migration', () => {
  it('should migrate existing database by adding timestamp columns and backfilling', async () => {
    const migrationPath = path.join(testDir, `test-migration-timestamps-${Date.now()}.db`);

    // Create a pre-Phase-4 database (has project column but no timestamp columns)
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(migrationPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        project     TEXT
      );
      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(entity_id, content)
      );
      CREATE TABLE IF NOT EXISTS relations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        relation_type TEXT NOT NULL,
        UNIQUE(from_entity, to_entity, relation_type)
      );
    `);

    // Insert entities with observations (for backfill testing)
    rawDb.prepare('INSERT INTO entities (name, entity_type) VALUES (?, ?)').run('WithObs', 'test');
    const entityId = (rawDb.prepare('SELECT id FROM entities WHERE name = ?').get('WithObs') as { id: number }).id;
    rawDb.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)').run(entityId, 'obs1', '2026-03-15T10:00:00.000Z');
    rawDb.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)').run(entityId, 'obs2', '2026-04-01T15:30:00.000Z');

    // Insert entity without valid observations (should keep sentinel)
    rawDb.prepare('INSERT INTO entities (name, entity_type) VALUES (?, ?)').run('NoObs', 'test');

    rawDb.close();

    // Re-open with SqliteStore — init() should detect missing columns and migrate
    const store2 = new SqliteStore(migrationPath);
    await store2.init();

    const graph = await store2.readGraph();

    // Entity with observations should have updatedAt backfilled from MAX(observations.created_at)
    const withObs = graph.entities.find(e => e.name === 'WithObs');
    expect(withObs).toBeDefined();
    expect(withObs!.updatedAt).toBe('2026-04-01T15:30:00.000Z');
    expect(withObs!.createdAt).toBe('2026-03-15T10:00:00.000Z');

    // Entity without observations should have sentinel timestamp
    const noObs = graph.entities.find(e => e.name === 'NoObs');
    expect(noObs).toBeDefined();
    expect(noObs!.updatedAt).toBe('0000-00-00T00:00:00.000Z');
    expect(noObs!.createdAt).toBe('0000-00-00T00:00:00.000Z');

    // Verify pagination works on migrated data (updatedAt should order correctly)
    const paginated = await store2.readGraph(undefined, { limit: 1 });
    // WithObs has a real timestamp, should come first in DESC order
    expect(paginated.entities[0].name).toBe('WithObs');
    expect(paginated.nextCursor).not.toBeNull();

    await store2.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { await fs.unlink(migrationPath + suffix); } catch { /* ignore */ }
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`

Expected: All tests pass including the new migration test.

- [ ] **Step 3: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "test: add SQLite timestamp column migration test"
```
