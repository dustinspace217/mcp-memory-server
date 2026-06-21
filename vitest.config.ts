import { defineConfig } from 'vitest/config';

// Safe-by-default test configuration (added 2026-06-09, workspace review).
//
// WHY: bare `vitest run` / `npm test` used to be the invocation that once
// HARD-REBOOTED this machine — every parallel vitest fork loaded its own copy
// of the all-MiniLM ONNX embedding model (~400MB each), multiplying past RAM.
// The safety lived entirely in a documented command line (see CLAUDE.md "Test
// pool discipline"); one naive `npm test` away from the incident repeating.
// This config encodes the pool discipline as defaults instead:
//
//   - Pool 1 (default, model-free): MEMORY_VECTOR_SEARCH defaults to 'off'
//     (sqlite-store.ts skips model loading entirely) and
//     SKIP_VECTOR_INTEGRATION defaults to '1' (vector-integration.test.ts
//     self-skips). Bare `npm test` is now exactly the documented safe run.
//
//   - Pool 2 (opt-in, real model): set MEMORY_VECTOR_SEARCH to any non-'off'
//     value (e.g. via the `npm run test:vector` script). SKIP_VECTOR_INTEGRATION
//     then defaults to '0' so the integration tests actually run, and the
//     config FORCES single-fork so exactly ONE process ever loads models
//     (multiple sequential loads within that one fork are possible, but the
//     cross-fork multiplication that caused the reboot cannot happen).
//
// Explicit env vars always win over these defaults (`??` only fills gaps), so
// the historical documented invocations keep working unchanged.
//
// IMPORTANT (QA 2026-06-09, finding M1): the STORE's enable gate is
// `value !== 'off'` (sqlite-store.ts), so 'on', '1', 'true' — anything except
// the literal 'off' — all enable vectors. The config must share that exact
// predicate AND canonicalize what it injects into workers ('on'/'off' only):
// the first version gated singleFork on `=== 'on'`, so MEMORY_VECTOR_SEARCH=1
// would have enabled vectors in every parallel fork WITHOUT the single-fork
// clamp — precisely the multiplication this file exists to prevent.
const vectorOn = (process.env.MEMORY_VECTOR_SEARCH ?? 'off') !== 'off';
const skipVectorIntegration =
	process.env.SKIP_VECTOR_INTEGRATION ?? (vectorOn ? '0' : '1');

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		// test.env sets process.env values inside the test workers. The vector
		// flag is injected in CANONICAL form so workers can never see a value
		// the config's own predicate disagreed with.
		env: {
			MEMORY_VECTOR_SEARCH: vectorOn ? 'on' : 'off',
			SKIP_VECTOR_INTEGRATION: skipVectorIntegration,
		},
		// Real-model runs are serialized into a single fork (see WHY above).
		...(vectorOn
			? { pool: 'forks' as const, poolOptions: { forks: { singleFork: true } } }
			: {}),
	},
});
