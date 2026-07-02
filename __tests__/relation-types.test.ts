import { describe, it, expect } from 'vitest';
import { CORE_RELATION_TYPES, RELATION_TYPE_GUIDANCE, relationTypeKey, RELATION_VOCAB_FIXES } from '../relation-types.js';

// Guards the causal/precedent vocabulary: the values are the single source of truth used by
// the create_relations description and get_connected_context's relationTypes filter, and the
// guidance string is what actually steers the LLM's edge creation. A silent drop of a type
// from the guidance (e.g. during an edit) would leave the vocab half-documented — catch it.
describe('relation-types vocabulary', () => {
	it('exposes the three core causal/precedent types as UPPER_SNAKE_CASE literals', () => {
		expect(CORE_RELATION_TYPES.CAUSED_BY).toBe('CAUSED_BY');
		expect(CORE_RELATION_TYPES.PRECEDENT_FOR).toBe('PRECEDENT_FOR');
		expect(CORE_RELATION_TYPES.SUPERSEDES).toBe('SUPERSEDES');
		expect(Object.keys(CORE_RELATION_TYPES)).toHaveLength(3);
	});

	it('guidance names every core type and states a direction', () => {
		for (const t of Object.values(CORE_RELATION_TYPES)) {
			expect(RELATION_TYPE_GUIDANCE).toContain(t);
		}
		// Mentions directionality (from=... → to=...) so callers orient edges consistently.
		expect(RELATION_TYPE_GUIDANCE).toMatch(/from=.*to=/);
	});
});

describe('relationTypeKey', () => {
	it('folds case and collapses separators to single underscores', () => {
		expect(relationTypeKey('belongs to')).toBe('belongs_to');
		expect(relationTypeKey('belongs-to')).toBe('belongs_to');
		expect(relationTypeKey('Belongs_To')).toBe('belongs_to');
		expect(relationTypeKey('CAUSED_BY')).toBe('caused_by');
		expect(relationTypeKey('is  part -- of')).toBe('is_part_of'); // runs collapse to one _
	});

	it('leaves already-canonical lowercase keys unchanged', () => {
		expect(relationTypeKey('contains_file')).toBe('contains_file');
	});
});

describe('RELATION_VOCAB_FIXES (v13 migration map)', () => {
	it('every drifted spelling keys to its target (mechanical merges) or targets core vocab (approved semantic merges)', () => {
		// The map's contract: each entry is either a pure case/separator variant
		// of its target (same relationTypeKey) or one of the three audit-approved
		// exceptions (a semantic merge, a filler-word drop, a mangled-suffix repair).
		const semanticExceptions = new Set(['has_file', 'is part of', 'PRECEDENT_FOR robust-build procedure on']);
		for (const [drifted, target] of RELATION_VOCAB_FIXES) {
			if (semanticExceptions.has(drifted)) continue;
			expect(relationTypeKey(drifted), `${drifted} → ${target}`).toBe(relationTypeKey(target));
		}
	});

	it('never maps a target to another entry (no chains)', () => {
		// A chained map (a→b, b→c) would make the migration order-dependent.
		const drifted = new Set(RELATION_VOCAB_FIXES.map(([d]) => d));
		for (const [, target] of RELATION_VOCAB_FIXES) {
			expect(drifted.has(target), `target ${target} must not itself be a drifted key`).toBe(false);
		}
	});
});
