// race-init-child.mjs — one participant in the two-connection migration race.
//
// DEF-RR-04 harness worker. The migration chain's race discipline (IMMEDIATE
// transactions + in-transaction version re-checks + race-tolerant duplicate-
// column ALTERs) has been verified by trace but never exercised by two real
// OS processes hitting a fresh DB at once. This worker is that second process:
// the parent spawns two of these against the SAME empty .db path so their
// init() migration chains genuinely interleave at the SQLite file level.
//
// Why a standalone .mjs child (not an in-test worker): vitest transpiles TS in
// its own runtime context. A real concurrent test needs two SEPARATE OS
// processes with two independent better-sqlite3 connections — vitest's
// transpiler doesn't reach into a spawned `node` process, so the child must
// import already-compiled JS. Hence the dependency on `npm run build` having
// produced dist/ (the parent test guards on this and skips loudly if absent).
//
// Contract: argv[2] is the DB path. Construct SqliteStore, await init() (this
// runs the full migration chain), close(), exit 0. Any throw → print the error
// (with stack) to stderr and exit 1, so the parent can surface the loser's
// failure text in its assertion message — a migration race failure without the
// loser's error is undebuggable.

import { SqliteStore } from '../../dist/sqlite-store.js';

const dbPath = process.argv[2];

if (!dbPath) {
	// Defensive: the parent always passes a path. If it somehow didn't, fail
	// loudly rather than constructing a store against `undefined`.
	console.error('race-init-child: missing DB path argument (argv[2])');
	process.exit(1);
}

// Top-level await is fine in an ES module. Errors propagate to the catch, which
// is the ONLY place this process is allowed to exit non-zero from — a clean run
// falls through to exit 0.
try {
	const store = new SqliteStore(dbPath);
	await store.init();
	await store.close();
	process.exit(0);
} catch (err) {
	// Print the full error so the parent's captured stderr carries the stack,
	// not just a one-line message. `err instanceof Error` guards the non-Error
	// throw case (SQLite can surface odd shapes under contention).
	const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
	console.error(`race-init-child failed for ${dbPath}:\n${detail}`);
	process.exit(1);
}
