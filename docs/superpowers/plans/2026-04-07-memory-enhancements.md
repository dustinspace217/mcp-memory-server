# Memory Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the memory system's search gap (add semantic vector search) and drift gap (add observation supersede mechanism) in a single integrated release.

**Architecture:** Add `superseded_at` column to observations table for temporal versioning, with a new `supersede_observations` MCP tool. Layer semantic vector search on top via `sqlite-vec` extension + `@huggingface/transformers` for local ONNX embeddings. All mutation paths use a centralized `syncEmbedding()` helper. Hybrid search merges LIKE + KNN results in JavaScript before pagination.

**Tech Stack:** TypeScript, Node.js 22, better-sqlite3, sqlite-vec (npm), @huggingface/transformers (npm, all-MiniLM-L6-v2 ONNX model), Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `types.ts` | Modify | Add `supersedeObservations` to `GraphStore` interface, `SupersedeInput` type |
| `sqlite-store.ts` | Modify | Schema migration (superseded_at, vec_observations), `supersedeObservations()`, `syncEmbedding()`, hybrid `searchNodes()`, embedding sweep, startup consistency check, `loadExtension()` |
| `jsonl-store.ts` | Modify | Add stub `supersedeObservations()` that throws |
| `index.ts` | Modify | Register `supersede_observations` MCP tool, bump version to 0.11.0 |
| `embedding.ts` | Create | Embedding pipeline wrapper: lazy model loading, state machine, `embed()` method, `embedBatch()` |
| `package.json` | Modify | Add `sqlite-vec` and `@huggingface/transformers` dependencies |
| `tsconfig.json` | Modify | Add `embedding.ts` to `include` array |
| `CLAUDE.md` | Modify | Add Memory Maintenance section, vector search notes, update architecture docs |
| `__tests__/knowledge-graph.test.ts` | Modify | Supersede tests (parameterized), superseded_at filtering tests |
| `__tests__/vector-search.test.ts` | Create | Vector search tests: hybrid search, fallback, sweep, consistency, env var |
| `__tests__/smoke-test-vec.ts` | Create | One-off sqlite-vec compatibility check script |

---

### Task 1: Smoke-test sqlite-vec + better-sqlite3 compatibility

**Files:**
- Create: `__tests__/smoke-test-vec.ts`

This task validates that `sqlite-vec` loads correctly on this platform before we write any production code. It's a throwaway script, not a permanent test.

- [ ] **Step 1: Install sqlite-vec**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm install sqlite-vec
```

Expected: Successful install. The `sqlite-vec` package contains pre-built native binaries for common platforms.

- [ ] **Step 2: Write the smoke test script**

Create `__tests__/smoke-test-vec.ts`:

```typescript
// smoke-test-vec.ts -- One-off check that sqlite-vec loads and works
// with better-sqlite3. Run with: npx tsx __tests__/smoke-test-vec.ts
// Not a vitest test -- just a script that exits 0 on success, 1 on failure.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Open an in-memory database (no file needed for this test)
const db = new Database(':memory:');

// Load the sqlite-vec extension into the database connection.
// sqliteVec.load() calls db.loadExtension() internally with the correct
// path to the native .so/.dylib binary shipped by the sqlite-vec npm package.
sqliteVec.load(db);

// Create a vec0 virtual table with 384-dimensional float vectors
// (matches all-MiniLM-L6-v2 output dimensionality)
db.exec(`
  CREATE VIRTUAL TABLE test_vec USING vec0(
    item_id INTEGER PRIMARY KEY,
    embedding float[384]
  );
`);

// Insert a test vector (all zeros except first element = 1.0)
const testVector = new Float32Array(384);
testVector[0] = 1.0;

// vec0 expects the embedding as a raw binary blob of float32 values.
// Buffer.from(testVector.buffer) wraps the Float32Array's ArrayBuffer
// as a Node.js Buffer for SQLite binding.
db.prepare('INSERT INTO test_vec (item_id, embedding) VALUES (?, ?)').run(
  1,
  Buffer.from(testVector.buffer)
);

// Run a KNN query: find the 1 nearest neighbor to our query vector
const queryVector = new Float32Array(384);
queryVector[0] = 0.9;  // Similar to our stored vector

// vec0 KNN syntax: WHERE embedding MATCH ? AND k = ?
// Returns rows with item_id and distance (lower = more similar)
const results = db.prepare(`
  SELECT item_id, distance
  FROM test_vec
  WHERE embedding MATCH ? AND k = ?
`).all(Buffer.from(queryVector.buffer), 1) as { item_id: number; distance: number }[];

if (results.length !== 1 || results[0].item_id !== 1) {
  console.error('FAIL: KNN query returned unexpected results:', results);
  process.exit(1);
}

console.log('PASS: sqlite-vec loaded, virtual table created, KNN query works');
console.log(`  Result: item_id=${results[0].item_id}, distance=${results[0].distance}`);

// Cleanup
db.close();
```

- [ ] **Step 3: Run the smoke test**

```bash
cd /home/dustin/Claude/mcp-memory-server
npx tsx __tests__/smoke-test-vec.ts
```

Expected output:
```
PASS: sqlite-vec loaded, virtual table created, KNN query works
  Result: item_id=1, distance=<some small number>
```

If this fails with a load error, `sqlite-vec` is incompatible with this platform's `better-sqlite3`. Stop and investigate before proceeding.

- [ ] **Step 4: Commit**

```bash
git add __tests__/smoke-test-vec.ts package.json package-lock.json
git commit -m "chore: smoke test sqlite-vec + better-sqlite3 compatibility"
```

---

### Task 2: Install @huggingface/transformers and verify embedding generation

**Files:**
- Modify: `__tests__/smoke-test-vec.ts` (append embedding test)
- Modify: `package.json` (new dependency)

- [ ] **Step 1: Install @huggingface/transformers**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm install @huggingface/transformers
```

Expected: Successful install. First run will download the ONNX model (~23MB).

- [ ] **Step 2: Add embedding test to the smoke script**

Append to the end of `__tests__/smoke-test-vec.ts` (before the `db.close()` line):

```typescript
// --- Part 2: Test @huggingface/transformers embedding generation ---
import { pipeline } from '@huggingface/transformers';

console.log('Loading embedding model (first run downloads ~23MB)...');

// pipeline() returns a FeatureExtractionPipeline that converts text to vectors.
// 'feature-extraction' is the task type for generating embeddings.
// 'Xenova/all-MiniLM-L6-v2' is the ONNX-converted version of the popular
// sentence-transformers model. 384 dimensions, fast, good for semantic similarity.
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  dtype: 'fp32',
});

// Generate an embedding for a test sentence.
// The result is a nested array: [[384 floats]]. We need the inner array.
const output = await embedder('This is a test sentence about programming.', {
  pooling: 'mean',       // Average all token embeddings into one vector
  normalize: true,       // L2-normalize so cosine similarity = dot product
});

// output.data is a Float32Array of the pooled embedding
const embedding = output.data as Float32Array;

if (embedding.length !== 384) {
  console.error(`FAIL: Expected 384 dimensions, got ${embedding.length}`);
  process.exit(1);
}

console.log(`PASS: Embedding generated, ${embedding.length} dimensions`);
console.log(`  First 5 values: [${Array.from(embedding.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);

// Test that the embedding can be inserted into sqlite-vec
db.prepare('INSERT INTO test_vec (item_id, embedding) VALUES (?, ?)').run(
  2,
  Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
);

// KNN search with the real embedding as query
const semanticResults = db.prepare(`
  SELECT item_id, distance
  FROM test_vec
  WHERE embedding MATCH ? AND k = 2
`).all(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), 2) as { item_id: number; distance: number }[];

console.log(`PASS: KNN search with real embedding returned ${semanticResults.length} results`);
```

- [ ] **Step 3: Run the combined smoke test**

```bash
cd /home/dustin/Claude/mcp-memory-server
npx tsx __tests__/smoke-test-vec.ts
```

Expected: Both parts pass. First run may take 10-30 seconds to download the model.

- [ ] **Step 4: Commit**

```bash
git add __tests__/smoke-test-vec.ts package.json package-lock.json
git commit -m "chore: verify @huggingface/transformers embedding + sqlite-vec integration"
```

---

### Task 3: Create the embedding pipeline module

**Files:**
- Create: `embedding.ts`
- Modify: `tsconfig.json`

This module encapsulates the embedding model lifecycle (state machine, lazy loading, embed/batch operations) so `sqlite-store.ts` doesn't have to know about ONNX internals.

- [ ] **Step 1: Write embedding.ts**

Create `embedding.ts`:

```typescript
// embedding.ts -- Embedding pipeline wrapper for vector search.
// Manages the lifecycle of the @huggingface/transformers model:
// loading -> ready -> failed state machine. Provides embed() and
// embedBatch() methods that check state before attempting inference.
// Used by SqliteStore for generating observation embeddings.

// FeatureExtractionPipeline is the type returned by pipeline('feature-extraction', ...).
// It takes text in, returns float vectors out.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/** The embedding model: all-MiniLM-L6-v2 converted to ONNX format.
 * 384 dimensions, ~23MB download. Cached locally after first use.
 * 'Xenova/' prefix means the ONNX-converted version on Hugging Face. */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/** Dimensionality of the embedding vectors. Must match the vec0 table definition. */
export const EMBEDDING_DIM = 384;

/** Maximum consecutive pipeline failures before transitioning to 'failed' state.
 * After this many failures, the pipeline stops attempting inference until restart. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * State machine for the embedding model lifecycle.
 * - 'loading': model download/init in progress
 * - 'ready': model loaded, pipeline available for inference
 * - 'failed': model failed to load or too many runtime failures
 * - 'unavailable': sqlite-vec extension not loaded or MEMORY_VECTOR_SEARCH=off
 */
export type VectorState =
  | { status: 'loading' }
  | { status: 'ready'; pipeline: FeatureExtractionPipeline }
  | { status: 'failed'; error: Error; failedAt: string }
  | { status: 'unavailable' };

/**
 * Manages the embedding model lifecycle and provides methods to generate embeddings.
 * Create one instance per SqliteStore. Call startLoading() after store.init().
 * Check state before calling embed/embedBatch -- they return null if not ready.
 */
export class EmbeddingPipeline {
  /** Current state of the model lifecycle */
  private _state: VectorState = { status: 'unavailable' };

  /** Counter for consecutive runtime failures. Resets on success. */
  private consecutiveFailures = 0;

  /** Returns the current state (read-only for callers to inspect) */
  get state(): VectorState {
    return this._state;
  }

  /**
   * Begins loading the embedding model in the background.
   * Transitions: unavailable -> loading -> ready | failed.
   * Does NOT block -- returns immediately.
   * Calls onReady callback when the model is loaded so the store
   * can trigger the embedding sweep.
   *
   * @param onReady - Callback invoked when model transitions to 'ready'
   */
  startLoading(onReady?: () => void): void {
    this._state = { status: 'loading' };
    console.error('Embedding model: loading...');

    // Dynamic import because @huggingface/transformers is ESM-only
    // and we want to avoid loading the heavy ONNX runtime if vector search
    // is disabled. import() returns a Promise -- we handle it async below.
    import('@huggingface/transformers').then(async ({ pipeline }) => {
      // pipeline() downloads the model on first run (~23MB), then caches it.
      // 'feature-extraction' is the task for generating dense vector embeddings.
      const pipe = await pipeline('feature-extraction', MODEL_NAME, {
        dtype: 'fp32',
      });

      this._state = { status: 'ready', pipeline: pipe };
      this.consecutiveFailures = 0;
      console.error('Embedding model: ready');

      if (onReady) onReady();
    }).catch((err: Error) => {
      this._state = { status: 'failed', error: err, failedAt: new Date().toISOString() };
      console.error(`Embedding model: failed to load: ${err.message}`);
      console.error('Vector search disabled. LIKE search remains functional.');
    });
  }

  /**
   * Generates a single embedding vector from text.
   * Returns null if the model isn't ready (loading, failed, unavailable).
   * Wraps pipeline() in try-catch so a runtime failure doesn't crash the caller.
   *
   * @param text - The observation content to embed
   * @returns Float32Array of EMBEDDING_DIM length, or null if unavailable
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (this._state.status !== 'ready') return null;

    try {
      // pipeline(text, options) runs the ONNX model on the input text.
      // pooling: 'mean' averages all token embeddings into one vector.
      // normalize: true L2-normalizes so cosine similarity = dot product.
      const output = await this._state.pipeline(text, {
        pooling: 'mean',
        normalize: true,
      });

      this.consecutiveFailures = 0;
      // output.data is the raw Float32Array of the embedding
      return output.data as Float32Array;
    } catch (err: unknown) {
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Embedding failed for text (${text.slice(0, 50)}...): ${msg}`);

      // Circuit breaker: after too many consecutive failures, stop trying
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this._state = {
          status: 'failed',
          error: err instanceof Error ? err : new Error(msg),
          failedAt: new Date().toISOString(),
        };
        console.error(`Embedding model: transitioned to 'failed' after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      }

      return null;
    }
  }

  /**
   * Generates embeddings for multiple texts. Processes sequentially (not batched
   * at the ONNX level) because all-MiniLM-L6-v2 doesn't benefit much from
   * batching in ONNX runtime and sequential gives us per-item error isolation.
   *
   * @param texts - Array of { id, content } pairs to embed
   * @returns Array of { id, embedding } for successful embeddings (failures skipped)
   */
  async embedBatch(
    texts: Array<{ id: number; content: string }>
  ): Promise<Array<{ id: number; embedding: Float32Array }>> {
    const results: Array<{ id: number; embedding: Float32Array }> = [];

    for (const { id, content } of texts) {
      const embedding = await this.embed(content);
      if (embedding) {
        results.push({ id, embedding });
      }
    }

    return results;
  }
}
```

- [ ] **Step 2: Add embedding.ts to tsconfig.json**

In `tsconfig.json`, add `"embedding.ts"` to the `include` array:

```json
"include": [
  "index.ts",
  "types.ts",
  "cursor.ts",
  "jsonl-store.ts",
  "sqlite-store.ts",
  "embedding.ts"
]
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /home/dustin/Claude/mcp-memory-server
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add embedding.ts tsconfig.json
git commit -m "feat: add embedding pipeline module with state machine and lazy loading"
```

---

### Task 4: Add types and GraphStore interface changes

**Files:**
- Modify: `types.ts`

- [ ] **Step 1: Add SupersedeInput type and supersedeObservations to GraphStore**

In `types.ts`, add the `SupersedeInput` type before the `GraphStore` interface (before line 127):

```typescript
/** Input for supersede_observations tool: replace one observation with another on an entity. */
export interface SupersedeInput {
  entityName: string;
  oldContent: string;
  newContent: string;
}
```

Then add `supersedeObservations` to the `GraphStore` interface, after `deleteRelations`:

```typescript
  supersedeObservations(supersessions: SupersedeInput[]): Promise<void>;
```

- [ ] **Step 2: Verify types compile**

```bash
cd /home/dustin/Claude/mcp-memory-server
npx tsc --noEmit
```

Expected: Compile errors in `sqlite-store.ts` and `jsonl-store.ts` because they don't implement `supersedeObservations` yet. That's correct -- we'll add the implementations in the next tasks.

- [ ] **Step 3: Commit**

```bash
git add types.ts
git commit -m "feat: add SupersedeInput type and supersedeObservations to GraphStore interface"
```

---

### Task 5: Add supersedeObservations stub to JsonlStore

**Files:**
- Modify: `jsonl-store.ts`

- [ ] **Step 1: Add the stub method**

In `jsonl-store.ts`, add `SupersedeInput` to the import list from `'./types.js'`:

```typescript
import {
  // ... existing imports ...
  type SupersedeInput,
} from './types.js';
```

Then add this method to the `JsonlStore` class (after `deleteRelations`):

```typescript
  /**
   * Supersede observations is not supported in the JSONL backend.
   * This feature requires SQLite for transactional atomicity and the
   * superseded_at column. Users should migrate to SQLite to use this feature.
   *
   * @throws Error always -- JSONL backend does not support supersede
   */
  async supersedeObservations(_supersessions: SupersedeInput[]): Promise<void> {
    throw new Error('supersede_observations not supported in JSONL backend: migrate to SQLite');
  }
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /home/dustin/Claude/mcp-memory-server
npx tsc --noEmit
```

Expected: Only `sqlite-store.ts` errors remain (missing `supersedeObservations`).

- [ ] **Step 3: Commit**

```bash
git add jsonl-store.ts
git commit -m "feat: add supersedeObservations stub to JsonlStore (throws, migrate to SQLite)"
```

---

### Task 6: Schema migration -- superseded_at column, partial index, and supersedeObservations

**Files:**
- Modify: `sqlite-store.ts`
- Modify: `__tests__/knowledge-graph.test.ts`

This is the core schema change plus the `supersedeObservations` implementation. We add the `superseded_at` column via a table rebuild migration, the partial index for active observations, filter all queries to exclude superseded observations, and implement the supersede method.

- [ ] **Step 1: Write the failing tests**

In `__tests__/knowledge-graph.test.ts`, add `SupersedeInput` to the imports from `'../types.js'`:

```typescript
import type { GraphStore, Relation, SupersedeInput } from '../types.js';
```

Then add a new `describe('supersedeObservations', ...)` block inside the parameterized `describe.each` block. Place it after the `deleteRelations` describe block:

```typescript
	// ----------------------------------------------------------
	// supersedeObservations
	// ----------------------------------------------------------
	describe('supersedeObservations', () => {
		it('should throw in JSONL backend', async function() {
			// Only test the throw behavior for JsonlStore
			if (ext !== 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['old fact'] },
			]);
			await expect(store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'old fact', newContent: 'new fact' },
			])).rejects.toThrow('migrate to SQLite');
		});

		it('should replace an observation atomically', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['status: 262 tests'] },
			]);
			await store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'status: 262 tests', newContent: 'status: 290 tests' },
			]);
			const graph = await store.readGraph();
			const entity = graph.entities.find(e => e.name === 'Entity1')!;
			expect(entity.observations).toHaveLength(1);
			expect(entity.observations[0].content).toBe('status: 290 tests');
		});

		it('should throw when oldContent is not found', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['existing'] },
			]);
			await expect(store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'nonexistent', newContent: 'new' },
			])).rejects.toThrow();
		});

		it('should throw when entity is not found', async function() {
			if (ext === 'jsonl') return;
			await expect(store.supersedeObservations([
				{ entityName: 'Nonexistent', oldContent: 'nope', newContent: 'nope2' },
			])).rejects.toThrow('not found');
		});

		it('should be idempotent when newContent already exists as active', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['old fact', 'new fact'] },
			]);
			await store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'old fact', newContent: 'new fact' },
			]);
			const graph = await store.readGraph();
			const entity = graph.entities.find(e => e.name === 'Entity1')!;
			expect(entity.observations).toHaveLength(1);
			expect(entity.observations[0].content).toBe('new fact');
		});

		it('should update entity updatedAt timestamp', async function() {
			if (ext === 'jsonl') return;
			const { created } = await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['old'] },
			]);
			const originalUpdatedAt = created[0].updatedAt;
			await new Promise(r => setTimeout(r, 10));
			await store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'old', newContent: 'new' },
			]);
			const graph = await store.readGraph();
			const entity = graph.entities.find(e => e.name === 'Entity1')!;
			expect(entity.updatedAt > originalUpdatedAt).toBe(true);
		});

		it('should make superseded observations invisible to searchNodes', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['unique_old_marker_xyz'] },
			]);
			await store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'unique_old_marker_xyz', newContent: 'replacement' },
			]);
			const results = await store.searchNodes('unique_old_marker_xyz');
			expect(results.entities).toHaveLength(0);
		});

		it('should make superseded observations invisible to openNodes', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['old_obs', 'stays'] },
			]);
			await store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'old_obs', newContent: 'new_obs' },
			]);
			const graph = await store.openNodes(['Entity1']);
			const entity = graph.entities[0];
			const contents = entity.observations.map(o => o.content);
			expect(contents).toContain('stays');
			expect(contents).toContain('new_obs');
			expect(contents).not.toContain('old_obs');
		});

		it('should handle batch supersessions atomically', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['fact A'] },
				{ name: 'Entity2', entityType: 'test', observations: ['fact B'] },
			]);
			await store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'fact A', newContent: 'fact A updated' },
				{ entityName: 'Entity2', oldContent: 'fact B', newContent: 'fact B updated' },
			]);
			const graph = await store.readGraph();
			const e1 = graph.entities.find(e => e.name === 'Entity1')!;
			const e2 = graph.entities.find(e => e.name === 'Entity2')!;
			expect(e1.observations[0].content).toBe('fact A updated');
			expect(e2.observations[0].content).toBe('fact B updated');
		});

		it('should roll back all changes if any supersession fails', async function() {
			if (ext === 'jsonl') return;
			await store.createEntities([
				{ name: 'Entity1', entityType: 'test', observations: ['valid old'] },
			]);
			await expect(store.supersedeObservations([
				{ entityName: 'Entity1', oldContent: 'valid old', newContent: 'valid new' },
				{ entityName: 'Nonexistent', oldContent: 'nope', newContent: 'nope2' },
			])).rejects.toThrow();
			const graph = await store.readGraph();
			const e1 = graph.entities.find(e => e.name === 'Entity1')!;
			expect(e1.observations[0].content).toBe('valid old');
		});
	});
```

- [ ] **Step 2: Run the tests to see them fail**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm test
```

Expected: New supersede tests fail (method not implemented in SqliteStore).

- [ ] **Step 3: Add the superseded_at migration to SqliteStore.init()**

In `sqlite-store.ts`, add `SupersedeInput` to the imports from `'./types.js'`.

Then add a new migration block in `init()` after the `DROP INDEX IF EXISTS idx_entities_project` line (line 212) and before the crash recovery block (line 214):

```typescript
    // Migrate: add superseded_at column to observations table.
    // SQLite can't ALTER a UNIQUE constraint, so we rebuild the table.
    // - superseded_at = '' means active observation (sentinel, not NULL, for UNIQUE correctness)
    // - superseded_at = ISO timestamp means the observation was retired at that time
    // New UNIQUE(entity_id, content, superseded_at) allows the same content to be
    // re-asserted after supersession (different superseded_at values).
    const obsColumns = this.db.pragma('table_info(observations)') as { name: string }[];
    const hasSupersededAt = obsColumns.some(c => c.name === 'superseded_at');
    if (!hasSupersededAt) {
      this.db.transaction(() => {
        this.db.exec(`
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
        `);
      })();
    }

    // Partial index on active observations -- used by all queries that filter
    // by superseded_at = ''. Superseded observations don't need indexing.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_active
      ON observations(entity_id) WHERE superseded_at = '';
    `);
```

- [ ] **Step 4: Add WHERE superseded_at = '' to observation queries**

Update `buildEntities()` -- the observation fetch query (around line 600):

Change:
```sql
WHERE e.name IN (${placeholders})
```
To:
```sql
WHERE e.name IN (${placeholders}) AND o.superseded_at = ''
```

Update `searchNodes()` -- the CTE LEFT JOIN (around line 823):

Change:
```sql
LEFT JOIN observations o ON o.entity_id = e2.id
```
To:
```sql
LEFT JOIN observations o ON o.entity_id = e2.id AND o.superseded_at = ''
```

Update `deleteObservations()` -- the DELETE statement (around line 539):

Change:
```sql
DELETE FROM observations WHERE entity_id = ? AND content = ?
```
To:
```sql
DELETE FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''
```

- [ ] **Step 5: Implement supersedeObservations in SqliteStore**

Add this method to the `SqliteStore` class, after `deleteRelations()`:

```typescript
  /**
   * Atomically supersedes observations: retires the old content and inserts the new.
   * The old observation's superseded_at is set to the current timestamp (marking it retired).
   * A new observation row is created with the new content and superseded_at = '' (active).
   * All operations run in a single transaction -- all succeed or all roll back.
   *
   * @param supersessions - Array of { entityName, oldContent, newContent }
   * @throws Error if any entity is not found or oldContent doesn't match an active observation
   */
  async supersedeObservations(supersessions: SupersedeInput[]): Promise<void> {
    const findEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    // Find the active observation matching this entity + content
    const findActiveObs = this.db.prepare(
      `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
    );
    // Mark the old observation as superseded (set superseded_at to current timestamp)
    const supersedeObs = this.db.prepare(
      `UPDATE observations SET superseded_at = ? WHERE id = ?`
    );
    // Insert the replacement observation as active (superseded_at defaults to '')
    const insertObs = this.db.prepare(
      `INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`
    );
    // Bump entity's updated_at timestamp
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ? WHERE id = ?'
    );

    const txn = this.db.transaction(() => {
      const now = new Date().toISOString();

      for (const s of supersessions) {
        // Look up the entity by name
        const entityRow = findEntity.get(s.entityName) as { id: number } | undefined;
        if (!entityRow) {
          throw new Error(`Entity with name ${s.entityName} not found`);
        }

        // Find the active observation to supersede
        const obsRow = findActiveObs.get(entityRow.id, s.oldContent) as { id: number } | undefined;
        if (!obsRow) {
          throw new Error(
            `Active observation "${s.oldContent}" not found on entity "${s.entityName}"`
          );
        }

        // Retire the old observation
        supersedeObs.run(now, obsRow.id);

        // Insert the replacement (INSERT OR IGNORE: if newContent already exists
        // as an active observation on this entity, skip -- idempotent)
        insertObs.run(entityRow.id, s.newContent, now);

        // Bump updated_at
        updateTimestamp.run(now, entityRow.id);
      }
    });
    txn();
  }
```

- [ ] **Step 6: Run the tests**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm test
```

Expected: All existing tests pass. All new supersede tests pass.

- [ ] **Step 7: Commit**

```bash
git add sqlite-store.ts __tests__/knowledge-graph.test.ts
git commit -m "feat: add superseded_at column, migration, and supersedeObservations implementation"
```

---

### Task 7: Register supersede_observations MCP tool

**Files:**
- Modify: `index.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the tool registration**

In `index.ts`, add the `supersede_observations` tool registration after the `delete_relations` tool (around line 276):

```typescript
server.registerTool(
  "supersede_observations",
  {
    title: "Supersede Observations",
    description: "Atomically replace observations on entities. Retires the old observation and inserts the new one in a single transaction. Use this instead of delete+add when an observation's content has changed (e.g., updated status, count, or signature).",
    inputSchema: {
      supersessions: z.array(z.object({
        entityName: z.string().min(1).max(500).describe("The entity whose observation to supersede"),
        oldContent: z.string().min(1).max(5000).describe("The exact text of the active observation to retire"),
        newContent: z.string().min(1).max(5000).describe("The replacement observation text"),
      })).max(100),
    },
    outputSchema: { success: z.boolean(), message: z.string() }
  },
  async ({ supersessions }) => {
    await store.supersedeObservations(supersessions);
    return {
      content: [{ type: "text" as const, text: "Observations superseded successfully" }],
      structuredContent: { success: true, message: "Observations superseded successfully" }
    };
  }
);
```

- [ ] **Step 2: Bump version to 0.11.0**

In `index.ts`, change the server version:

```typescript
const server = new McpServer({
  name: "memory-server",
  version: "0.11.0",
});
```

In `package.json`, change `"version": "0.10.1"` to `"version": "0.11.0"`.

- [ ] **Step 3: Verify it compiles and tests pass**

```bash
cd /home/dustin/Claude/mcp-memory-server
npx tsc --noEmit && npm test
```

Expected: Clean compile, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add index.ts package.json
git commit -m "feat: register supersede_observations MCP tool, bump to v0.11.0"
```

---

### Task 8: Add sqlite-vec extension loading, vec_observations table, and embedding sweep

**Files:**
- Modify: `sqlite-store.ts`
- Create: `__tests__/vector-search.test.ts`

- [ ] **Step 1: Write the tests**

Create `__tests__/vector-search.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SqliteStore } from '../sqlite-store.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('SqliteStore vector infrastructure', () => {
  let store: SqliteStore;
  let storePath: string;

  beforeEach(async () => {
    storePath = path.join(testDir, `test-vec-${Date.now()}.db`);
    store = new SqliteStore(storePath);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { await fs.unlink(storePath + suffix); } catch { /* ignore */ }
    }
  });

  it('should report vector state after init', () => {
    const state = store.vectorState;
    // After init, should be 'loading' (model loading in background)
    expect(['loading', 'unavailable']).toContain(state.status);
  });

  it('should degrade gracefully when MEMORY_VECTOR_SEARCH=off', async () => {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { await fs.unlink(storePath + suffix); } catch { /* ignore */ }
    }

    const envPath = path.join(testDir, `test-vec-off-${Date.now()}.db`);
    process.env.MEMORY_VECTOR_SEARCH = 'off';
    try {
      const offStore = new SqliteStore(envPath);
      await offStore.init();
      expect(offStore.vectorState.status).toBe('unavailable');
      await offStore.close();
    } finally {
      delete process.env.MEMORY_VECTOR_SEARCH;
      for (const suffix of ['', '-wal', '-shm']) {
        try { await fs.unlink(envPath + suffix); } catch { /* ignore */ }
      }
    }
  });

  it('should return LIKE results even when vector search is loading', async () => {
    await store.createEntities([
      { name: 'TestEntity', entityType: 'test', observations: ['hello world'] },
    ]);
    const results = await store.searchNodes('hello');
    expect(results.entities).toHaveLength(1);
    expect(results.entities[0].name).toBe('TestEntity');
  });

  it('should not include superseded observations in LIKE search', async () => {
    await store.createEntities([
      { name: 'E1', entityType: 'test', observations: ['unique_searchable_marker'] },
    ]);
    await store.supersedeObservations([
      { entityName: 'E1', oldContent: 'unique_searchable_marker', newContent: 'replacement text' },
    ]);
    const results = await store.searchNodes('unique_searchable_marker');
    expect(results.entities).toHaveLength(0);
    const results2 = await store.searchNodes('replacement text');
    expect(results2.entities).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm test
```

Expected: Fails because `SqliteStore` doesn't have `vectorState` yet.

- [ ] **Step 3: Add sqlite-vec loading, vec_observations, and sweep to SqliteStore**

In `sqlite-store.ts`, add these imports at the top:

```typescript
import * as sqliteVec from 'sqlite-vec';
import { EmbeddingPipeline, EMBEDDING_DIM, type VectorState } from './embedding.js';
```

Add properties to the `SqliteStore` class (after the `private db!` line):

```typescript
  /** Embedding pipeline for vector search. Created in constructor. */
  private embeddingPipeline = new EmbeddingPipeline();

  /** Whether the vec_observations virtual table exists (sqlite-vec loaded successfully). */
  private vecTableExists = false;

  /** Exposes the current vector search state for callers to inspect. */
  get vectorState(): VectorState {
    return this.embeddingPipeline.state;
  }
```

At the end of `init()`, after all existing migrations and indexes, before the closing brace, add:

```typescript
    // --- Vector search setup ---
    // Load sqlite-vec extension and create the vec_observations virtual table.
    // If loading fails (platform incompatibility, missing binary), degrade gracefully
    // to LIKE-only search. The MEMORY_VECTOR_SEARCH env var can disable this entirely.
    if (process.env.MEMORY_VECTOR_SEARCH === 'off') {
      console.error('Vector search disabled via MEMORY_VECTOR_SEARCH=off');
    } else {
      try {
        // sqliteVec.load() calls db.loadExtension() with the path to the native
        // sqlite-vec binary shipped by the npm package
        sqliteVec.load(this.db);

        // Create the virtual table if it doesn't exist.
        // vec0 is sqlite-vec's virtual table module for dense float vectors.
        // observation_id maps 1:1 with observations.id (active observations only).
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(
            observation_id INTEGER PRIMARY KEY,
            embedding float[${EMBEDDING_DIM}]
          );
        `);

        this.vecTableExists = true;

        // Startup consistency check: find orphaned embeddings (vec row but no observation)
        // and delete them. Handles CASCADE-deleted observations whose vec rows weren't cleaned up.
        const orphanCount = (this.db.prepare(`
          SELECT COUNT(*) AS cnt FROM vec_observations v
          LEFT JOIN observations o ON v.observation_id = o.id
          WHERE o.id IS NULL
        `).get() as { cnt: number }).cnt;

        if (orphanCount > 0) {
          this.db.exec(`
            DELETE FROM vec_observations WHERE observation_id NOT IN (
              SELECT id FROM observations
            )
          `);
          console.error(`Vector search: cleaned up ${orphanCount} orphaned embeddings`);
        }

        // Start loading the embedding model in the background.
        // When ready, run the universal embedding sweep.
        this.embeddingPipeline.startLoading(() => {
          this.runEmbeddingSweep();
        });

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `sqlite-vec extension not available (${process.arch}/${process.platform}): ${msg}. ` +
          `Vector search disabled. LIKE search remains functional.`
        );
      }
    }
```

Add the `runEmbeddingSweep` method to the class:

```typescript
  /**
   * Finds all active observations without embeddings and generates them.
   * Runs in batches of 100 with event loop yields between batches
   * so the server stays responsive to MCP requests during the sweep.
   * Called once after the embedding model finishes loading.
   */
  private async runEmbeddingSweep(): Promise<void> {
    if (!this.vecTableExists || this.embeddingPipeline.state.status !== 'ready') return;

    const BATCH_SIZE = 100;
    let totalEmbedded = 0;

    while (true) {
      // Find active observations missing from vec_observations
      const batch = this.db.prepare(`
        SELECT o.id, o.content FROM observations o
        LEFT JOIN vec_observations v ON o.id = v.observation_id
        WHERE v.observation_id IS NULL AND o.superseded_at = ''
        ORDER BY o.id
        LIMIT ?
      `).all(BATCH_SIZE) as { id: number; content: string }[];

      if (batch.length === 0) break;

      // Generate embeddings for this batch
      const results = await this.embeddingPipeline.embedBatch(batch);

      // Insert embeddings into vec_observations
      if (results.length > 0) {
        const insert = this.db.prepare(
          'INSERT OR REPLACE INTO vec_observations (observation_id, embedding) VALUES (?, ?)'
        );
        const txn = this.db.transaction(() => {
          for (const { id, embedding } of results) {
            insert.run(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
          }
        });
        txn();
        totalEmbedded += results.length;
      }

      // Yield the event loop so the server can handle MCP requests between batches
      await new Promise(resolve => setImmediate(resolve));

      // If the model failed during this batch, stop the sweep
      if (this.embeddingPipeline.state.status !== 'ready') break;
    }

    if (totalEmbedded > 0) {
      console.error(`Vector search: embedded ${totalEmbedded} observations during sweep`);
    }
  }
```

- [ ] **Step 4: Run tests**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add sqlite-store.ts __tests__/vector-search.test.ts
git commit -m "feat: add sqlite-vec extension loading, vec_observations table, embedding sweep"
```

---

### Task 9: Add syncEmbedding helper and wire into all mutation paths

**Files:**
- Modify: `sqlite-store.ts`

- [ ] **Step 1: Add the syncEmbedding helper**

Add this private method to the `SqliteStore` class:

```typescript
  /**
   * Centralized helper for maintaining vec_observations in sync with observations.
   * All mutation paths (create, add, delete, supersede) call this after their
   * core transaction commits. Never throws -- embedding is best-effort.
   *
   * @param observationId - The observations.id to sync
   * @param content - The observation content text (only used for 'upsert')
   * @param action - 'upsert' to generate+insert embedding, 'delete' to remove it
   */
  private async syncEmbedding(
    observationId: number,
    content: string,
    action: 'upsert' | 'delete'
  ): Promise<void> {
    if (!this.vecTableExists) return;

    if (action === 'delete') {
      try {
        this.db.prepare('DELETE FROM vec_observations WHERE observation_id = ?').run(observationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`syncEmbedding delete failed for observation ${observationId}: ${msg}`);
      }
      return;
    }

    // 'upsert' -- need the model to be ready
    if (this.embeddingPipeline.state.status !== 'ready') return;

    const embedding = await this.embeddingPipeline.embed(content);
    if (!embedding) return;

    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO vec_observations (observation_id, embedding) VALUES (?, ?)'
      ).run(observationId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`syncEmbedding upsert failed for observation ${observationId}: ${msg}`);
    }
  }
```

- [ ] **Step 2: Wire into createEntities**

After the `txn()` call in `createEntities()`, before the `return`, add:

```typescript
    // Generate embeddings for new observations (async, best-effort).
    // If the model isn't ready, the sweep will catch these later.
    for (const entity of created) {
      const entityRow = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(entity.name) as { id: number };
      for (const obs of entity.observations) {
        const obsRow = this.db.prepare(
          `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
        ).get(entityRow.id, obs.content) as { id: number } | undefined;
        if (obsRow) {
          await this.syncEmbedding(obsRow.id, obs.content, 'upsert');
        }
      }
    }
```

- [ ] **Step 3: Wire into addObservations**

After the `txn()` call in `addObservations()`, before the `return`, add:

```typescript
    // Generate embeddings for newly added observations (async, best-effort)
    for (const result of results) {
      const entityRow = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(result.entityName) as { id: number } | undefined;
      if (!entityRow) continue;
      for (const obs of result.addedObservations) {
        const obsRow = this.db.prepare(
          `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
        ).get(entityRow.id, obs.content) as { id: number } | undefined;
        if (obsRow) {
          await this.syncEmbedding(obsRow.id, obs.content, 'upsert');
        }
      }
    }
```

- [ ] **Step 4: Wire into deleteEntities**

In `deleteEntities()`, **before** the existing transaction, add observation ID collection:

```typescript
    // Collect observation IDs before CASCADE deletes them -- vec_observations
    // doesn't participate in CASCADE, so we must delete explicitly.
    const obsIdsToDelete: number[] = [];
    if (this.vecTableExists) {
      for (const name of entityNames) {
        const entityRow = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number } | undefined;
        if (!entityRow) continue;
        const obsRows = this.db.prepare('SELECT id FROM observations WHERE entity_id = ?').all(entityRow.id) as { id: number }[];
        obsIdsToDelete.push(...obsRows.map(r => r.id));
      }
    }
```

After the `txn()` call, add:

```typescript
    // Clean up vec_observations for CASCADE-deleted observations
    for (const obsId of obsIdsToDelete) {
      await this.syncEmbedding(obsId, '', 'delete');
    }
```

- [ ] **Step 5: Wire into deleteObservations**

In `deleteObservations()`, before the existing transaction, add a tracking array:

```typescript
    const deletedObsIds: number[] = [];
```

Inside the transaction, before `delObs.run(row.id, content);`, add:

```typescript
          // Look up the observation ID before deleting (needed for vec cleanup)
          if (this.vecTableExists) {
            const obsRow = this.db.prepare(
              `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
            ).get(row.id, content) as { id: number } | undefined;
            if (obsRow) deletedObsIds.push(obsRow.id);
          }
```

After the `txn()` call, add:

```typescript
    // Clean up vec_observations for deleted observations
    for (const obsId of deletedObsIds) {
      await this.syncEmbedding(obsId, '', 'delete');
    }
```

- [ ] **Step 6: Wire into supersedeObservations**

Inside the transaction in `supersedeObservations()`, after `supersedeObs.run(now, obsRow.id);`, add:

```typescript
        // Delete the old observation's embedding (sync, inside transaction)
        if (this.vecTableExists) {
          this.db.prepare('DELETE FROM vec_observations WHERE observation_id = ?').run(obsRow.id);
        }
```

After the `txn()` call, add:

```typescript
    // Generate embeddings for the new observations (async, after transaction)
    for (const s of supersessions) {
      const entityRow = findEntity.get(s.entityName) as { id: number } | undefined;
      if (!entityRow) continue;
      const newObsRow = this.db.prepare(
        `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
      ).get(entityRow.id, s.newContent) as { id: number } | undefined;
      if (newObsRow) {
        await this.syncEmbedding(newObsRow.id, s.newContent, 'upsert');
      }
    }
```

- [ ] **Step 7: Run tests**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm test
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add sqlite-store.ts
git commit -m "feat: add syncEmbedding helper and wire into all mutation paths"
```

---

### Task 10: Implement hybrid search in searchNodes

**Files:**
- Modify: `sqlite-store.ts`

- [ ] **Step 1: Add vector augmentation to searchNodes**

In `sqlite-store.ts`, in the `searchNodes()` method, after `const entities = this.buildEntities(pageRows);` and before the relations block, add:

```typescript
    // --- Vector search: find additional entities LIKE missed ---
    // If the embedding model is ready, run a KNN search for semantically
    // similar observations. Merge results with LIKE results by entity ID.
    // Vector results appear as supplementary matches appended to the page.
    if (this.vecTableExists && this.embeddingPipeline.state.status === 'ready') {
      try {
        const queryEmbedding = await this.embeddingPipeline.embed(query);
        if (queryEmbedding) {
          // Request more KNN results than the page limit to account for
          // duplicates and multiple observations per entity
          const knnK = Math.min((limit ?? 40) * 2, 200);
          const knnRows = this.db.prepare(`
            SELECT observation_id, distance
            FROM vec_observations
            WHERE embedding MATCH ? AND k = ?
          `).all(
            Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
            knnK
          ) as { observation_id: number; distance: number }[];

          if (knnRows.length > 0) {
            // Map KNN observation IDs to entity IDs, filtering active + project-scoped
            const obsIds = knnRows.map(r => r.observation_id);
            const vecEntityIds = new Set<number>();

            for (let i = 0; i < obsIds.length; i += CHUNK_SIZE) {
              const chunk = obsIds.slice(i, i + CHUNK_SIZE);
              const placeholders = chunk.map(() => '?').join(',');
              let vecSql = `
                SELECT DISTINCT e.id FROM observations o
                JOIN entities e ON o.entity_id = e.id
                WHERE o.id IN (${placeholders}) AND o.superseded_at = ''
              `;
              const vecParams: (string | number)[] = [...chunk];
              if (normalizedProject) {
                vecSql += ' AND (e.project = ? OR e.project IS NULL)';
                vecParams.push(normalizedProject);
              }
              const rows = this.db.prepare(vecSql).all(...vecParams) as { id: number }[];
              for (const r of rows) vecEntityIds.add(r.id);
            }

            // Filter out entities already in the LIKE results
            const likeIds = new Set(pageRows.map(r => r.id));
            const newIds = [...vecEntityIds].filter(id => !likeIds.has(id));

            if (newIds.length > 0) {
              // Fetch and build the vector-only entities
              const ph = newIds.map(() => '?').join(',');
              const newRows = this.db.prepare(`
                SELECT name, entity_type AS entityType, project, updated_at, created_at, id
                FROM entities WHERE id IN (${ph})
                ORDER BY updated_at DESC, id DESC
              `).all(...newIds) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number }[];
              const vecEntities = this.buildEntities(newRows);
              entities.push(...vecEntities);
            }
          }
        }
      } catch (err: unknown) {
        // Vector search failed -- LIKE results are already in entities, just continue
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Vector search augmentation failed: ${msg}`);
      }
    }
```

- [ ] **Step 2: Run tests**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add sqlite-store.ts
git commit -m "feat: implement hybrid LIKE + vector search in searchNodes"
```

---

### Task 11: Update hooks in settings.json

**Files:**
- Modify: `~/.claude/settings.json` (user settings, not in repo)

This task updates the SessionEnd and PreCompact hook prompts to teach them about `supersede_observations`.

- [ ] **Step 1: Update SessionEnd hook prompt**

In `~/.claude/settings.json`, find the `SessionEnd` hook prompt. After the `TIMESTAMPING:` paragraph, add this text:

```
\n\nSUPERSEDE vs. APPEND: Before adding an observation, check if the entity already has an observation covering the same fact (e.g., status, test count, function signature, file description). If it does, use `supersede_observations` to atomically retire the old one and insert the updated version. Only use `add_observations` for genuinely new facts that don't replace existing information. This prevents observation drift — the accumulation of stale observations that contradict current state.
```

- [ ] **Step 2: Update PreCompact hook prompt**

In the `PreCompact` hook prompt, add to the end of the numbered list:

```
\n6. SUPERSEDE vs. APPEND: Before adding an observation, check if the entity already has an observation covering the same fact. If it does, use `supersede_observations` to atomically retire the old one and insert the updated version. Only use `add_observations` for genuinely new facts. This prevents observation drift.
```

- [ ] **Step 3: Verify hooks loaded**

Type `/hooks` in Claude Code to verify the updated hooks are registered.

---

### Task 12: Update CLAUDE.md with memory maintenance guidance

**Files:**
- Modify: `/home/dustin/Claude/mcp-memory-server/CLAUDE.md`

- [ ] **Step 1: Add Memory Maintenance section**

Before the `## Relevant Agents` section, add:

```markdown
## Memory Maintenance

### Observation write guidance
- **Supersede** when an observation states a fact that has changed (status, counts, signatures, descriptions). Use `supersede_observations` to atomically retire the old observation and insert the updated version. The old observation remains in the database (with a `superseded_at` timestamp) for history but is filtered from all active queries.
- **Append** when an observation adds a genuinely new fact that doesn't contradict or update any existing observation. Use `add_observations` as before.
- **Never delete** observations to "clean up" -- supersede preserves history and avoids accidental data loss.

### Vector search
- Vector search uses sqlite-vec + @huggingface/transformers (all-MiniLM-L6-v2, 384 dimensions)
- LIKE substring search always runs; vector search adds supplementary semantic matches when the model is loaded
- Set `MEMORY_VECTOR_SEARCH=off` env var to disable vector search entirely
- JSONL backend does not support vector search or observation supersede
- On first startup, the model downloads ~23MB (cached thereafter). Embedding sweep runs in background.
- `syncEmbedding()` in sqlite-store.ts is the centralized helper -- all mutation paths call it
```

- [ ] **Step 2: Update Architecture section**

Add `embedding.ts` description and update `sqlite-store.ts` description to mention superseded_at, vec_observations, supersedeObservations, syncEmbedding, runEmbeddingSweep, and startup orphan cleanup. Update line counts.

- [ ] **Step 3: Update Known Limitations, Tests, and Planned Phases**

Add vector search limitations, new test file description, and Phase 5 completion.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add memory maintenance guidance, vector search architecture, update CLAUDE.md"
```

---

### Task 13: Build, run full test suite, and verify

**Files:** None (verification only)

- [ ] **Step 1: Clean build**

```bash
cd /home/dustin/Claude/mcp-memory-server
rm -rf dist && npm run build
```

Expected: Clean compilation with no errors.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: All existing tests pass + all new tests pass.

- [ ] **Step 3: Run the smoke test**

```bash
npx tsx __tests__/smoke-test-vec.ts
```

Expected: PASS on all checks.

- [ ] **Step 4: Test the built server starts**

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' | node dist/index.js 2>/dev/null | head -1
```

Expected: A JSON-RPC response with server capabilities.

---

### Task 14: Deploy to live memory server

**Files:** None in repo

- [ ] **Step 1: Rebuild in the live directory**

```bash
cd /home/dustin/Claude/mcp-memory-server
npm run build
```

The live MCP server config in `~/.claude.json` already points to `node ~/Claude/mcp-memory-server/dist/index.js`.

- [ ] **Step 2: Restart Claude Code**

Exit and restart Claude Code. The new server will:
1. Load sqlite-vec and create `vec_observations` table
2. Run the `superseded_at` migration (table rebuild)
3. Start downloading the embedding model in the background
4. Run the embedding sweep once the model loads

- [ ] **Step 3: Verify the new tools are available**

In the new session, verify `supersede_observations` is available by searching for a known entity and testing a supersede.

---

## Self-Review Checklist

1. **Spec coverage:**
   - Section 1 (schema): Task 6 (superseded_at migration, partial index), Task 8 (vec_observations)
   - Section 2 (supersede tool): Tasks 4-7 (types, stubs, implementation, MCP registration)
   - Section 3 (vector search): Tasks 1-3 (smoke test, deps, embedding module), Tasks 8-10 (extension, syncEmbedding, hybrid search)
   - Section 4 (hooks): Task 11
   - Section 5 (CLAUDE.md): Task 12

2. **Placeholder scan:** No TBDs, TODOs, or "implement later" found.

3. **Type consistency:** `SupersedeInput` used consistently in types.ts, jsonl-store.ts, sqlite-store.ts, index.ts. `VectorState` defined in embedding.ts, used in sqlite-store.ts. `syncEmbedding(observationId, content, action)` signature consistent across all call sites.
