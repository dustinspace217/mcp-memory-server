# Phase 4: Cursor-Based Pagination — Design Spec

## Goal

Reduce context drift across Claude sessions by making memory retrieval fit inside context windows. Currently, `read_graph` and `search_nodes` return unbounded results — a single `search_nodes` call for one project returned 55KB (63 entities, 131 relations), of which only 2KB was visible after truncation. Pagination ensures the most relevant (recently updated) entities load first, with cursor-based continuation for the rest.

## Architecture

Keyset pagination on `(updated_at DESC, id DESC)` with opaque base64-encoded cursors. Both `read_graph` and `search_nodes` gain optional `cursor` and `limit` parameters and return `nextCursor` + `totalCount` metadata. A default limit of 40 entities is always applied (hybrid mode — not opt-in), with a caller-specified maximum of 100. Both SQLite and JSONL backends implement pagination with identical behavior.

## Scope

- **In scope:** `read_graph`, `search_nodes` — pagination, `updated_at`/`created_at` entity timestamps, schema migration, cursor encoding/validation
- **Out of scope:** `open_nodes` (already bounded by `.max(100)` on input array — caller explicitly names entities), `list_projects` (returns project names only, inherently small)

---

## 1. Schema Changes

### 1.1 Entity Timestamps

Add `updated_at` and `created_at` columns to the SQLite `entities` table:

```sql
ALTER TABLE entities ADD COLUMN updated_at TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z';
ALTER TABLE entities ADD COLUMN created_at TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z';
```

- Both are ISO 8601 UTC strings
- Sentinel value `'0000-00-00T00:00:00.000Z'` for legacy rows — self-documenting, sorts correctly in DESC (legacy rows sort last), avoids semantic collision with empty string
- Migration uses `pragma('table_info(entities)')` to check if columns exist (same pattern as the Phase 3 `project` column migration)

### 1.2 Backfill from Observations

During migration, backfill `updated_at` from the most recent observation timestamp:

```sql
UPDATE entities SET updated_at = (
  SELECT MAX(created_at) FROM observations
  WHERE entity_id = entities.id AND created_at != 'unknown'
)
WHERE updated_at = '0000-00-00T00:00:00.000Z' AND EXISTS (
  SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
);
```

Entities with no valid observation timestamps keep the sentinel value.

### 1.3 Indexes

```sql
-- For project-scoped paginated reads (project is leftmost column)
CREATE INDEX IF NOT EXISTS idx_entities_project_updated ON entities(project, updated_at DESC, id DESC);

-- For unscoped paginated reads (no project filter)
CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC, id DESC);
```

The existing `idx_entities_project` index can be dropped — the composite index covers all project-filtered queries.

### 1.4 Entity Interface (types.ts)

```typescript
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
  project: string | null;    // null = global, never undefined
  updatedAt: string;         // ISO 8601 UTC, or '0000-00-00T00:00:00.000Z' for legacy
  createdAt: string;         // ISO 8601 UTC, or '0000-00-00T00:00:00.000Z' for legacy
}
```

Both fields are required strings (not optional), matching the convention that Entity fields are always present (`project: string | null`, never `undefined`).

### 1.5 JSONL Backend

- `saveGraph()` serializes `updatedAt` and `createdAt` on entity lines
- `loadGraph()` reads `updatedAt`/`createdAt` from parsed entities, defaulting to `'0000-00-00T00:00:00.000Z'` for legacy JSONL files that lack these fields

---

## 2. Pagination Types and GraphStore Interface

### 2.1 New Types (types.ts)

```typescript
/** Pagination parameters for read_graph and search_nodes. */
export interface PaginationParams {
  cursor?: string;   // Opaque base64-encoded cursor from a previous response
  limit?: number;    // 1-100, default 40
}

/** Paginated knowledge graph result. */
export interface PaginatedKnowledgeGraph extends KnowledgeGraph {
  nextCursor: string | null;  // null = no more pages
  totalCount: number;         // Total matching entities (may vary between pages if data mutates)
}

/** Thrown when an opaque cursor string cannot be decoded or is structurally invalid. */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}
```

### 2.2 GraphStore Interface Changes

Existing `readGraph` and `searchNodes` signatures change — pagination params added, return type becomes `PaginatedKnowledgeGraph`:

```typescript
export interface GraphStore {
  // ... all other methods unchanged ...
  readGraph(projectId?: string, pagination?: PaginationParams): Promise<Readonly<PaginatedKnowledgeGraph>>;
  searchNodes(query: string, projectId?: string, pagination?: PaginationParams): Promise<Readonly<PaginatedKnowledgeGraph>>;
}
```

When `pagination` is omitted, methods return all results with `nextCursor: null` and `totalCount` = full count. Since `PaginatedKnowledgeGraph extends KnowledgeGraph`, existing code that destructures `{ entities, relations }` continues to work.

---

## 3. Cursor Encoding and Keyset Queries

### 3.1 Cursor Payload

```typescript
interface CursorPayload {
  u: string;   // updatedAt of last entity on page
  i: number;   // SQLite entity id (tiebreaker for SQLite)
  n?: string;  // Entity name (tiebreaker for JSONL — stable across mutations unlike array indices)
  q: string;   // Query fingerprint — prevents cross-query cursor misuse
}
```

### 3.2 Encode / Decode

```typescript
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
```

### 3.3 Query Fingerprint Composition

- `readGraph`: `"readGraph:" + (projectId ?? "")`
- `searchNodes`: `"searchNodes:" + (projectId ?? "") + ":" + query`
- `limit` is excluded — changing page size between requests is valid

### 3.4 SQLite Keyset Query

```sql
SELECT name, entity_type AS entityType, project, updated_at, id
FROM entities
WHERE (project = ? OR project IS NULL)                          -- project filter (if scoped)
  AND (updated_at < ? OR (updated_at = ? AND id < ?))          -- cursor condition (if cursor provided)
ORDER BY updated_at DESC, id DESC
LIMIT ? + 1                                                     -- peek ahead to detect next page
```

- Cursor condition only appended when cursor is provided; first page omits it
- `LIMIT n+1`: fetch one extra row to detect if a next page exists without a separate query. If `rows.length > limit`, there is a next page — return only the first `limit` rows and encode the last one as `nextCursor`
- Total count: separate `SELECT COUNT(*)` with same WHERE clause (minus cursor/limit)

### 3.5 JSONL Keyset

- Sort in-memory entity array by `(updatedAt DESC)`, with entity name alphabetical (ascending) as secondary sort for determinism
- Find cursor position by matching `entity.name === cursor.n && entity.updatedAt === cursor.u`
- Slice from cursor position, take `limit + 1`
- Entity name (globally unique) is the tiebreaker — stable across mutations, unlike array indices

---

## 4. MCP Tool Changes and `updated_at` Triggers

### 4.1 Tool Input/Output Schema Changes

Both `read_graph` and `search_nodes` gain:

**Input additions:**
```typescript
cursor: z.string().optional()
  .describe("Opaque cursor from a previous response for fetching the next page. Omit for first page."),
limit: z.number().int().min(1).max(100).optional().default(40)
  .describe("Max entities per page (default 40, max 100)"),
```

Note: `.optional().default(40)` — this ordering ensures the parsed type is always `number` (Zod applies the default when the value is `undefined`). The reverse ordering `.default(40).optional()` would produce `number | undefined`.

**Output additions:**
```typescript
nextCursor: z.string().nullable()
  .describe("Cursor for the next page, or null if this is the last page"),
totalCount: z.number()
  .describe("Total number of matching entities across all pages"),
```

**Both `text` and `structuredContent` include pagination metadata** — not all MCP clients support `structuredContent`, so the JSON blob in `text` must also contain `nextCursor` and `totalCount`.

### 4.2 Tool Description Updates

`read_graph` description changes from:
> "Read the entire knowledge graph"

To:
> "Read the knowledge graph. Returns entities sorted by most recently updated, paginated. Use the returned nextCursor to fetch subsequent pages. Omit cursor for the first page."

`search_nodes` description changes from:
> "Search for nodes in the knowledge graph based on a query"

To:
> "Search for nodes in the knowledge graph. Returns matching entities sorted by most recently updated, paginated. Use the returned nextCursor to fetch subsequent pages. Omit cursor for the first page."

### 4.3 Which Operations Update `updated_at`

| Operation | Updates `updated_at`? | Rationale |
|---|---|---|
| `createEntities` | Yes — set on INSERT | Entity is born |
| `addObservations` | Yes — UPDATE parent entity | Entity content changed |
| `deleteObservations` | Yes — UPDATE parent entity | Entity content changed |
| `deleteEntities` | No | Row is deleted entirely |
| `createRelations` | No | Entity content unchanged — only connectivity changed. Updating `updated_at` for relation changes degrades cursor stability (a single call with 50 relations could bump 100 entities, reshuffling sort order mid-pagination). Claude can use `open_nodes` for full relation context. |
| `deleteRelations` | No | Same rationale as createRelations |

**SQLite:** Add `UPDATE entities SET updated_at = ? WHERE id = ?` inside existing transactions for `addObservations` and `deleteObservations`. Set `updated_at` directly in the INSERT for `createEntities`.

**JSONL:** Set `entity.updatedAt = new Date().toISOString()` in the same code paths.

`created_at`: Set once in `createEntities`, never updated.

---

## 5. Relation Handling Across Pages

Relations are included only when **both endpoints** are in the current page's entity set. This matches the existing project-filtering behavior and avoids dangling references.

### 5.1 Known Limitation

Paginating through all pages and unioning the relation sets does **not** yield the same result as an unpaginated query. A relation between entity A (page 1) and entity C (page 3) appears on neither page because the other endpoint is absent.

**Workaround:** Use `open_nodes` with specific entity names to get full relation context. `open_nodes` is not paginated and returns all connected relations for the requested entities.

### 5.2 Cursor Stability

Keyset pagination on a mutable sort key (`updated_at`) means:
- If an entity's `updated_at` changes between page fetches (e.g., someone adds an observation), the entity could appear on two pages or be skipped
- This is inherent to keyset pagination and is the right tradeoff — freshness matters more than perfect enumeration for a memory server

---

## 6. Summary of Changes by File

| File | Changes |
|---|---|
| `types.ts` | Add `updatedAt`/`createdAt` to `Entity`, add `PaginationParams`, `PaginatedKnowledgeGraph`, `InvalidCursorError`. Change `readGraph`/`searchNodes` signatures on `GraphStore`. |
| `sqlite-store.ts` | Schema migration (columns + indexes + backfill). Update `createEntities`/`addObservations`/`deleteObservations` to set `updated_at`. Implement keyset pagination in `readGraph`/`searchNodes`. Add `buildEntities` to include `updatedAt`/`createdAt`. Cursor encode/decode utilities. |
| `jsonl-store.ts` | Read/write `updatedAt`/`createdAt` in `loadGraph`/`saveGraph`. Update `createEntities`/`addObservations`/`deleteObservations` to set `updatedAt`. Implement in-memory pagination in `readGraph`/`searchNodes`. |
| `index.ts` | Update Zod schemas (cursor, limit, nextCursor, totalCount). Update tool descriptions. Pass pagination params to store methods. Include pagination metadata in both `text` and `structuredContent`. |
| `__tests__/knowledge-graph.test.ts` | Parameterized pagination tests: default limit, custom limit, cursor continuation, empty page, first page without cursor, cross-query cursor rejection, `InvalidCursorError`, `totalCount` accuracy, `updatedAt` updates on add/delete observations, relation filtering across pages. |
