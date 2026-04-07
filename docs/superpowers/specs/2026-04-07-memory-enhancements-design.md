# Memory Enhancements: Vector Search, Observation Supersede, Hook Updates

**Date:** 2026-04-07
**Status:** Approved
**Origin:** Evaluation of [mempalace](https://github.com/milla-jovovich/mempalace) project against existing mcp-memory-server + file-based memory system. Goal: close the search gap (semantic recall) and the drift gap (stale observations accumulating).

## Problem Statement

The current memory system has two gaps:

1. **Search gap:** LIKE substring matching is excellent for exact technical strings (`better-sqlite3`, `idx_entities_project`) but misses semantic matches. Searching for "authentication" won't find entities about "login," "OAuth," or "session tokens."

2. **Drift gap:** Observations are append-only. When a fact changes (e.g., test count goes from 262 to 290), a new observation is added but the old one remains active. Over time, stale observations accumulate and can be recalled as current. This is a write problem, not a read problem — updates need to be frictionless.

## Design Overview

Four features in a single integrated release:

| Feature | Gap | Summary |
|---------|-----|---------|
| Vector search | Search | sqlite-vec + @huggingface/transformers for semantic KNN alongside LIKE |
| Observation supersede | Drift | `supersede_observations` tool atomically retires old + inserts new |
| Hook updates | Drift | SessionEnd and PreCompact hooks learn to use supersede |
| CLAUDE.md rules | Drift | Guidance on when to supersede vs. append |

## Section 1: Schema Changes

### 1.1 Observations table — `superseded_at` column

Add `superseded_at TEXT NOT NULL DEFAULT ''` to the observations table:

- `''` (empty string sentinel) = active observation
- ISO 8601 UTC timestamp = superseded at that time

**Why a sentinel instead of NULL?** SQLite treats each NULL as unique in UNIQUE constraints. Using `NULL` for "active" would allow duplicate active observations on the same entity. The empty string sentinel participates in uniqueness correctly.

**Constraint change:** `UNIQUE(entity_id, content)` becomes `UNIQUE(entity_id, content, superseded_at)`. This allows the same content to exist in both active and superseded states (and to be re-asserted after supersession).

**Migration:** SQLite can't ALTER constraints, so this requires a table rebuild:

```sql
BEGIN;
CREATE TABLE observations_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  superseded_at TEXT NOT NULL DEFAULT '',
  UNIQUE(entity_id, content, superseded_at)
);
INSERT INTO observations_new (id, entity_id, content, created_at, superseded_at)
  SELECT id, entity_id, content, created_at, '' FROM observations;
DROP TABLE observations;
ALTER TABLE observations_new RENAME TO observations;
COMMIT;
```

### 1.2 Partial index on active observations

```sql
CREATE INDEX idx_observations_active ON observations(entity_id)
  WHERE superseded_at = '';
```

All queries that filter active observations (search, read, open) use this index. Superseded observations are only accessed for history/audit — no index needed.

### 1.3 Vector observations table

```sql
CREATE VIRTUAL TABLE vec_observations USING vec0(
  observation_id INTEGER PRIMARY KEY,
  embedding float[384]
);
```

Maps 1:1 with **active** observations. `observation_id` references `observations.id`. Virtual tables don't participate in CASCADE, so all delete/supersede paths must explicitly maintain this table.

### 1.4 Filtering superseded observations

All existing queries that read observations add `WHERE superseded_at = ''`:

- `readGraph` — entity loading
- `searchNodes` — LIKE matching
- `openNodes` — entity detail
- `addObservations` — dedup check

Superseded observations are invisible to normal operations. Zero risk of stale recall.

## Section 2: `supersede_observations` Tool

### 2.1 Tool signature

```
supersede_observations({
  supersessions: [{
    entityName: string,   // which entity to update
    oldContent: string,   // observation text to retire
    newContent: string    // replacement observation text
  }].max(100)
})
```

### 2.2 Behavior

1. For each item, find the active observation matching `(entity_id, content)` where `superseded_at = ''`
2. Set that row's `superseded_at` to current UTC timestamp
3. Insert a new observation row with `newContent`, current timestamp for `created_at`, `superseded_at = ''`
4. Delete the old embedding from `vec_observations` (explicit — no CASCADE, synchronous, inside transaction)
5. Update the entity's `updated_at` timestamp
6. All SQL operations (steps 1-5) within a single synchronous transaction — all succeed or all roll back
7. After transaction commits, generate new embedding and insert into `vec_observations` (async — see Section 3.3)

### 2.3 Error handling

- **`oldContent` not found** (already superseded or never existed): **throw**. Silent skips would mask bugs in hooks.
- **`newContent` already exists as active observation:** Skip the insert (idempotent for the new value).
- **Embedding generation fails:** Observation is still superseded/created. Embedding stays NULL for sweep pickup (Section 3.5).

### 2.4 JSONL store

Stub: `throw new Error('supersede_observations not supported: migrate to SQLite')`.

### 2.5 GraphStore interface

Add to the `GraphStore` interface:

```typescript
supersedeObservations(supersessions: Array<{
  entityName: string;
  oldContent: string;
  newContent: string;
}>): Promise<void>;
```

## Section 3: Vector Search Integration

### 3.1 Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `sqlite-vec` (npm) | SQLite loadable extension for vec0 virtual tables + KNN | Native binary, platform-specific |
| `@huggingface/transformers` (npm) | Local ONNX model runner | ~50-80MB installed (includes ONNX runtime) |

Model: `all-MiniLM-L6-v2` — 384 dimensions, ~23MB download (cached after first use). No external software install required.

### 3.2 Vector state machine

```typescript
type VectorState =
  | { status: 'loading' }
  | { status: 'ready'; pipeline: FeatureExtractionPipeline }
  | { status: 'failed'; error: Error; failedAt: string }
  | { status: 'unavailable' };  // sqlite-vec couldn't load or MEMORY_VECTOR_SEARCH=off
```

Replaces a naive boolean flag. Logged at every transition. On `failed`, error included in `search_nodes` response. On repeated runtime failures (N consecutive), transitions `ready` -> `failed`.

### 3.3 Decoupled embedding writes

Key constraint: `better-sqlite3` transactions are synchronous. Embedding generation is async (`await pipeline(text)`). These cannot be mixed.

Pattern for all write operations:

```
1. Run synchronous transaction (insert/update observations in core tables)
2. After transaction commits, attempt async embedding generation
3. Insert embedding into vec_observations (separate sync call)
4. If embedding fails: observation is saved, embedding missing — picked up by sweep
```

Centralized in a single helper:

```typescript
private async syncEmbedding(
  observationId: number,
  content: string,
  action: 'upsert' | 'delete'
): Promise<void>
```

All 6 mutation paths call this helper: `createEntities`, `addObservations`, `deleteObservations`, `deleteEntities`, `supersedeObservations`, `migrateFromJsonl`.

The helper checks `vectorState.status` before acting. On `'loading'` or `'failed'` or `'unavailable'`, it skips (delete actions still run if the vec table exists). Every `pipeline()` call is wrapped in try-catch — failures log and skip, never crash.

### 3.4 `loadExtension()` error handling

```typescript
try {
  this.db.loadExtension(sqliteVecPath);
  // create vec_observations table
} catch (err) {
  console.error(
    `sqlite-vec extension not available (${process.arch}/${process.platform}): ${err.message}. ` +
    `Vector search disabled. LIKE search remains functional.`
  );
  this.vectorState = { status: 'unavailable' };
}
```

Env var `MEMORY_VECTOR_SEARCH=off` skips extension loading entirely.

### 3.5 Universal embedding sweep

After model loads (status transitions to `ready`), run a single sweep:

```sql
SELECT o.id, o.content FROM observations o
LEFT JOIN vec_observations v ON o.id = v.observation_id
WHERE v.observation_id IS NULL
  AND o.superseded_at = ''
ORDER BY o.id
```

This catches all un-embedded active observations regardless of origin: pre-existing data, observations created during loading window, failed embedding attempts, migrated data. Runs in batches of 100 with `setImmediate` yields between batches to avoid blocking the event loop.

Replaces the previous backfill design (key_value cursor table). Simpler, handles all edge cases with one mechanism.

### 3.6 Startup consistency check

On every startup after loading the extension, run:

```sql
-- Orphaned embeddings (vec row with no matching observation)
SELECT COUNT(*) FROM vec_observations v
LEFT JOIN observations o ON v.observation_id = o.id
WHERE o.id IS NULL;
```

If count > 0, delete orphans and log. Missing embeddings are handled by the sweep (3.5).

### 3.7 Hybrid search in `searchNodes`

Two-phase approach (keeps pagination clean):

1. Run existing LIKE query -> set of entity IDs (unchanged code)
2. If `vectorState.status === 'ready'`:
   a. Embed query string (try-catch — fall back to LIKE-only on failure)
   b. KNN search on `vec_observations` -> observation IDs -> map to entity IDs via JOIN
3. Union entity ID sets **in JavaScript**
4. Single paginated SQL query: `WHERE id IN (union_set)` with existing keyset logic on `(updated_at DESC, id DESC)`
5. `totalCount` = size of the union set

LIKE stays primary — superior for exact technical strings. Vectors add supplementary matches that LIKE would miss (semantic recall).

### 3.8 JSONL store

Not implemented. Stub methods that throw with migration message.

### 3.9 Smoke test

Before any production code, write a minimal script that loads `sqlite-vec` via `better-sqlite3`, creates a vec0 table, inserts a vector, and runs a KNN query. Validates platform compatibility early.

## Section 4: Hook Updates

### 4.1 SessionEnd hook

Add supersede guidance to the existing prompt:

> "Before adding an observation, check if the entity already has an observation covering the same fact (e.g., status, test count, function signature). If it does, use `supersede_observations` to atomically retire the old one and insert the updated version. Only use `add_observations` for genuinely new facts that don't replace existing information."

No other changes to the hook. Same trigger, timeout, format.

### 4.2 PreCompact hook

Add the same supersede guidance to the PreCompact prompt. Both hooks should behave identically with respect to supersede vs. append.

### 4.3 Deployment order

The `supersede_observations` MCP tool must be deployed (server rebuilt and restarted) before the hooks reference it. If the tool doesn't exist when the hook agent tries to call it, the hook will fail.

## Section 5: CLAUDE.md Rule Additions

Add to the mcp-memory-server CLAUDE.md under a new "Memory Maintenance" section:

### Memory write guidance

- **Supersede** when an observation states a fact that has changed (status, counts, signatures, descriptions). The old observation is retired, not deleted — it remains in the database for history but is filtered from active queries.
- **Append** when an observation adds a genuinely new fact that doesn't contradict or update any existing observation.
- **Never delete** observations to "clean up" — supersede preserves history and avoids accidental data loss.

### Vector search notes

- Vector search is available when the embedding model is loaded (check `vectorState`).
- LIKE search always runs. Vector search adds supplementary semantic matches.
- If `MEMORY_VECTOR_SEARCH=off` is set, only LIKE search is available.
- JSONL backend does not support vector search.

## Known Limitations

- **Vector search is best-effort.** If the model fails to load, the extension is unavailable, or embedding fails for specific observations, the system degrades gracefully to LIKE-only. No data is lost.
- **Embedding latency on writes.** Embedding generation adds ~5-15ms per observation after the transaction commits. This is async and does not block the response, but the embedding may not be available for search until the next query.
- **Event loop blocking during sweep.** The initial embedding sweep processes batches of 100 observations. Each batch blocks the event loop for ~500ms-1.5s of CPU inference. `setImmediate` yields between batches mitigate this.
- **vec0 is brute-force KNN.** At the current scale (~1500 observations), sub-millisecond. At ~50,000+, consider switching to an ANN index (sqlite-vec supports IVF).
- **No duplicate embedding dedup.** If the same observation text appears on 10 entities, it gets embedded 10 times. Negligible at current scale.
- **Pagination sorts by `updatedAt`, not semantic relevance.** Vector search improves recall (finding entities LIKE would miss) but does not affect ranking. A semantically perfect match from 6 months ago could be on a later page.

## Test Plan

- All existing 262 tests must continue to pass (no behavioral regression)
- New tests for `supersede_observations`: basic supersede, idempotent re-insert, missing oldContent throws, batch atomicity, entity updatedAt bump, superseded observations invisible to readGraph/searchNodes/openNodes
- New tests for vector search: hybrid search finds semantic matches, LIKE-only fallback when model unavailable, orphan cleanup on startup, sweep catches un-embedded observations, `loadExtension` failure degrades gracefully, env var disables vector search
- New tests for vec_observations sync: every mutation path (create, add, delete, deleteEntity, supersede, migrate) leaves vec_observations consistent
- Parameterized suite: supersede tests run against both stores (SqliteStore real implementation, JsonlStore throws)

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| sqlite-vec | latest | SQLite vector extension |
| @huggingface/transformers | latest | Local ONNX embedding model runner |

No external software installation required. Both are npm packages with pre-built native binaries.
