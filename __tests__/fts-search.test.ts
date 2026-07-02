/**
 * fts-search.test.ts — Tests for the FTS5 observation index (schema v11) and the
 * relevance-ranked hybrid search mode (Phase A of the 2026-07-02 retrieval plan).
 *
 * Pool 1 (MEMORY_VECTOR_SEARCH=off): these tests exercise the FTS index, triggers,
 * and RRF fusion over the LIKE+FTS candidate lists. The vector list's contribution
 * is covered separately in Pool 2 — here we deliberately test the degraded path,
 * because graceful degradation without the model is itself part of the contract.
 *
 * Uses direct database access (raw better-sqlite3 handle) to inspect the FTS index,
 * same pattern as eviction.test.ts — the index internals aren't (and shouldn't be)
 * reachable through the GraphStore interface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { SqliteStore } from '../sqlite-store.js';
import { JsonlStore } from '../jsonl-store.js';

// Resolve the directory containing this test file, used for temp file paths.
const testDir = path.dirname(fileURLToPath(import.meta.url));

// Shared state: temp DB path and store instance. Cleaned up in afterEach.
let dbPath: string;
let store: SqliteStore;

// Generates a unique temp DB path for each test to avoid collisions.
function tempDbPath(): string {
	const id = Date.now() + Math.floor(Math.random() * 100000);
	return path.join(testDir, `test-fts-${id}.db`);
}

// Clean up temp files after each test (WAL/SHM siblings are created in WAL mode).
afterEach(async () => {
	if (store) {
		try { store.shutdown(); } catch { /* already shut down */ }
		try { await store.close(); } catch { /* already closed */ }
	}
	if (dbPath) {
		try { await fs.unlink(dbPath); } catch { /* file may not exist */ }
		try { await fs.unlink(dbPath + '-wal'); } catch { /* ok */ }
		try { await fs.unlink(dbPath + '-shm'); } catch { /* ok */ }
	}
});

/**
 * Helper: run a read-only query against the store's database file via a separate
 * raw connection. WHY a separate connection: the FTS index and triggers live at
 * the SQL layer, below the GraphStore interface — inspecting them through the
 * store would prove nothing about the triggers (the store could be doing code-level
 * sync). A raw read proves the DB-level machinery works on its own.
 */
function rawAll(sql: string, ...params: unknown[]): unknown[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

// ── FTS5 availability probe ─────────────────────────────────────────────

describe('FTS5 availability', () => {
	// Spec §3 "unverified assumption": better-sqlite3's bundled SQLite must have FTS5
	// compiled in. This probe runs FIRST — if it fails, Phase A stops here (spec §12.9)
	// and the fallback design (contentless manual index) needs a human decision.
	it('bundled SQLite has the fts5 module', () => {
		const db = new Database(':memory:');
		try {
			expect(() => db.exec('CREATE VIRTUAL TABLE probe USING fts5(c)')).not.toThrow();
		} finally {
			db.close();
		}
	});
});

// ── Migration v11: obs_fts table, rebuild of existing rows, trigger sync ──

describe('v11 migration: obs_fts index', () => {
	beforeEach(async () => {
		dbPath = tempDbPath();
		store = new SqliteStore(dbPath);
		await store.init();
	});

	it('schema_version is at least 11 after init', () => {
		const rows = rawAll('SELECT version FROM schema_version') as { version: number }[];
		expect(rows[0].version).toBeGreaterThanOrEqual(11);
	});

	it('new observations are searchable through the FTS index (insert trigger)', async () => {
		await store.createEntities([
			{ name: 'FtsProbe', entityType: 'test', observations: ['the zebra crossed the qualifier'] },
		]);
		// Join back to observations: the index stores rowids; the join is also how
		// production queries filter to active rows.
		const hits = rawAll(
			`SELECT o.entity_id FROM obs_fts
			 JOIN observations o ON o.id = obs_fts.rowid
			 WHERE obs_fts MATCH '"zebra"'`
		);
		expect(hits.length).toBe(1);
	});

	it('superseded observations REMAIN in the index (filtering is the query-time join)', async () => {
		// Design decision (spec §4.1): supersede/delete only UPDATE superseded_at, which
		// fires no content trigger — the row stays indexed and correctness lives in ONE
		// place, the query-time superseded_at='' join. This test pins that design: if a
		// future change starts deleting index rows on supersede, as_of-era FTS behavior
		// and this invariant both need rethinking, so the test should fail loudly.
		await store.createEntities([
			{ name: 'FtsSupersede', entityType: 'test', observations: ['the axolotl regenerated'] },
		]);
		await store.deleteObservations([
			{ entityName: 'FtsSupersede', contents: ['the axolotl regenerated'] },
		]);
		const indexed = rawAll(`SELECT rowid FROM obs_fts WHERE obs_fts MATCH '"axolotl"'`);
		expect(indexed.length).toBe(1); // still indexed...
		const active = rawAll(
			`SELECT o.id FROM obs_fts
			 JOIN observations o ON o.id = obs_fts.rowid AND o.superseded_at = ''
			 WHERE obs_fts MATCH '"axolotl"'`
		);
		expect(active.length).toBe(0); // ...but invisible through the active-only join
	});

	it('pre-existing observations are indexed by the migration rebuild', async () => {
		// Simulate an already-populated pre-v11 database by writing an observation,
		// then dropping and rebuilding the index the way the migration's 'rebuild'
		// command does. WHY not construct a real v10 db here: migration-validation.test.ts
		// owns cross-version fixtures; this test only pins that 'rebuild' picks up rows
		// that predate the index — the property the one-time migration depends on.
		await store.createEntities([
			{ name: 'FtsRebuild', entityType: 'test', observations: ['the quokka smiled beforehand'] },
		]);
		const db = new Database(dbPath);
		try {
			db.exec(`DELETE FROM obs_fts`); // wipe index; observation row remains
			const empty = db.prepare(`SELECT rowid FROM obs_fts WHERE obs_fts MATCH '"quokka"'`).all();
			expect(empty.length).toBe(0);
			db.exec(`INSERT INTO obs_fts(obs_fts) VALUES ('rebuild')`);
			const rebuilt = db.prepare(`SELECT rowid FROM obs_fts WHERE obs_fts MATCH '"quokka"'`).all();
			expect(rebuilt.length).toBe(1);
		} finally {
			db.close();
		}
	});
});

// ── searchNodes relevance mode (Pool 1 = vectors OFF: LIKE + FTS lists only) ──

describe('searchNodes relevance mode', () => {
	beforeEach(async () => {
		dbPath = tempDbPath();
		store = new SqliteStore(dbPath);
		await store.init();
	});

	/**
	 * Fixture: two entities that BOTH match the query 'vector search', constructed
	 * so recency and relevance modes must disagree on the winner.
	 *
	 * EntA (older): observation contains the literal phrase twice → LIKE hit
	 *   (substring) AND a strong FTS hit (both tokens, repeated).
	 * EntB (newer): matches ONLY via its entity NAME ('vector searchers guild') —
	 *   a LIKE hit on the name column; its observation content shares no query
	 *   token, so FTS (which indexes observation content only) never lists it.
	 *
	 * Hand-derived fusion (equal weights 1.0, vectors off):
	 *   LIKE list is recency-ordered → [B, A]; FTS list → [A].
	 *   A = 1/62 (LIKE rank 1) + 1/61 (FTS rank 0) ≈ 0.0325
	 *   B = 1/61 (LIKE rank 0)                     ≈ 0.0164  → A wins relevance.
	 * Recency mode must still return B first (newer updated_at) — pinning that
	 * the default path is untouched.
	 */
	async function seedRelevanceFixture(): Promise<void> {
		await store.createEntities([
			{ name: 'EntA', entityType: 'test', observations: ['vector search threshold calibration notes for vector search quality'] },
		]);
		await store.createEntities([
			{ name: 'vector searchers guild', entityType: 'test', observations: ['completely unrelated filler content'] },
		]);
		// Bump the guild's updated_at deterministically (don't rely on creation-ms ordering).
		await store.addObservations([
			{ entityName: 'vector searchers guild', contents: ['more filler that shares no query tokens'] },
		]);
	}

	it('ranks the dense FTS match above the recency winner; recency mode unchanged', async () => {
		await seedRelevanceFixture();
		const rel = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(rel.entities[0].name).toBe('EntA');
		expect(rel.entities.map(e => e.name)).toContain('vector searchers guild');

		const rec = await store.searchNodes('vector search', undefined, { limit: 10 });
		expect(rec.entities[0].name).toBe('vector searchers guild'); // newer wins recency
	});

	it('returns nextCursor null, honors limit, and reports the full candidate count', async () => {
		await seedRelevanceFixture();
		await store.createEntities([
			{ name: 'EntC', entityType: 'test', observations: ['a third note about vector search tuning'] },
		]);
		const rel = await store.searchNodes('vector search', undefined, { limit: 2 }, undefined, undefined, 'relevance');
		expect(rel.entities.length).toBe(2);
		expect(rel.nextCursor).toBeNull();
		expect(rel.totalCount).toBe(3); // all three candidates counted, page capped at 2
	});

	it('respects projectId scoping (out-of-project candidates excluded)', async () => {
		await store.createEntities([
			{ name: 'InProj', entityType: 'test', observations: ['vector search inside the project'] },
		], 'proj-x');
		await store.createEntities([
			{ name: 'OtherProj', entityType: 'test', observations: ['vector search in another project'] },
		], 'proj-y');
		const rel = await store.searchNodes('vector search', 'proj-x', { limit: 10 }, undefined, undefined, 'relevance');
		const names = rel.entities.map(e => e.name);
		expect(names).toContain('InProj');
		expect(names).not.toContain('OtherProj');
	});

	it('respects the memoryType filter in both candidate lists', async () => {
		await store.createEntities([
			{ name: 'TypedEnt', entityType: 'test', observations: [] },
		]);
		await store.addObservations([
			{ entityName: 'TypedEnt', contents: ['vector search decision record'], memoryTypes: ['decision'] },
		]);
		await store.createEntities([
			{ name: 'UntypedEnt', entityType: 'test', observations: ['vector search untyped note'] },
		]);
		const rel = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, 'decision', 'relevance');
		const names = rel.entities.map(e => e.name);
		expect(names).toContain('TypedEnt');
		expect(names).not.toContain('UntypedEnt');
	});

	it('superseded observations contribute to neither candidate list', async () => {
		await store.createEntities([
			{ name: 'Retired', entityType: 'test', observations: ['vector search retired knowledge'] },
		]);
		await store.deleteObservations([
			{ entityName: 'Retired', contents: ['vector search retired knowledge'] },
		]);
		const rel = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(rel.entities.map(e => e.name)).not.toContain('Retired');
	});

	it('rejects cursor and asOf combined with relevance mode (store-level guard)', async () => {
		await seedRelevanceFixture();
		// Grab a real cursor from a recency query so the guard (not cursor decoding) is what trips.
		await expect(
			store.searchNodes('vector search', undefined, { limit: 1, cursor: 'anything' }, undefined, undefined, 'relevance')
		).rejects.toThrow(/relevance/);
		await expect(
			store.searchNodes('vector search', undefined, { limit: 1 }, '2026-01-01T00:00:00.000Z', undefined, 'relevance')
		).rejects.toThrow(/relevance/);
	});
});

// ── JSONL backend: relevance gracefully degrades to recency + flag ────────────

describe('JSONL relevance fallback', () => {
	it('returns recency order with rankingUnavailable flag', async () => {
		const jsonlPath = path.join(testDir, `test-fts-jsonl-${Date.now()}.jsonl`);
		const jstore = new JsonlStore(jsonlPath);
		try {
			await jstore.init();
			await jstore.createEntities([
				{ name: 'JsonlEnt', entityType: 'test', observations: ['vector search note'] },
			]);
			const res = await jstore.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
			expect(res.entities.map(e => e.name)).toContain('JsonlEnt');
			expect(res.rankingUnavailable).toBe(true);
		} finally {
			try { await fs.unlink(jsonlPath); } catch { /* ok */ }
		}
	});
});
