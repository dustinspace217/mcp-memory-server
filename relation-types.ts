// relation-types.ts
// Core causal/precedent relation vocabulary for the knowledge graph.
//
// WHY a constants module rather than just prose documentation: it gives the
// create_relations tool description, get_connected_context's relationTypes filter, and any
// future traversal code a single source of truth for the vocabulary — instead of magic
// strings scattered across files. relation_type stays free-form TEXT in the schema; these
// are RECOMMENDED conventions, NOT an enforced enum (the store accepts any relation type).
//
// Directionality is a CONVENTION the server does not enforce. It must be documented so
// every caller — the consumer is an LLM — reads and writes edges the same way. Pick the
// direction below and never invert it.

export const CORE_RELATION_TYPES = {
  // from = the effect / dependent thing, to = the cause / origin.
  // Read as: "<from> CAUSED_BY <to>"  (e.g. a rule CAUSED_BY the incident that motivated it).
  CAUSED_BY: 'CAUSED_BY',
  // from = the earlier precedent decision, to = the later decision it informs.
  PRECEDENT_FOR: 'PRECEDENT_FOR',
  // from = the newer thing, to = the older thing it replaces. Entity/decision level —
  // distinct from observation-level superseded_at (which is the supersede_observations path).
  SUPERSEDES: 'SUPERSEDES',
} as const;

/** Union of the recommended relation-type string literals. */
export type CoreRelationType = typeof CORE_RELATION_TYPES[keyof typeof CORE_RELATION_TYPES];

// Surfaced in the create_relations tool description so the calling agent orients every edge
// the same way. get_connected_context's relationTypes filter is case-insensitive, so callers
// can pass these regardless of how any older edges were cased. The final sentence is the
// load-bearing usage hint: the traversal only finds a causal link if BOTH endpoints are
// entities, so significant incidents/decisions need to be promoted to their own entity.
export const RELATION_TYPE_GUIDANCE =
  'Recommended causal/precedent relation types (relation_type is free-form; these are conventions, UPPER_SNAKE_CASE): ' +
  'CAUSED_BY (from=effect → to=cause, e.g. a rule CAUSED_BY the incident that motivated it); ' +
  'PRECEDENT_FOR (from=earlier decision → to=later decision it informs); ' +
  'SUPERSEDES (from=newer → to=older it replaces, entity/decision level). ' +
  'To make a cause traceable, promote a significant incident/decision to its own entity so it can be an edge endpoint.';

/**
 * Normalizes a relation type to its comparison key: lowercase, whitespace and
 * hyphens collapsed to single underscores. `belongs to`, `belongs-to`, and
 * `Belongs_To` all key to `belongs_to`.
 *
 * Used by createRelations' write-time canonicalization (spec §6.3): when an
 * incoming type's KEY matches the core vocabulary or exactly one existing
 * active spelling, the existing spelling is reused — stopping the same verb
 * from fragmenting into separator/case variants (the 2026-07-02 audit found
 * 128 distinct spellings across 501 edges). This is an ADVISORY, not an enum:
 * genuinely novel types are stored verbatim (DEF-CG-03's open-vocabulary
 * decision stands).
 */
export function relationTypeKey(relationType: string): string {
  // trim first (review #85): ' CAUSED_BY' would otherwise key to '_caused_by',
  // silently escaping BOTH canonicalization and get_connected_context's
  // case-insensitive relationTypes filter — an invisible causal edge.
  return relationType.trim().toLowerCase().replace(/[\s\-]+/g, '_');
}

/**
 * One-time v13 vocabulary repairs, from the 2026-07-02 live-graph audit.
 * EXPLICIT REVIEWED MAP, not an algorithm: every entry was individually
 * approved in the audit sign-off (spec §6.1). Deliberately NOT merged:
 * direction-differing verbs (`tests` vs `is tested by`) and judgment merges
 * (`imports` vs `imports_from`). Format: [drifted spelling, canonical target].
 * Consumed ONLY by the v13 migration — createRelations' canonicalization (C2)
 * uses live lookups via relationTypeKey, not this frozen list.
 */
export const RELATION_VOCAB_FIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['belongs to', 'belongs_to'],
  ['belongs-to', 'belongs_to'],
  ['contains-file', 'contains_file'],
  ['has_file', 'contains_file'], // semantic merge, audit-approved
  ['PART_OF', 'part_of'],
  ['is part of', 'part_of'],
  ['occurred in', 'occurred_in'],
  ['occurred during', 'OCCURRED_DURING'], // majority spelling in the live graph
  ['PRECEDENT_FOR robust-build procedure on', 'PRECEDENT_FOR'], // mangled causal edge
] as const);
