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
		// The cursor value never gets decoded: the relevance guard fires before
		// decodeCursor, so an arbitrary string isolates the guard (not cursor
		// validation) as the thrower — pinned by matching the guard's message.
		await expect(
			store.searchNodes('vector search', undefined, { limit: 1, cursor: 'anything' }, undefined, undefined, 'relevance')
		).rejects.toThrow(/relevance/);
		await expect(
			store.searchNodes('vector search', undefined, { limit: 1 }, '2026-01-01T00:00:00.000Z', undefined, 'relevance')
		).rejects.toThrow(/relevance/);
	});

	it('explicit orderBy recency matches omitted orderBy exactly', async () => {
		// Pins that 'recency' is a true default, not a third behavior.
		await seedRelevanceFixture();
		const omitted = await store.searchNodes('vector search', undefined, { limit: 10 });
		const explicit = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'recency');
		expect(explicit.entities.map(e => e.name)).toEqual(omitted.entities.map(e => e.name));
		expect(explicit.totalCount).toBe(omitted.totalCount);
	});

	it('floors a fractional limit from direct store callers (clampLimit hardening)', async () => {
		// MCP callers are integer-gated by Zod; direct GraphStore consumers are
		// not — 2.7 must floor to 2 rather than flowing into KNN k-arithmetic.
		await seedRelevanceFixture();
		await store.createEntities([
			{ name: 'EntC', entityType: 'test', observations: ['a third note about vector search tuning'] },
		]);
		const rel = await store.searchNodes('vector search', undefined, { limit: 2.7 }, undefined, undefined, 'relevance');
		expect(rel.entities.length).toBe(2);
	});

	it('FTS-only membership: diacritic-folded matches appear in relevance mode, and survive punctuation tokens', async () => {
		// 'Voilà' is invisible to LIKE's ASCII-only case fold (à ≠ a) but the
		// FTS unicode61 remove_diacritics tokenizer folds it — so this entity's
		// presence in relevance results proves the FTS list contributes real
		// MEMBERSHIP (not just reordering), end-to-end through the store.
		await store.createEntities([
			{ name: 'DiacriticEnt', entityType: 'test', observations: ['Voilà: provençal observations'] },
		]);
		const clean = await store.searchNodes('voila', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(clean.entities.map(e => e.name)).toContain('DiacriticEnt');
		// Punctuation token in the query must not cost the FTS list (review
		// Discussion #82 finding: pre-fix, '"voila" "-"' relied on undocumented
		// empty-phrase tolerance; the sanitizer now drops the '-' token).
		const punct = await store.searchNodes('voila -', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(punct.entities.map(e => e.name)).toContain('DiacriticEnt');
	});

	it('activation reranks: an accessed entity beats an equal never-accessed one', async () => {
		// Phase B2. Construction makes the outcome hand-derivable regardless of
		// FTS tie-breaking: entity A is created normally (access_count ≥ 1, on
		// the activation list); entity B is inserted via RAW SQL with a NEWER
		// updated_at and access_count 0 — never accessed, so it contributes to
		// LIKE/FTS but is EXCLUDED from the activation list (-Infinity).
		// Hand math (weights: LIKE 1.0, FTS 1.0, activation 0.5):
		//   B (LIKE rank 0, newer): 1/61 + fts_B
		//   A (LIKE rank 1):        1/62 + fts_A + 0.5/61 (activation rank 0)
		// Even in the worst FTS tie order (B first): A ≈ .0161+.0161+.0082=.0405
		// vs B ≈ .0164+.0164=.0328 → A wins on activation alone.
		// (Cross-exam-verified, Discussion #84: without activation, B wins under
		// BOTH FTS tie orders, so this test cannot pass without List 4's points.)
		await store.createEntities([
			{ name: 'AccessedEnt', entityType: 'test', observations: ['activation probe target alpha'] },
		]);
		// Raw-insert the never-accessed twin (bypasses the store's touch-on-create;
		// the FTS insert trigger indexes its observation automatically).
		const db = new Database(dbPath);
		try {
			const future = new Date(Date.now() + 60_000).toISOString(); // strictly newer updated_at
			db.prepare(
				`INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at) VALUES (?, ?, ?, ?, ?)`
			).run('ColdEnt', 'coldent', 'test', future, future);
			const entId = (db.prepare(`SELECT id FROM entities WHERE name = 'ColdEnt'`).get() as { id: number }).id;
			db.prepare(
				`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`
			).run(entId, 'activation probe target beta', future);
		} finally {
			db.close();
		}
		const rel = await store.searchNodes('activation probe', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		const names = rel.entities.map(e => e.name);
		expect(names).toContain('ColdEnt');           // still a member (LIKE+FTS nominate it)
		expect(names[0]).toBe('AccessedEnt');         // activation decides the order
		// Recency mode control: the raw-inserted twin is newer → it wins there,
		// proving the inversion above came from activation, not list membership.
		const rec = await store.searchNodes('activation probe', undefined, { limit: 10 });
		expect(rec.entities[0].name).toBe('ColdEnt');
	});

	it('activation never nominates: a hot but irrelevant entity stays out', async () => {
		await seedRelevanceFixture();
		await store.createEntities([
			{ name: 'HotUnrelated', entityType: 'test', observations: ['completely different topic entirely'] },
		]);
		// Heat it up: repeated intentional access.
		for (let i = 0; i < 5; i++) {
			await store.openNodes(['HotUnrelated']);
		}
		const rel = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		// Activation only RERANKS the LIKE/FTS/vector candidate union — it must
		// never pull a non-matching entity into the results (spec §5.4).
		expect(rel.entities.map(e => e.name)).not.toContain('HotUnrelated');
		// Positive control (review #84): the query must actually return results,
		// otherwise the absence assertion above would pass vacuously.
		expect(rel.entities.map(e => e.name)).toContain('EntA');
	});

	it('activation weight stays bounded: retrieval heat never overrides relevance', async () => {
		// Pins the load-bearing "nudges, never overrides" claim (spec §5.4 /
		// weight 0.5). Construction (cross-exam-corrected, Discussion #84 —
		// the cold entity MUST be raw-inserted; a createEntities twin is seeded
		// access_count 1, joins the activation list, and the detection
		// threshold balloons from w≈1.02 to w≈63):
		//   Hot: matches via entity NAME only (LIKE list, no FTS), heated 5×.
		//   Cold: raw-inserted (count 0, excluded from activation), matches
		//   via observation content → LIKE + FTS lists.
		// Hand math at w=0.5: cold = 1/61 + 1/61 ≈ .0328 (LIKE rank varies ≤1
		// slot; worst .0161+.0164) vs hot = 1/61 + 0.5/61 ≈ .0246. Cold wins
		// for any activation weight below ≈1.0; a weight regression above that
		// flips this test.
		await store.createEntities([
			{ name: 'weighted probe station', entityType: 'test', observations: ['nothing relevant here'] },
		]);
		for (let i = 0; i < 5; i++) {
			await store.openNodes(['weighted probe station']);
		}
		const db = new Database(dbPath);
		try {
			const future = new Date(Date.now() + 60_000).toISOString();
			db.prepare(
				`INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at) VALUES (?, ?, ?, ?, ?)`
			).run('ColdRelevant', 'coldrelevant', 'test', future, future);
			const entId = (db.prepare(`SELECT id FROM entities WHERE name = 'ColdRelevant'`).get() as { id: number }).id;
			db.prepare(
				`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`
			).run(entId, 'weighted probe analysis', future);
		} finally {
			db.close();
		}
		const rel = await store.searchNodes('weighted probe', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(rel.entities[0].name).toBe('ColdRelevant');
	});

	it('never-accessed entities are EXCLUDED from the activation list, not tail-ranked', async () => {
		// Deterministic pin for the -Infinity exclusion (review #84 (d): the
		// FTS tie order is plan-determined, so a regression to tail-ranking
		// would consistently HIDE in a given environment rather than flake —
		// this construction detects it in both tie orders).
		//   A: created normally (access_count ≥ 1, recent → activation rank 0).
		//   C: raw-inserted cold, STRICTLY better lexical profile — newer
		//      updated_at (LIKE rank 0) and a shorter observation with the same
		//      term hits (better bm25 → FTS rank 0, no tie to break).
		// Hand math (weights 1.0/1.0/0.5): C leads lexically by
		// (1/61−1/62)·2 ≈ .00053. Correct exclusion: A's activation bonus is
		// 0.5/61 ≈ .0082 → A wins by ≈ .0077. Regression to tail-ranking: C
		// takes activation rank 1 → A's net bonus shrinks to
		// 0.5/61 − 0.5/62 ≈ .00013 < .00053 → C wins. Assert A first.
		await store.createEntities([
			{ name: 'ExclusionAccessed', entityType: 'test', observations: ['exclusion checkpoint among several other trailing words'] },
		]);
		const db = new Database(dbPath);
		try {
			const future = new Date(Date.now() + 60_000).toISOString();
			db.prepare(
				`INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at) VALUES (?, ?, ?, ?, ?)`
			).run('ExclusionCold', 'exclusioncold', 'test', future, future);
			const entId = (db.prepare(`SELECT id FROM entities WHERE name = 'ExclusionCold'`).get() as { id: number }).id;
			db.prepare(
				`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`
			).run(entId, 'exclusion checkpoint', future); // shorter doc, same terms → strictly better bm25
		} finally {
			db.close();
		}
		const rel = await store.searchNodes('exclusion checkpoint', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(rel.entities.map(e => e.name)).toContain('ExclusionCold'); // still a member
		expect(rel.entities[0].name).toBe('ExclusionAccessed');           // exclusion decides
	});

	it('reports rankingDegraded when the FTS list is lost, and omits it on healthy runs', async () => {
		await seedRelevanceFixture();
		// Healthy run first (vectors are configured OFF in Pool 1 = 'unavailable'
		// = deliberate configuration, NOT degradation — flag must be absent).
		const healthy = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(healthy.rankingDegraded).toBeUndefined();
		// Break the FTS index out from under the store (simulates index corruption
		// or an FTS5-less rebuild). Dropping the table makes the MATCH throw into
		// the degradation path. NOTE: this also breaks the insert triggers, so no
		// writes after this point in the test.
		const db = new Database(dbPath);
		try {
			db.exec('DROP TABLE obs_fts');
		} finally {
			db.close();
		}
		const degraded = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
		expect(degraded.rankingDegraded).toEqual(['fts']);
		// Results still come back via the LIKE list — degraded, not dead.
		expect(degraded.entities.length).toBeGreaterThan(0);
	});
});

// ── Sanitizer vs the real FTS5 parser (round-trip; the contract is the parser,
//    not a string shape — review Discussion #82, test-analyzer + security) ─────

describe('toFtsQuery round-trip through real FTS5', () => {
	it('hostile inputs neither throw nor match unintended rows', async () => {
		const { toFtsQuery } = await import('../rank-fusion.js');
		const db = new Database(':memory:');
		try {
			db.exec(`CREATE VIRTUAL TABLE t USING fts5(content, tokenize='unicode61 remove_diacritics 2')`);
			db.prepare(`INSERT INTO t(content) VALUES (?)`).run('vector search calibration notes');
			const hostile = [
				'"unbalanced', 'trailing \\', 'NEAR(a b)', 'content:x', '-', '*', '^caret',
				'a"b', '""', 'foo -', '(paren', 'NOT vector', ' vector',
			];
			for (const raw of hostile) {
				// Contract: sanitized MATCH must never throw, whatever the input.
				const q = toFtsQuery(raw);
				const rows = db.prepare(`SELECT count(*) AS n FROM t WHERE t MATCH ?`).get(q) as { n: number };
				expect(rows.n).toBeGreaterThanOrEqual(0); // reached = no throw
			}
			// Literal-semantics spot checks: operators are matched as text, not executed.
			// 'NOT vector' must AND-match both tokens (0 rows here: 'not' absent) —
			// if NOT executed as an operator, it would instead match the row.
			const notQ = toFtsQuery('NOT vector');
			expect((db.prepare(`SELECT count(*) AS n FROM t WHERE t MATCH ?`).get(notQ) as { n: number }).n).toBe(0);
			// Punctuation token dropped → both real tokens still required and found.
			const punctQ = toFtsQuery('vector - search');
			expect((db.prepare(`SELECT count(*) AS n FROM t WHERE t MATCH ?`).get(punctQ) as { n: number }).n).toBe(1);
		} finally {
			db.close();
		}
	});
});

// ── Trigger behavior under raw-SQL writes (the eviction paths) ─────────────────

describe('FTS triggers under raw-SQL observation writes', () => {
	beforeEach(async () => {
		dbPath = tempDbPath();
		store = new SqliteStore(dbPath);
		await store.init();
	});

	it('obs_fts_au: content-strip UPDATE (eviction Tier-2 shape) re-syncs the index', async () => {
		// One observation per entity — deliberately: two active observations
		// sharing a superseded_at would trip the PRE-EXISTING Tier-2 UNIQUE
		// collision (Issue #83), which is not what this test pins.
		await store.createEntities([
			{ name: 'StripTarget', entityType: 'test', observations: ['the wolverine kept its secret'] },
		]);
		const db = new Database(dbPath);
		try {
			// Raw SQL exactly like evict.ts Tier-2 — bypasses GraphStore entirely;
			// only the DB-level trigger can keep the index consistent.
			db.prepare(`UPDATE observations SET content = '' WHERE content = ?`).run('the wolverine kept its secret');
			const stale = db.prepare(`SELECT rowid FROM obs_fts WHERE obs_fts MATCH '"wolverine"'`).all();
			expect(stale.length).toBe(0); // old content is out of the index
		} finally {
			db.close();
		}
	});

	it('obs_fts_ad: raw DELETE (eviction Tier-1 shape) removes the index row', async () => {
		await store.createEntities([
			{ name: 'DeleteTarget', entityType: 'test', observations: ['the pangolin rolled away'] },
		]);
		const db = new Database(dbPath);
		try {
			db.prepare(`DELETE FROM observations WHERE content = ?`).run('the pangolin rolled away');
			const stale = db.prepare(`SELECT rowid FROM obs_fts WHERE obs_fts MATCH '"pangolin"'`).all();
			expect(stale.length).toBe(0);
		} finally {
			db.close();
		}
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

	it('rejects cursor + relevance (contract mirrors the SQLite guard)', async () => {
		// Even though JSONL's fallback is recency (which paginates fine), the
		// cursor+relevance combination must behave identically across backends —
		// otherwise caller behavior silently depends on store configuration.
		const jsonlPath = path.join(testDir, `test-fts-jsonl-guard-${Date.now()}.jsonl`);
		const jstore = new JsonlStore(jsonlPath);
		try {
			await jstore.init();
			await expect(
				jstore.searchNodes('anything', undefined, { limit: 1, cursor: 'x' }, undefined, undefined, 'relevance')
			).rejects.toThrow(/relevance/);
		} finally {
			try { await fs.unlink(jsonlPath); } catch { /* ok */ }
		}
	});
});
