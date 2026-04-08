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
