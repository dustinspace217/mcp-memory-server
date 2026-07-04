// migration-race.test.ts — DEF-RR-04 empirical two-connection migration race.
//
// The migration chain in sqlite-store.ts guards concurrent startup with three
// mechanisms: IMMEDIATE transactions (acquire the write lock up front so a
// racing instance blocks rather than reading a stale snapshot), in-transaction
// version re-checks (a second instance that already saw the migration applied
// skips the corpus-sized work instead of repeating it), and race-tolerant
// duplicate-column ALTERs (Issue #78 — an ALTER that already ran is swallowed).
// All three were verified by trace across three review lenses but never
// exercised by two real processes hitting a fresh DB simultaneously. This suite
// is that empirical exercise.
//
// It spawns TWO separate `node` processes (see helpers/race-init-child.mjs for
// why a spawned process rather than an in-test worker — vitest's TS transpiler
// doesn't reach a child process, so the child imports compiled dist/) against
// one fresh temp .db. Both run the full migration chain concurrently. We then
// assert the DB is not merely intact but USABLE: correct version, integrity_check
// ok, exactly one vec_config row, obs_fts present, and a real write/read round-trip.
//
// Two timing profiles: SIMULTANEOUS (both spawned back-to-back — maximizes the
// odds both start the chain together) and STAGGERED (B spawned 50ms after A — B
// arrives mid-chain with high probability, exercising the in-transaction re-check
// and BUSY-retry paths rather than the both-at-version-1 path). Two profiles beat
// one because they stress different points in the interleaving.
//
// If a test here FAILS, it has found a REAL race bug. Per the DEF-RR-04 charter,
// the harness does not paper over it: the failure message carries BOTH children's
// stderr and the final schema state so a human can decide. Stopping on a genuine
// race finding is the success condition of this harness, not a regression in it.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const childPath = path.join(testDir, 'helpers', 'race-init-child.mjs');
// The child imports ../../dist/sqlite-store.js relative to helpers/, which
// resolves to this repo's dist/. Feasibility hinges on that build artifact.
const distStorePath = path.join(testDir, '..', 'dist', 'sqlite-store.js');
const distAvailable = existsSync(distStorePath);

// Per-child watchdog. A migration chain on a fresh DB is milliseconds; 60s is a
// generous ceiling that only trips on a genuine deadlock/hang (Power-of-Ten rule
// 2 — this loop's "iteration" is a spawned process, and its upper bound is time).
const CHILD_TIMEOUT_MS = 60_000;

// Result of one spawned child: exit code (null on watchdog kill) plus captured
// stderr (ALWAYS captured — a race failure without the loser's error is
// undebuggable) and a timedOut flag the caller folds into its assertion message.
interface ChildResult {
	code: number | null;
	stderr: string;
	timedOut: boolean;
}

/**
 * Spawns one race-init child against `dbPath` and resolves when it exits (or the
 * watchdog kills it). Never rejects — a failed child is DATA the test asserts on,
 * not an exception that aborts the harness. MEMORY_VECTOR_SEARCH=off is forced so
 * the child never loads the ONNX embedding model (compute-expensive-testing rule:
 * this suite tests the migration substrate, not vectors) — vec_config and obs_fts
 * are created by the migration chain regardless of that flag, so the assertions
 * below still hold.
 */
function runChild(dbPath: string): Promise<ChildResult> {
	return new Promise((resolve) => {
		const child = spawn('node', [childPath, dbPath], {
			env: { ...process.env, MEMORY_VECTOR_SEARCH: 'off' },
		});

		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

		// Watchdog: kill a hung child and mark it timed out. Cleared on normal exit.
		const watchdog = setTimeout(() => {
			child.kill('SIGKILL');
			resolve({ code: null, stderr, timedOut: true });
		}, CHILD_TIMEOUT_MS);

		child.on('exit', (code) => {
			clearTimeout(watchdog);
			resolve({ code, stderr, timedOut: false });
		});
		// spawn error (e.g. node not found) — surface it as a failed child rather
		// than an unhandled rejection.
		child.on('error', (err) => {
			clearTimeout(watchdog);
			resolve({ code: null, stderr: stderr + `\nspawn error: ${err.message}`, timedOut: false });
		});
	});
}

// Small delay helper for the staggered profile. Bounded, single use.
function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Asserts the post-race DB is intact AND usable. Opens a raw read-only connection
 * for the structural checks (version, integrity, vec_config, obs_fts), then a real
 * SqliteStore for a write/read round-trip (the DB works, not just parses). Builds a
 * rich failure preamble from both children's results so a genuine race bug reports
 * the losers' stderr, not a bare "expected 17, got 1".
 */
async function assertUsableDb(dbPath: string, results: ChildResult[]): Promise<void> {
	// Preamble folded into every assertion message: exit codes + captured stderr.
	const preamble = results
		.map((r, i) =>
			`child ${i}: code=${r.code}${r.timedOut ? ' (TIMED OUT)' : ''}` +
			(r.stderr.trim() ? `\n  stderr: ${r.stderr.trim().replace(/\n/g, '\n  ')}` : ''))
		.join('\n');

	// Both children must have exited cleanly. This is the first thing to fail if a
	// racing instance died on SQLITE_BUSY_SNAPSHOT or a duplicate-column ALTER.
	for (let i = 0; i < results.length; i++) {
		expect(results[i].timedOut, `child ${i} timed out (deadlock?)\n${preamble}`).toBe(false);
		expect(results[i].code, `child ${i} exited non-zero\n${preamble}`).toBe(0);
	}

	const conn = new Database(dbPath, { readonly: true });
	try {
		const version = (conn.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
		expect(version, `schema_version wrong after race\n${preamble}`).toBe(17);

		// integrity_check returns a single 'ok' row on a healthy DB, or one row per
		// problem otherwise. A race that corrupted a page or an index shows here.
		const integrity = (conn.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
		expect(integrity, `integrity_check failed after race\n${preamble}`).toBe('ok');

		// Exactly one vec_config row. The CHECK(id=1) single-row constraint plus
		// INSERT OR IGNORE means a double-run of the v15 migration must NOT produce
		// two rows — this is the assertion that would catch a re-run leak.
		const vecCfgCount = (conn.prepare('SELECT COUNT(*) AS n FROM vec_config').get() as { n: number }).n;
		expect(vecCfgCount, `vec_config row count wrong after race\n${preamble}`).toBe(1);

		// obs_fts (the v11 FTS5 virtual table) must exist. sqlite_master lists it as
		// a table entry named obs_fts.
		const obsFts = conn.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obs_fts'`
		).get() as { name: string } | undefined;
		expect(obsFts?.name, `obs_fts missing after race\n${preamble}`).toBe('obs_fts');
	} finally {
		conn.close();
	}

	// Usability round-trip: a fresh store must init against the raced DB and do a
	// real write + read. Intact-but-unusable (e.g. a half-created index) fails here.
	const { SqliteStore } = await import('../dist/sqlite-store.js');
	const store = new SqliteStore(dbPath);
	await store.init();
	try {
		await store.createEntities([
			{ name: 'PostRaceEntity', entityType: 'test', observations: ['written after the race'] },
		]);
		const graph = await store.readGraph();
		const found = graph.entities.find((e) => e.name === 'PostRaceEntity');
		expect(found, `post-race round-trip failed to read back the written entity\n${preamble}`).toBeDefined();
		expect(found?.observations[0].content).toBe('written after the race');
	} finally {
		await store.close();
	}
}

describe('migration chain — two-connection race', () => {
	let dbPath: string;

	beforeAll(() => {
		// dist/ guard. The child is a separate OS process that imports compiled JS
		// (vitest's transpiler doesn't reach it — see race-init-child.mjs). Without a
		// build, the child can't load the store, so skipping is the honest outcome.
		// This repo always `npm run build`s before a full run, so in practice the
		// suite executes; the guard exists so a bare `vitest` on a clean checkout
		// fails loud-but-clear rather than with an opaque module-not-found in a child.
		if (!distAvailable) {
			console.error(
				`\n[migration-race] SKIPPED: ${distStorePath} not found.\n` +
				`  This suite spawns real node child processes that import the COMPILED store\n` +
				`  (a spawned process has no vitest transpiler context, so it cannot load the .ts).\n` +
				`  Run \`npm run build\` first, then re-run.\n`
			);
		}
	});

	afterEach(async () => {
		if (!dbPath) return;
		for (const suffix of ['', '-wal', '-shm']) {
			try { await fs.unlink(dbPath + suffix); } catch { /* ignore — file may not exist */ }
		}
	});

	it.runIf(distAvailable)('survives two SIMULTANEOUS init()s on a fresh DB', async () => {
		dbPath = path.join(testDir, `race-simultaneous-${Date.now()}.db`);

		// Spawn both back-to-back (no await between) so their migration chains start
		// as close together as the OS scheduler allows — the both-at-version-1 case.
		const results = await Promise.all([runChild(dbPath), runChild(dbPath)]);
		await assertUsableDb(dbPath, results);
	});

	it.runIf(distAvailable)('survives a STAGGERED init() arriving mid-chain', async () => {
		dbPath = path.join(testDir, `race-staggered-${Date.now()}.db`);

		// Start A, let it get into the migration chain, THEN start B. B is far more
		// likely to hit an in-transaction version re-check or a BUSY-retry than in the
		// simultaneous profile — a different point in the interleaving space.
		const aPromise = runChild(dbPath);
		await delay(50);
		const bPromise = runChild(dbPath);
		const results = await Promise.all([aPromise, bPromise]);
		await assertUsableDb(dbPath, results);
	});
});
