import { describe, it, expect } from 'vitest';
import { CORE_RELATION_TYPES, RELATION_TYPE_GUIDANCE } from '../relation-types.js';

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
