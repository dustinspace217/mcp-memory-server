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
