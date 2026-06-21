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
		// or 'ready' if model was cached and loaded fast
		expect(['loading', 'ready', 'unavailable']).toContain(state.status);
	});

	it('should degrade gracefully when MEMORY_VECTOR_SEARCH=off', async () => {
		await store.close();
		for (const suffix of ['', '-wal', '-shm']) {
			try { await fs.unlink(storePath + suffix); } catch { /* ignore */ }
		}

		const envPath = path.join(testDir, `test-vec-off-${Date.now()}.db`);
		// Save/RESTORE the prior value — `delete` here used to strip the value
		// vitest.config.ts injected for the whole worker, so the remaining tests
		// in this file silently built VECTOR-ENABLED stores and kicked off real
		// model loads even in the model-free Pool 1 run (QA 2026-06-09, m1: the
		// "Vector search disabled" stderr appeared ×3 when 5 stores were built —
		// the missing two were this leak).
		const prevVectorSearch = process.env.MEMORY_VECTOR_SEARCH;
		process.env.MEMORY_VECTOR_SEARCH = 'off';
		try {
			const offStore = new SqliteStore(envPath);
			await offStore.init();
			expect(offStore.vectorState.status).toBe('unavailable');
			await offStore.close();
		} finally {
			if (prevVectorSearch === undefined) {
				delete process.env.MEMORY_VECTOR_SEARCH;
			} else {
				process.env.MEMORY_VECTOR_SEARCH = prevVectorSearch;
			}
			for (const suffix of ['', '-wal', '-shm']) {
				try { await fs.unlink(envPath + suffix); } catch { /* ignore */ }
			}
		}
	});

	// Renamed 2026-06-09: under the safe-by-default config this store runs with
	// vectors OFF ('unavailable'), not 'loading' — the assertion (LIKE results
	// regardless of vector state) is unchanged and is the actual contract. A
	// deterministic true-'loading' test needs a mocked never-resolving
	// transformers import — tracked in the stabilization pass (DEF-1-08).
	it('should return LIKE results regardless of vector search state', async () => {
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
