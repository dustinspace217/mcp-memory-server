# Phase 2: SQLite Storage Backend

## Goal

Replace the JSONL flat-file storage with SQLite as the default backend. This gives us database-level dedup constraints, foreign key enforcement, concurrent-safe access, and indexed queries — eliminating limitations that were previously worked around in application code.

## Non-Goals

- FTS5 full-text search (LIKE is fast enough at personal scale; FTS5 changes search semantics)
- Multi-hop graph traversal (simple 1-hop queries are sufficient)
- Removing the JSONL backend (kept as a fallback)
- Project scoping or pagination (Phase 3 and Phase 4)

---

## Architecture

### File Split

The current monolithic `index.ts` (~710 lines) splits into four files:

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `types.ts` | Interfaces, named input/output types, `createObservation()` helper | ~80 |
| `jsonl-store.ts` | `JsonlStore` (renamed `KnowledgeGraphManager`), `normalizeObservation()`, `ensureMemoryFilePath()` | ~300 |
| `sqlite-store.ts` | `SqliteStore`, schema creation, JSONL migration | ~350 |
| `index.ts` | MCP server, Zod schemas, tool registrations, store selection, `main()` | ~200 |

Rationale for keeping Zod schemas in `index.ts`: they are MCP transport-layer concerns (input validation, output shape), not data model concerns. Putting them in `types.ts` would couple the type module to `zod` unnecessarily.

### GraphStore Interface

Both stores implement this interface. Methods mirror the current `KnowledgeGraphManager` public API with two additions (`init`/`close`) for lifecycle management.

```typescript
interface GraphStore {
  /** One-time setup: create tables, run migrations, etc. No-op for JSONL. */
  init(): Promise<void>;

  /** Cleanup: close DB connection. No-op for JSONL. */
  close(): Promise<void>;

  createEntities(entities: EntityInput[]): Promise<Readonly<Entity[]>>;
  createRelations(relations: Relation[]): Promise<Readonly<Relation[]>>;
  addObservations(observations: AddObservationInput[]): Promise<Readonly<AddObservationResult[]>>;
  deleteEntities(entityNames: string[]): Promise<void>;
  deleteObservations(deletions: DeleteObservationInput[]): Promise<void>;
  deleteRelations(relations: Relation[]): Promise<void>;
  readGraph(): Promise<Readonly<KnowledgeGraph>>;
  searchNodes(query: string): Promise<Readonly<KnowledgeGraph>>;
  openNodes(names: string[]): Promise<Readonly<KnowledgeGraph>>;
}
```

### Named Input/Output Types

Extracted into `types.ts` to clean up the interface signatures:

```typescript
type EntityInput = {
  name: string;
  entityType: string;
  observations: (string | Observation)[];
};

type AddObservationInput = {
  entityName: string;
  contents: string[];
};

type DeleteObservationInput = {
  entityName: string;
  contents: string[];  // renamed from 'observations' for consistency
};

type AddObservationResult = {
  entityName: string;
  addedObservations: Observation[];
};
```

**Breaking change:** `DeleteObservationInput.contents` was previously named `observations` in the `delete_observations` tool schema. This rename standardizes with `AddObservationInput.contents`. MCP clients discover schemas dynamically at connection time, so this is transparent in practice. Version bumps to `0.8.0`.

---

## SQLite Schema

```sql
PRAGMA foreign_keys = ON;   -- must be set per-connection (not persisted by SQLite)
PRAGMA journal_mode = WAL;  -- write-ahead logging for concurrent read performance

CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,  -- ISO 8601 UTC string, or 'unknown' for migrated data
  UNIQUE(entity_id, content)
);

CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
  to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
  relation_type TEXT NOT NULL,
  UNIQUE(from_entity, to_entity, relation_type)
);
```

### Design Decisions

**Name-based FK on relations:** Relations reference `entities.name` (which has a UNIQUE constraint) rather than `entities.id`. This avoids JOINs when reconstructing `Relation` objects for the API, since the API speaks entity names, not numeric IDs. `ON UPDATE CASCADE` is included for free future-proofing if entity rename is ever added.

**`created_at` as TEXT:** Preserves the `'unknown'` sentinel from legacy data without requiring a schema-level conversion. SQL can sort by this column (unknown sorts before ISO dates alphabetically, placing legacy data first).

**`UNIQUE(entity_id, content)` on observations:** Enforces the dedup invariant at the database level. The application code no longer needs Set-based dedup for observations — `INSERT OR IGNORE` handles it.

**`UNIQUE(from_entity, to_entity, relation_type)` on relations:** Enforces relation dedup at the database level. No more JSON.stringify composite keys.

**PRAGMA foreign_keys = ON:** Prevents dangling relations (relations referencing non-existent entities). This is a behavior change — the JSONL store allows dangling relations. The SQLite store will reject `createRelations` calls where an endpoint entity doesn't exist.

---

## Store Selection

The `ensureMemoryFilePath()` function is refactored to return a richer type:

```typescript
type StoreConfig = { path: string; storeType: 'jsonl' | 'sqlite' };
```

Selection logic:
- `MEMORY_FILE_PATH` ends in `.jsonl` → `{ path, storeType: 'jsonl' }`
- `MEMORY_FILE_PATH` ends in `.db` or `.sqlite` → `{ path, storeType: 'sqlite' }`
- `MEMORY_FILE_PATH` with any other extension → throw error with helpful message
- No `MEMORY_FILE_PATH` set → `{ path: 'memory.db', storeType: 'sqlite' }` (default)

The `main()` function uses `storeType` to instantiate the correct store.

---

## Migration (JSONL to SQLite)

Migration runs inside `SqliteStore.init()` — it is a store initialization concern, not a path resolution concern.

### Trigger Conditions

Migration runs when ALL of these are true:
1. The target `.db` file does not yet exist
2. A `.jsonl` file is found at the same location (swap extension), or `memory.jsonl` exists alongside the script (for the default-path case)

If the `.db` file already exists, migration is skipped entirely — no risk of double-importing.

### Migration Steps

1. Read the JSONL file using `JsonlStore.readGraph()` (reuses existing parsing + normalizeObservation logic)
2. Open a new SQLite database, create tables
3. Inside a **single SQLite transaction** (`db.transaction()`):
   - Insert all entities with `INSERT OR IGNORE` (tolerates pre-existing duplicates in corrupted JSONL)
   - Insert all observations with `INSERT OR IGNORE` (tolerates duplicate content within an entity)
   - Insert all relations with `INSERT OR IGNORE` (tolerates duplicate relations)
4. Rename the JSONL file to `.jsonl.bak`
5. Log the migration to stderr (matching the existing `.json` → `.jsonl` pattern)

If any step fails, the transaction rolls back and the JSONL file is untouched.

### Migration Scenarios

**Scenario 1: Default location (no custom MEMORY_FILE_PATH)**
- Server starts, looks for `memory.db` (new default), doesn't find it
- Checks for `memory.jsonl` alongside script, finds it → auto-migrates
- Zero user action required

**Scenario 2: Custom MEMORY_FILE_PATH pointing to a .jsonl file**
- Server sees `.jsonl` extension → uses JSONL store, nothing changes
- To migrate: change config to point to `.db` file at same location
- On first run, server auto-migrates from the `.jsonl` file

**Scenario 3: User wants to stay on JSONL**
- Keep `MEMORY_FILE_PATH` pointing to a `.jsonl` file
- Nothing changes

### Rollback

The `.jsonl.bak` file is kept so users can roll back:
1. Rename `.jsonl.bak` back to `.jsonl`
2. Delete `.db` file or change `MEMORY_FILE_PATH` to point to `.jsonl`
3. Restart

Note: The backup is a snapshot at migration time. Post-migration data written to SQLite is not in the backup.

---

## Search Implementation

`searchNodes` uses `LIKE '%query%'` with wildcard escaping to preserve the current substring-match behavior:

```typescript
// Escape LIKE special characters to match literal substrings
function escapeLike(query: string): string {
  return query.replace(/[%_\\]/g, '\\$&');
}

// Query pattern: LIKE '%escaped_query%' ESCAPE '\'
```

This matches the current `String.includes()` behavior exactly. FTS5 is not used — it tokenizes words and would change search semantics (e.g., "cme" would no longer match "Acme").

The search queries both `entities` (name, entity_type) and `observations` (content), unions the matching entity IDs, then fetches full entities + connected relations.

---

## SQLite Library

**`better-sqlite3`** — synchronous API, fastest Node.js SQLite binding, well-maintained.

- Requires C compiler for native addon (user has gcc/g++ on Fedora; JSONL fallback exists for environments without build tools)
- Synchronous API is ideal for a stdio-based MCP server handling one request at a time (no event loop to starve)
- `GraphStore` interface returns `Promise<T>` for uniformity — `SqliteStore` methods are `async` functions that return sync results (auto-wrapped in resolved promises, negligible overhead)

Added to dependencies:
- `better-sqlite3` (runtime)
- `@types/better-sqlite3` (dev)

---

## Test Strategy

### Parameterized Test Suite

The existing 60 tests are refactored into a shared suite that runs against both stores:

```typescript
describe.each([
  ['JsonlStore', () => new JsonlStore(tempJsonlPath)],
  ['SqliteStore', () => new SqliteStore(tempDbPath)],
])('%s', (name, createStore) => {
  let store: GraphStore;

  beforeEach(async () => {
    store = createStore();
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    // cleanup temp files
  });

  // All behavioral tests run identically against both implementations
});
```

### Store-Specific Tests

**JSONL-only:**
- Legacy string observation migration (normalizeObservation)
- Malformed JSONL line isolation (per-line try/catch)
- `.json` → `.jsonl` file migration
- Atomic write (.tmp file + rename)

**SQLite-only:**
- FK constraint enforcement (reject relations to non-existent entities)
- LIKE wildcard escaping (`%` and `_` treated as literals)
- JSONL → SQLite auto-migration (data preserved, .bak created)
- WAL journal mode verification
- `INSERT OR IGNORE` behavior for duplicate handling

---

## Other Changes

### Version Bump
`0.7.0` → `0.8.0` in `package.json` and the MCP server `version` field.

### tsconfig.json
Update `include` from `["index.ts"]` to include all new source files.

### Deferred Items Picked Up
- **`EntityInput` named type** — extracted from inline anonymous type in `createEntities` parameter
- **`Readonly` on return types** — shallow `Readonly` on `GraphStore` return types to prevent accidental mutation
- **FK constraints** — `PRAGMA foreign_keys = ON` + `REFERENCES` with `ON DELETE CASCADE`
- **`ON UPDATE CASCADE`** on relation FKs — free future-proofing for potential entity rename feature

### README Updates (when shipped)
- Change intro from "JSONL-backed graph" to "persistent knowledge graph"
- Update default config example from `.jsonl` to `.db`
- Update Data Model section to mention both backends
- Mark SQLite as done in Planned Phases
- Add Storage Backends section (drafted by documenter agent — covers all 3 migration scenarios and rollback)

### CLAUDE.md Updates (when shipped)
- Update architecture section for new file structure
- Update test counts
- Mark Phase 2 as done
- Note JSONL fallback and store selection

---

## What This Does NOT Cover

- FTS5 full-text search (add later if LIKE becomes a bottleneck)
- Project filtering / scoping (Phase 3)
- Pagination (Phase 4)
- Entity rename feature (ON UPDATE CASCADE is in place for it)
- MCP tool-level integration tests (open issue #23 — separate from this work)
