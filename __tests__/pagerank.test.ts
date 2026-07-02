/**
 * pagerank.test.ts — Unit tests for the bounded personalized-PageRank module
 * (Phase E of the 2026-07-02 retrieval plan).
 *
 * Pure function, Pool 1 (no DB, no model) — same rationale as rank-fusion.test.ts.
 *
 * Test-rigor note (spec §12.5): expected values are derived BY HAND in comments
 * by walking the power iteration (alpha=0.5, 3 iterations, undirected,
 * degree-normalized) — never by calling the function under test.
 */

import { describe, it, expect } from 'vitest';
import { personalizedPageRank } from '../pagerank.js';

describe('personalizedPageRank', () => {
	it('star graph seeded at the center: center > each leaf > non-connected', () => {
		// Edges A-B, A-C, A-D; seed {A: 1}. Hand walk (alpha .5, 3 iters):
		//   iter1: A spreads .5·1/3 = 1/6 to each leaf; restart A += .5
		//          → A=.5, leaves 1/6 each
		//   iter2: A spreads .5·.5/3 = 1/12 to each leaf; each leaf returns
		//          .5·(1/6)/1 = 1/12 to A (3 · 1/12 = .25); restart A += .5
		//          → A=.75, leaves 1/12 each
		//   iter3: same shape → A stays dominant, leaves positive.
		const rank = personalizedPageRank(
			[['A', 'B'], ['A', 'C'], ['A', 'D']],
			new Map([['A', 1]]),
		);
		expect(rank.get('A')!).toBeGreaterThan(rank.get('B')!);
		expect(rank.get('B')!).toBeGreaterThan(0);
		expect(rank.get('B')!).toBeCloseTo(rank.get('C')!, 12); // symmetry
		expect(rank.get('E')).toBeUndefined(); // never reached
	});

	it('chain A-B-C seeded at A: two-hop reach with distance decay', () => {
		// Edges A-B, B-C; seed {A: 1}. Hand walk:
		//   iter1: A→B .5; restart → A=.5, B=.5
		//   iter2: A→B .25; B splits .5·.5/2 = .125 to A and C; restart
		//          → A=.625, B=.25, C=.125
		//   iter3: A→B .3125; B→A,C .0625 each; C→B .0625; restart
		//          → A=.5625, B=.375, C=.0625
		// Exact final values asserted — a wrong alpha, iteration count, or a
		// directed (non-symmetric) walk all produce different numbers.
		const rank = personalizedPageRank(
			[['A', 'B'], ['B', 'C']],
			new Map([['A', 1]]),
		);
		expect(rank.get('A')!).toBeCloseTo(0.5625, 12);
		expect(rank.get('B')!).toBeCloseTo(0.375, 12);
		expect(rank.get('C')!).toBeCloseTo(0.0625, 12);
		expect(rank.get('D')).toBeUndefined(); // isolated node untouched
	});

	it('empty edge list: only the seeds carry rank (restart term only)', () => {
		const rank = personalizedPageRank([], new Map([['A', 1], ['B', 3]]));
		// No spreading — each iteration re-deposits alpha · normalized seed.
		// Seed weights need not be pre-normalized; B got 3× A's weight.
		expect(rank.get('A')!).toBeGreaterThan(0);
		expect(rank.get('B')!).toBeCloseTo(rank.get('A')! * 3, 12);
		expect(rank.size).toBe(2);
	});

	it('is deterministic across runs (no randomness, stable iteration)', () => {
		const edges: Array<[string, string]> = [['A', 'B'], ['B', 'C'], ['C', 'A'], ['C', 'D']];
		const seeds = new Map([['A', 0.9], ['D', 0.4]]);
		const r1 = personalizedPageRank(edges, seeds);
		const r2 = personalizedPageRank(edges, seeds);
		expect([...r1.entries()].sort()).toEqual([...r2.entries()].sort());
	});

	it('self-loops contribute nothing to diffusion', () => {
		// A-A must not trap rank: identical result with and without the loop.
		const withLoop = personalizedPageRank([['A', 'A'], ['A', 'B']], new Map([['A', 1]]));
		const without = personalizedPageRank([['A', 'B']], new Map([['A', 1]]));
		expect(withLoop.get('A')!).toBeCloseTo(without.get('A')!, 12);
		expect(withLoop.get('B')!).toBeCloseTo(without.get('B')!, 12);
	});
});
