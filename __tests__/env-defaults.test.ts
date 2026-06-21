import { describe, it, expect } from 'vitest';

// Machine-safety canary for vitest.config.ts's env injection (QA 2026-06-09).
//
// WHY: the safe-by-default config injects MEMORY_VECTOR_SEARCH/'off' and
// SKIP_VECTOR_INTEGRATION/'1' via `test.env`. If a future vitest major ever
// stops applying `test.env`, those defaults vanish SILENTLY — and an UNSET
// MEMORY_VECTOR_SEARCH means the store ENABLES vectors (its gate is
// `!== 'off'`), bringing back the per-fork ONNX model-load hazard that once
// hard-rebooted this machine, with zero signal until RAM pressure. This test
// converts that silent drift into a red test.
//
// It passes in BOTH pools: Pool 1 injects 'off'/'1'; Pool 2 injects the
// canonicalized 'on' with skip '0', so the conditional below no-ops. The one
// combination it rejects — vectors off while the integration suite is told to
// run — is genuinely incoherent and deserves the red.
//
// Limitation (by design): this can't catch a sibling TEST mutating
// process.env mid-suite (see vector-search.test.ts's save/restore discipline);
// it pins the config→worker injection only.
describe('vitest.config env defaults (machine-safety canary)', () => {
	it('test.env injection is alive and canonical', () => {
		expect(process.env.MEMORY_VECTOR_SEARCH).toBeDefined();
		expect(process.env.SKIP_VECTOR_INTEGRATION).toBeDefined();
		// The config canonicalizes whatever the shell provided to 'on'/'off'.
		expect(['on', 'off']).toContain(process.env.MEMORY_VECTOR_SEARCH);
		if (process.env.MEMORY_VECTOR_SEARCH === 'off') {
			expect(process.env.SKIP_VECTOR_INTEGRATION).toBe('1');
		}
	});
});
