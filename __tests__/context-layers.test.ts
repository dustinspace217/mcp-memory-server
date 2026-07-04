// Unit tests for context-layers.ts — the shared two-tier L1 logic (v16).
// Pure functions, no DB, no model: Pool 1 (same rationale as rank-fusion.ts's
// tests). These pin the module-level rules the store-level behavioral tests
// can't isolate cheaply: the exact hint cap, the join format, the
// first-entry-always rule, and indexCharCost's contract with the budget —
// a QA mutation experiment (2026-07-03) showed cap/cost regressions passed
// the whole behavioral suite unnoticed.
import { describe, it, expect } from 'vitest';
import { buildL1Index, indexCharCost, L1_INDEX_CHAR_BUDGET, type UnfeaturedL1 } from '../context-layers.js';

function obs(entityName: string, content: string, summary: string | null = null, entityType = 't'): UnfeaturedL1 {
	return { entityName, entityType, content, summary };
}

describe('buildL1Index', () => {
	it('returns [] for empty input (callers omit the field on [])', () => {
		expect(buildL1Index([])).toEqual([]);
	});

	it('groups by entity in first-seen order with per-entity counts', () => {
		const entries = buildL1Index([
			obs('EntA', 'alpha one'),
			obs('EntB', 'beta one'),
			obs('EntA', 'alpha two'),
		]);
		expect(entries.map(e => e.entityName)).toEqual(['EntA', 'EntB']);
		expect(entries[0].observationCount).toBe(2);
		expect(entries[1].observationCount).toBe(1);
		expect(entries[0].entityType).toBe('t');
	});

	it('hint uses summary when set, first-100-chars + ellipsis when not, verbatim when short', () => {
		const long = 'L'.repeat(150);
		const entries = buildL1Index([
			obs('EntSummary', long, 'explicit hint'),
			obs('EntLong', long),
			obs('EntShort', 'short content'),
		]);
		expect(entries[0].hint).toBe('explicit hint');
		expect(entries[1].hint).toBe('L'.repeat(100) + '...');
		expect(entries[2].hint).toBe('short content'); // no ellipsis when nothing was cut
	});

	it('joins multi-observation hints with ", " and caps the combined hint at 200 chars + ellipsis', () => {
		// Three 90-char summaries join to 274 chars -> capped at exactly 200 + '...'.
		// A QA mutation probe set the cap to Infinity and nothing failed; this does.
		const s = (c: string) => c.repeat(90);
		const entries = buildL1Index([
			obs('EntMulti', 'x', s('a')),
			obs('EntMulti', 'x2', s('b')),
			obs('EntMulti', 'x3', s('c')),
		]);
		expect(entries[0].hint.length).toBe(203);
		expect(entries[0].hint.startsWith(s('a') + ', ' + s('b'))).toBe(true);
		expect(entries[0].hint.endsWith('...')).toBe(true);
		// A hint of exactly 200 chars is NOT truncated (boundary is exclusive).
		const exact = buildL1Index([obs('EntExact', 'x', 'e'.repeat(200))]);
		expect(exact[0].hint).toBe('e'.repeat(200));
	});

	it('budgets on serialized entry cost, drops from the tail, and always keeps the first entry', () => {
		// ~40 entities with ~103-char hints (~190 serialized chars each) far
		// exceed the 4000-char budget; survivors must be the leading prefix.
		const many: UnfeaturedL1[] = [];
		for (let i = 0; i < 40; i++) {
			many.push(obs(`Ent${String(i).padStart(2, '0')}`, 'c'.repeat(150)));
		}
		const entries = buildL1Index(many);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.length).toBeLessThan(40);
		expect(indexCharCost(entries)).toBeLessThanOrEqual(L1_INDEX_CHAR_BUDGET);
		entries.forEach((e, i) => expect(e.entityName).toBe(`Ent${String(i).padStart(2, '0')}`));

		// First-entry-always: a single entry over the whole budget is kept
		// (over-budget beats an empty index that reads as "nothing truncated").
		// Its 200-capped hint can't alone exceed 4000, so blow the budget with
		// the entityName instead.
		const oversized = buildL1Index([obs('N'.repeat(4200), 'content')]);
		expect(oversized).toHaveLength(1);
	});
});

describe('indexCharCost', () => {
	it('is the summed serialized length — the exact term tokenEstimate carries', () => {
		const entries = buildL1Index([obs('EntA', 'alpha'), obs('EntB', 'beta')]);
		const expected = entries.reduce((s, e) => s + JSON.stringify(e).length, 0);
		expect(indexCharCost(entries)).toBe(expected);
		expect(indexCharCost(entries)).toBeGreaterThan(0);
		expect(indexCharCost([])).toBe(0);
	});
});
