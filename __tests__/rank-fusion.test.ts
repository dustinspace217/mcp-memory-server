/**
 * rank-fusion.test.ts — Unit tests for the pure ranking math in rank-fusion.ts:
 * weighted Reciprocal Rank Fusion, the FTS5 query sanitizer, and the ACT-R
 * activation approximation.
 *
 * Model-free, DB-free (Pool 1) — same rationale as precedent-ranking.test.ts:
 * the ranking math must be testable without loading the embedding model or
 * touching SQLite.
 *
 * Test-rigor note (spec §12.5): expected orderings below are derived BY HAND in
 * comments from the RRF formula score = Σ weight/(60 + rank + 1) — never by
 * calling the function under test. A test that mirrors the implementation's
 * own formula can't catch a wrong formula.
 */

import { describe, it, expect } from 'vitest';
import { fuseRanks, toFtsQuery, activationScore } from '../rank-fusion.js';

describe('fuseRanks', () => {
	it('ranks an id appearing on two lists above an id on one list (equal weights)', () => {
		// Hand derivation: A at rank 0 on both lists → 1/61 + 1/61 ≈ 0.03279.
		// B at rank 1 on one list → 1/62 ≈ 0.01613. A must beat B.
		const scores = fuseRanks([
			{ weight: 1, ids: ['A', 'B'] },
			{ weight: 1, ids: ['A'] },
		]);
		expect(scores.get('A')!).toBeGreaterThan(scores.get('B')!);
	});

	it('computes the exact RRF contribution for a single list', () => {
		// Hand derivation: rank 0 with weight 0.5 → 0.5/(60+0+1) = 0.5/61.
		const scores = fuseRanks([{ weight: 0.5, ids: ['A'] }]);
		expect(scores.get('A')!).toBeCloseTo(0.5 / 61, 10);
	});

	it('a high rank on a heavy list can beat a low rank on a light list', () => {
		// Hand derivation: A rank 4 on weight-1.0 list → 1/65 ≈ 0.01538.
		// B rank 0 on weight-0.5 list → 0.5/61 ≈ 0.00820. A must beat B —
		// this is exactly why activation gets weight 0.5: it nudges, never dominates.
		const scores = fuseRanks([
			{ weight: 1.0, ids: ['x1', 'x2', 'x3', 'x4', 'A'] },
			{ weight: 0.5, ids: ['B'] },
		]);
		expect(scores.get('A')!).toBeGreaterThan(scores.get('B')!);
	});

	it('returns an empty map for no lists', () => {
		expect(fuseRanks([]).size).toBe(0);
	});

	it('works with numeric ids (entity rowids)', () => {
		const scores = fuseRanks([{ weight: 1, ids: [42, 7] }]);
		// rank 0 → 1/61; rank 1 → 1/62.
		expect(scores.get(42)!).toBeGreaterThan(scores.get(7)!);
	});
});

describe('toFtsQuery', () => {
	it('quotes each token so FTS5 operators are matched literally', () => {
		// AND / trailing * are FTS5 syntax; quoting neutralizes them.
		expect(toFtsQuery('hook AND memory*')).toBe('"hook" "AND" "memory*"');
	});

	it('doubles embedded double-quotes (FTS5 escape convention)', () => {
		expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""');
	});

	it('collapses arbitrary whitespace between tokens', () => {
		expect(toFtsQuery('  vector \t search \n')).toBe('"vector" "search"');
	});

	it('empty or whitespace-only input yields the no-match empty phrase', () => {
		expect(toFtsQuery('')).toBe('""');
		expect(toFtsQuery('   ')).toBe('""');
	});
});

describe('activationScore', () => {
	const NOW = Date.parse('2026-07-02T00:00:00.000Z');

	it('more accesses at equal recency scores higher', () => {
		// Hand derivation: ln(1+10) − 0.5·ln(1+24) vs ln(1+2) − 0.5·ln(1+24) —
		// identical decay term, larger count term wins.
		const t = '2026-07-01T00:00:00.000Z'; // 24h before NOW
		expect(activationScore(10, t, NOW)).toBeGreaterThan(activationScore(2, t, NOW));
	});

	it('more recent access at equal count scores higher', () => {
		expect(
			activationScore(3, '2026-07-01T23:00:00.000Z', NOW) // 1h ago
		).toBeGreaterThan(
			activationScore(3, '2026-06-02T00:00:00.000Z', NOW) // 30 days ago
		);
	});

	it('never-accessed entities rank below any accessed entity', () => {
		expect(activationScore(0, '', NOW)).toBe(-Infinity);
		expect(activationScore(0, '2026-07-01T00:00:00.000Z', NOW)).toBe(-Infinity);
		expect(activationScore(1, '2026-01-01T00:00:00.000Z', NOW)).toBeGreaterThan(-Infinity);
	});

	it('legacy sentinel timestamp ranks last (parses as NaN)', () => {
		// Entities migrated from pre-v9 data can carry the '0000-00-00…' sentinel;
		// Date.parse yields NaN and the entity must sort with the never-accessed.
		expect(activationScore(5, '0000-00-00T00:00:00.000Z', NOW)).toBe(-Infinity);
	});

	it('a future last_accessed_at clamps to zero elapsed (clock skew guard)', () => {
		// Multi-instance deployments can have minor clock skew; elapsed time is
		// clamped at 0 so skew can't produce a positive-decay boost.
		const future = '2026-07-02T01:00:00.000Z'; // 1h AFTER NOW
		const atNow = activationScore(4, '2026-07-02T00:00:00.000Z', NOW);
		expect(activationScore(4, future, NOW)).toBeCloseTo(atNow, 10);
	});
});
