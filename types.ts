// types.ts -- Shared interfaces and types for the knowledge graph.
// SqliteStore (the sole live backend since v1.6.0) and the jsonl-reader migration
// parser both depend on these types.

/**
 * A single piece of knowledge attached to an entity.
 * Each observation carries a creation timestamp for staleness detection.
 * createdAt is ISO 8601 UTC, or 'unknown' for data migrated from the old string format.
 *
 * importance: 1.0-5.0 score controlling how prominently this observation surfaces
 *   in summaries and context layers. Default 3.0 (medium). 5.0 = critical, 1.0 = low.
 * contextLayer: determines when this observation is loaded:
 *   null = L2 (on-demand, only via search/readGraph — the default for all data)
 *   'L0' = always loaded (~100 token budget, core identity and rules)
 *   'L1' = loaded at session start (~4000 token budget, active work and decisions)
 * memoryType: free-form tag classifying the nature of the observation.
 *   null = unclassified. Recommended values: 'decision', 'preference', 'fact',
 *   'problem', 'milestone', 'emotional'. Enables type-filtered queries.
 */
export interface Observation {
  content: string;
  createdAt: string;
  importance: number;           // 1.0-5.0, default 3.0
  contextLayer: string | null;  // null = L2 (on-demand), 'L0' = always loaded, 'L1' = session start
  memoryType: string | null;    // null = unclassified
  sourceInstance: string;        // which Claude instance created this observation (from MEMORY_INSTANCE_NAME env var)
  /** VALID TIME (v14, bi-temporal-lite — Phase F): when the fact was true IN THE
   *  WORLD, distinct from createdAt/supersededAt (when the DATABASE learned or
   *  retired it). Caller-supplied ISO 8601 UTC; absent = unspecified. Set via
   *  set_observation_metadata (add_observations keeps its string-array shape).
   *  No query filtering yet — display/record only (DEF-RR-01). */
  validFrom?: string;
  validUntil?: string;
  /** L1-index hint override (v16, ≤200 chars). Consumed only by
   *  getContextLayers when building L1Index breadcrumbs; absent/null = the
   *  first-100-chars auto-fallback. Set via set_observation_metadata. */
  summary?: string | null;
  /** PROVENANCE (v1.7.0, ≤200 chars): WHERE this observation came from — a
   *  session id, transcript path, URL, or doc reference. Caller-supplied,
   *  stored verbatim, record-only (no query filtering). '' sentinel in storage
   *  = unset → field ABSENT in output (same optional-field convention as
   *  valid-time). Set on create_entities / add_observations / supersede_observations. */
  sourceRef?: string;
}

/**
 * Sentinel value for entity timestamps on legacy data that predates Phase 4.
 * Sorts last in DESC ordering (lexicographically before any real ISO 8601 timestamp).
 * Chosen over empty string to be self-documenting and avoid semantic collision.
 */
export const ENTITY_TIMESTAMP_SENTINEL = '0000-00-00T00:00:00.000Z';

/** A named node in the knowledge graph with a type and attached observations.
 *  project scopes the entity to a specific project (null = global, never undefined). */
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
  project: string | null;  // null = global, never undefined
  updatedAt: string;       // ISO 8601 UTC, or ENTITY_TIMESTAMP_SENTINEL for legacy data
  createdAt: string;       // ISO 8601 UTC, or ENTITY_TIMESTAMP_SENTINEL for legacy data
}

/** Input type for creating/deleting relations — the triple plus optional VALID
 * TIME (when the relationship was true in the world; system temporal fields
 * stay system-managed). Used by createRelations() and deleteRelations() callers
 * (deleteRelations ignores the valid-time fields — matching is by triple). */
export interface RelationInput {
  from: string;
  to: string;
  relationType: string;
  validFrom?: string;   // ISO 8601 UTC; absent = unspecified (v14)
  validUntil?: string;  // ISO 8601 UTC; absent = unspecified (v14)
}

/** Full relation as returned by queries — includes temporal tracking fields.
 * createdAt: ISO 8601 UTC when the relation was established (sentinel for legacy).
 * supersededAt: '' = active, ISO timestamp = invalidated.
 * validFrom/validUntil: VALID TIME (v14) — present only when the caller set them. */
export interface Relation {
  from: string;
  to: string;
  relationType: string;
  createdAt: string;
  supersededAt: string;
  validFrom?: string;
  validUntil?: string;
}

/** Input for invalidate_relations — identifies relations to retire. */
export interface InvalidateRelationInput {
  from: string;
  to: string;
  relationType: string;
}

/** Observation entry in an entity timeline — includes superseded observations. */
export interface TimelineObservation {
  content: string;
  createdAt: string;
  supersededAt: string;
  sourceInstance: string;
  /** 'active' = current, 'superseded' = retired by newer version, 'tombstoned' = content stripped by eviction. */
  status: 'active' | 'superseded' | 'tombstoned';
  /** Valid time (v14) — present only when set. The timeline is exactly where
   *  transaction time and valid time diverge visibly: createdAt/supersededAt
   *  say when the DB learned/retired the fact; these say when it was true. */
  validFrom?: string;
  validUntil?: string;
  /** Provenance (v1.7.0) — present only when set ('' sentinel = absent). */
  sourceRef?: string;
}

/** Relation entry in an entity timeline — includes invalidated relations. */
export interface TimelineRelation {
  from: string;
  to: string;
  relationType: string;
  createdAt: string;
  supersededAt: string;
  /** Valid time (v14) — present only when set. An invalidated relation's valid
   *  window is only naturally visible HERE (active reads exclude it). */
  validFrom?: string;
  validUntil?: string;
  /** 'active' = current, 'superseded' = retired, 'tombstoned' = stripped by eviction. */
  status: 'active' | 'superseded' | 'tombstoned';
}

/** Full timeline response for a single entity. */
export interface EntityTimelineResult {
  name: string;
  entityType: string;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  observations: TimelineObservation[];
  relations: TimelineRelation[];
}

/** The complete knowledge graph: all entities and all relations. */
export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

/** A node reached during graph traversal. Lightweight STRUCTURE only — no observations.
 *  Fetch full content for the nodes that matter via openNodes; keeping the traversal
 *  result structure-only is what lets it go deep/broad without blowing the context budget. */
export interface ConnectedNode {
  name: string;          // canonical display name
  entityType: string;
  hopDistance: number;   // shortest number of edges from the seed (>= 1)
  path: string[];        // shortest path of display names from the seed to this node (both ends inclusive)
}

/** Options for getConnectedContext traversal. All optional; defaults applied in the store. */
export interface ConnectedContextOptions {
  maxHops?: number;                    // edges to walk outward (default 3)
  direction?: 'out' | 'in' | 'both';   // which edge directions to follow (default 'both')
  relationTypes?: string[];            // restrict the walk to these relation types (default: all)
  projectId?: string;                  // scope reached nodes to this project + global (default: all)
  asOf?: string;                       // point-in-time: walk the graph as it was at this ISO 8601 UTC timestamp
  maxNodes?: number;                   // cap on returned nodes (default 50); sets truncated=true when exceeded
}

/** Result of getConnectedContext: the structurally-connected neighborhood of a seed entity. */
export interface ConnectedContextResult {
  seed: string;             // the seed's display name (or the raw input if it matched no entity)
  nodes: ConnectedNode[];   // reached nodes (excludes the seed itself), nearest-hop first
  relations: Relation[];    // active edges among the seed + reached nodes
  cycles: string[][];       // directed cycles detected among the returned edges (each = display
                            //   names round the loop, entry node repeated to close); [] = acyclic.
                            //   Flags circular logic mechanically rather than leaving it to be spotted.
  truncated: boolean;       // true if more nodes were reachable than the maxNodes cap returned
}

/** A precedent returned by findPrecedents: an observation ranked by semantic similarity to a query. */
export interface PrecedentMatch {
  entityName: string;          // the entity the observation belongs to (display name)
  observationId: string;       // the observation's row id (stringified)
  content: string;
  similarity: number;          // cosine similarity to the query, 0..1
  importance: number;
  memoryType: string | null;
  contextLayer: string | null; // L0 / L1 / null (on-demand) — raw value, no L2-render coupling
  createdAt: string;
}

/** Options for findPrecedents. */
export interface FindPrecedentsOptions {
  memoryType?: string;     // restrict to observations of this memory_type (e.g. 'decision')
  limit?: number;          // max precedents to return (default 5)
  minSimilarity?: number;  // cosine floor (default 0.25 — lower than dedup; precedents are related, not duplicate)
  /** Graph-aware rerank (Phase E, default false): fuse the cosine ranking with
   *  personalized-PageRank-over-relations (seeded by the matches' parent
   *  entities) and an observation-level BM25 list. Reorders WITHIN the
   *  floor-gated candidate set only — fusion never resurrects a below-floor
   *  match, and `similarity` values remain raw cosines (fusion reorders, it
   *  does not fabricate similarity numbers). Default stays false until the
   *  offline blind gate passes (plan DEF-RR-02). */
  rerank?: boolean;
}

/** Result of findPrecedents. The flags tell the caller WHY precedents is empty when it is. */
export interface FindPrecedentsResult {
  precedents: PrecedentMatch[];
  modelReady: boolean;          // embedding model loaded?
  vectorSearchEnabled: boolean; // vec table present (MEMORY_VECTOR_SEARCH !== 'off')?
  /** Present (true) only when opts.rerank was requested AND the graph-aware
   *  fusion actually ran over at least one floor-gated candidate. Absent when
   *  rerank was off, on the degraded path, and on EVERY empty result (nothing
   *  fused) — so the caller can distinguish "reranked order" from "pure cosine
   *  order", and empty results read uniformly. */
  rerankApplied?: boolean;
}

/** PROSPECTIVE MEMORY (v1.7.0) — a stored "when situation X arises, remember Y"
 *  intent. The brain's prospective memory has no analog in the retrospective
 *  (search-on-demand) surfaces; this is the only condition-fired recall path.
 *  One-shot: firing stamps firedAt and retires the trigger from matching. */
export interface ProspectiveTrigger {
  id: number;
  triggerText: string;   // the CONDITION to match context against (semantically)
  payload: string;       // what to surface when the condition fires
  project: string | null; // null = global (visible to all project scopes)
  createdAt: string;      // ISO 8601 UTC
  firedAt: string;        // '' = pending, ISO 8601 UTC = fired (one-shot)
}

/** A trigger returned by checkProspectiveTriggers — a ProspectiveTrigger that
 *  matched the current context, plus its raw-cosine similarity (rounded for
 *  display, like precedents). At return time its firedAt is already stamped. */
export interface FiredTrigger extends ProspectiveTrigger {
  similarity: number;   // cosine of triggerText vs. the checked context, 0..1
}

/** Result of checkProspectiveTriggers. Degrades to { fired: [], vectorSearchEnabled:
 *  false } when the model/vec table is unavailable — NO fallback matching (same
 *  honesty rule as findPrecedents: an empty result never hides a degraded run). */
export interface CheckProspectiveTriggersResult {
  fired: FiredTrigger[];
  vectorSearchEnabled: boolean;
}

/** Pagination parameters for readGraph and searchNodes.
 *  cursor is an opaque base64-encoded string from a previous PaginatedKnowledgeGraph response.
 *  limit controls page size (1-100, default 40 in the implementation). */
export interface PaginationParams {
  cursor?: string;   // Opaque base64-encoded cursor from a previous response
  limit?: number;    // 1-100, default 40
}

/**
 * Paginated knowledge graph result.
 * Extends KnowledgeGraph with cursor metadata for fetching subsequent pages.
 * Code that only needs { entities, relations } continues to work unchanged
 * because this is a superset of KnowledgeGraph.
 */
export interface PaginatedKnowledgeGraph extends KnowledgeGraph {
  nextCursor: string | null;  // null = no more pages
  totalCount: number;         // Total matching entities (may vary between pages if data mutates)
  /** Present (non-empty) only when orderBy:'relevance' ran but one of its candidate
   *  lists was LOST to an error or transient unavailability — 'fts' when the BM25
   *  query failed, 'vector' when the KNN list failed or the embedding model was
   *  still loading / had failed. Degradation changes result MEMBERSHIP (FTS-only
   *  diacritic matches and vector-only semantic matches exist in no other list),
   *  so per goal A it must surface to the caller, not just stderr. Deliberately
   *  NOT set when vector search is configured off (MEMORY_VECTOR_SEARCH=off):
   *  that is chosen configuration, not degradation, and flagging it would train
   *  callers to ignore the flag. Same convention family as
   *  vectorSearchEnabled / modelReady. */
  rankingDegraded?: ('fts' | 'vector')[];
}

/** Result ordering for searchNodes. 'recency' (default) = updated_at DESC with
 *  keyset pagination — the historical behavior, stable for hooks that page.
 *  'relevance' = weighted rank fusion of the LIKE / FTS(BM25) / vector candidate
 *  lists, top-k only (no cursor; rank is query-relative and mutation-unstable,
 *  so a keyset cursor over it would silently skip/duplicate). */
export type SearchOrderBy = 'recency' | 'relevance';

/**
 * Thrown when an opaque cursor string cannot be decoded or is structurally invalid.
 * Also thrown when a cursor from one query context is used with a different query.
 * This is a class (not an interface) so it can be thrown and caught with instanceof.
 */
export class InvalidCursorError extends Error {
  /** @param message - Human-readable reason the cursor was rejected (e.g.,
   *  "Cursor has invalid structure", "Cursor does not match current query").
   *  Surfaces in McpError responses so the client knows what went wrong. */
  constructor(message: string) {
    super(message);
    // Explicitly set the name so stack traces show "InvalidCursorError" instead of "Error"
    this.name = 'InvalidCursorError';
  }
}

// --- Named input/output types for GraphStore methods ---

/** Input type for createEntities. Observations can be plain strings (auto-timestamped)
 *  or Observation objects (passed through for migration/test scenarios). */
export type EntityInput = {
  name: string;
  entityType: string;
  observations: (string | Observation)[];
};

/** Input type for addObservations. Each entry targets an entity by name.
 *  importances, contextLayers, and memoryTypes are parallel arrays matching contents.
 *  When omitted or shorter than contents, remaining observations get defaults
 *  (importance: 3.0, contextLayer: null, memoryType: null). */
export type AddObservationInput = {
  entityName: string;
  contents: string[];
  importances?: number[];              // parallel array, optional, default 3.0 per observation
  contextLayers?: (string | null)[];   // parallel array, optional, default null (L2) per observation
  memoryTypes?: (string | null)[];     // parallel array, optional, default null (unclassified) per observation
};

/** Input type for deleteObservations. Field is 'contents' (not 'observations')
 *  to be consistent with AddObservationInput. */
export type DeleteObservationInput = {
  entityName: string;
  contents: string[];
};

/** Returned when a newly added observation is semantically similar to an existing one.
 *  Allows callers to decide whether to supersede, keep both, or investigate. */
export interface SimilarObservation {
  content: string;
  similarity: number;  // cosine similarity, 0.0-1.0 (higher = more similar)
}

/** Return type for addObservations. Reports which observations were actually added
 *  (excludes duplicates). similarExisting is present when the embedding model is
 *  ready and found near-matches (cosine > 0.85) for newly added observations.
 *  similarityCheckFailed is true when the similarity check encountered an error
 *  (database corruption, embedding failure, etc.) — absence of similarExisting
 *  may mean "no similar observations" OR "check couldn't run." */
export type AddObservationResult = {
  entityName: string;
  addedObservations: Observation[];
  similarExisting?: SimilarObservation[];
  /** True when the similarity check hit an error. When set, the absence of
   *  similarExisting is NOT evidence that no duplicates exist. */
  similarityCheckFailed?: boolean;
};

/** Input for pre-write duplicate checking. Identifies a candidate observation
 *  by entity name and content — the caller wants to know if something similar
 *  already exists before committing it. */
export interface CheckDuplicateInput {
  entityName: string;
  content: string;
}

/** A single match found by the pre-write duplicate checker. Contains the
 *  existing observation content, its cosine similarity to the candidate,
 *  and when it was created (to help the caller decide freshness). */
export interface DuplicateMatch {
  content: string;
  similarity: number;  // cosine similarity 0.0-1.0
  createdAt: string;
}

/** Result for one candidate observation in a check_duplicates request.
 *  matches is empty when no similar observations were found. */
export interface CheckDuplicateResult {
  entityName: string;
  candidateContent: string;
  matches: DuplicateMatch[];
}

/** Full response from checkDuplicates. modelReady is false when the
 *  embedding pipeline isn't available (vector search off, or model failed to load)
 *  — results will have empty matches in that case. When errorCount > 0,
 *  some candidates failed (database corruption, embedding failure, etc.)
 *  and their results have empty matches even though duplicates may exist. */
export interface CheckDuplicatesResponse {
  results: CheckDuplicateResult[];
  modelReady: boolean;
  /** Number of candidates that hit errors during the check. 0 = all candidates
   *  were checked successfully. When errorCount === results.length, treat the
   *  entire response as unreliable (equivalent to modelReady: false). */
  errorCount: number;
}

/** An entity that was skipped during createEntities because its name
 *  already exists (possibly in a different project, or under a different
 *  surface form that normalizes to the same identity key). */
export type SkippedEntity = {
  /** The display name as supplied by the caller. */
  name: string;
  /** The owning project of the existing entity (null = global). */
  existingProject: string | null;
  /**
   * The display name of the existing entity that the input collided with.
   * Will equal `name` for exact-match collisions. Differs when the input
   * was a surface variant (e.g. 'Dustin-Space') and the existing entity
   * is stored under a different display form (e.g. 'dustin-space').
   * Optional so callers built against older versions still work.
   */
  existingName?: string;
};

/** Return type for createEntities. Reports both created entities and
 *  skipped duplicates with their owning project for collision feedback. */
export type CreateEntitiesResult = {
  created: Entity[];
  skipped: SkippedEntity[];
};

/** Input for set_observation_metadata tool: update importance, context layer, and/or
 *  memory type on an existing active observation without superseding it.
 *  The observation is identified by (entityName, content) — content is the exact match.
 *  At least one of importance, contextLayer, or memoryType should be provided. */
export interface SetObservationMetadataInput {
  entityName: string;
  content: string;              // identifies the target observation by exact match
  importance?: number;          // 1.0-5.0; only updated if provided
  contextLayer?: string | null; // 'L0', 'L1', or null (demote to L2); only updated if key is present
  memoryType?: string | null;   // free-form tag or null (unclassified); only updated if key is present
  validFrom?: string | null;    // VALID TIME start (v14); ISO string sets, null clears; only updated if key is present
  validUntil?: string | null;   // VALID TIME end (v14); ISO string sets, null clears; only updated if key is present
  summary?: string | null;      // manual L1-index hint override (v16, ≤200 chars); null clears back to the first-100-chars auto-fallback; only updated if key is present
}

/** A single observation in a context layer response. L0 observations omit updatedAt
 *  (they're identity/rules, timestamps aren't relevant). L1 observations include it
 *  so the caller can gauge freshness. */
export interface ContextLayerObservation {
  entityName: string;
  content: string;
  importance: number;
  memoryType: string | null;
  sourceInstance: string;
  updatedAt?: string;   // present on L1, omitted on L0
}

/** One entry in the L1 index tier (v16, spec §13): a per-ENTITY breadcrumb for
 *  L1 observations that didn't fit the featured budget. Entity-level (not
 *  per-observation) because entity names are often self-describing and
 *  per-observation entries would be 3-5x the size for marginal gain. */
export interface L1IndexEntry {
  entityName: string;
  entityType: string;
  /** Number of L1 observations on this entity that were NOT featured. */
  observationCount: number;
  /** Compact hint: each unfeatured observation's summary (or its first 100
   *  chars), comma-joined, truncated to 200 chars total. Enough to decide
   *  whether to open_nodes the entity. */
  hint: string;
}

/** Return type for getContextLayers(). Observations grouped by layer,
 *  with a rough token estimate (chars / 4) so hooks can budget.
 *  L0 and L1 arrays are sorted by importance DESC within each layer.
 *
 *  Two-tier L1 (v16): L1 is the FEATURED tier (full text, ~12000-char budget);
 *  L1Index carries breadcrumbs for every L1 observation that didn't fit
 *  (~4000-char budget, lowest-importance entities dropped on overflow).
 *  L1Index is present only when at least one L1 observation was unfeatured —
 *  its absence means L1 is complete, which is what pre-v16 consumers assume. */
export interface ContextLayersResult {
  L0: ContextLayerObservation[];
  L1: ContextLayerObservation[];
  L1Index?: L1IndexEntry[];
  tokenEstimate: number;
}

/** A single observation in a summary response. Includes entityName, memoryType,
 *  and updatedAt for context. */
export interface SummaryObservation {
  entityName: string;
  content: string;
  importance: number;
  memoryType: string | null;
  sourceInstance: string;
  updatedAt: string;
}

/** A recently-updated entity in a summary response. Includes observation count
 *  so the caller can gauge entity richness. */
export interface SummaryEntity {
  name: string;
  entityType: string;
  observationCount: number;
  updatedAt: string;
}

/** Aggregate stats for the knowledge graph. */
export interface SummaryStats {
  totalEntities: number;
  totalObservations: number;
  totalRelations: number;
  projectCount: number;
}

/** Return type for getSummary(). Provides an overview snapshot designed
 *  for session-start briefings: top observations by importance, recently
 *  updated entities, and aggregate stats. */
export interface SummaryResult {
  topObservations: SummaryObservation[];
  recentEntities: SummaryEntity[];
  stats: SummaryStats;
}

/** Input for supersede_observations tool: replace one observation with another on an entity. */
export interface SupersedeInput {
  entityName: string;
  oldContent: string;
  newContent: string;
}

/**
 * The GraphStore interface -- the storage contract SqliteStore implements (the
 * sole live backend since the v1.6.0 JSONL retirement). Kept as an interface so
 * the store stays swappable in tests and so a future backend has a contract to
 * meet. Methods mirror the MCP tool operations. Return types use Readonly to
 * prevent accidental mutation of returned data.
 */
export interface GraphStore {
  /** One-time setup: create tables, run migrations, etc. */
  init(): Promise<void>;

  /** Cleanup: close DB connection. */
  close(): Promise<void>;

  /** Signals the store to stop background work (e.g., embedding sweep) and
   *  prepare for shutdown. Call before close(). No-op for backends without
   *  background tasks. */
  shutdown(): void;

  /** Creates new entities. Skips entities whose names already exist (UNIQUE constraint)
   *  and reports them as skipped with their owning project for collision feedback.
   *  @param entities - Array of EntityInput objects. Observations can be plain strings
   *                    (auto-timestamped) or Observation objects.
   *  @param projectId - Optional project scope. Omit or pass undefined for global scope.
   *  @param sourceRef - Optional provenance pointer (v1.7.0) stamped on every seeded
   *                     observation (≤200 chars; where the fact came from). */
  createEntities(entities: EntityInput[], projectId?: string, sourceRef?: string): Promise<Readonly<CreateEntitiesResult>>;
  /** Creates new relations between existing entities. Deduplicates by composite key
   *  [from, to, relationType]. In SQLite, FK constraints enforce both endpoints exist.
   *  @param relations - Array of RelationInput (3-field). Temporal fields are system-assigned.
   *  @returns Only the relations actually created, as full Relation objects with temporal fields */
  createRelations(relations: RelationInput[]): Promise<Readonly<Relation[]>>;
  /** Adds observations to existing entities. Deduplicates by content string.
   *  Throws if any entityName does not match an existing entity.
   *  @param observations - Array of { entityName, contents: string[] }
   *  @param sourceRef - Optional provenance pointer (v1.7.0) stamped on every added
   *                     observation in this call (≤200 chars).
   *  @returns Per-entity results with added observations and optional similarExisting warnings */
  addObservations(observations: AddObservationInput[], sourceRef?: string): Promise<Readonly<AddObservationResult[]>>;
  /** Deletes entities by name and cascade-deletes their observations and relations.
   *  Idempotent — silently ignores names that don't match any entity. */
  deleteEntities(entityNames: string[]): Promise<void>;
  /** Deletes specific observations by content string from the named entities.
   *  Idempotent — silently ignores non-existent entities or observations. */
  deleteObservations(deletions: DeleteObservationInput[]): Promise<void>;
  /** Deletes relations by exact match on all three fields (from, to, relationType).
   *  Idempotent — silently ignores non-existent relations. */
  deleteRelations(relations: RelationInput[]): Promise<void>;
  /** Atomically retires old observations and inserts replacements in a single transaction.
   *  @param supersessions - Array of { entityName, oldContent, newContent }
   *  @param sourceRef - Optional provenance pointer (v1.7.0) stamped on each replacement row.
   *  @throws Error if entity or active observation not found */
  supersedeObservations(supersessions: SupersedeInput[], sourceRef?: string): Promise<void>;
  /** Invalidates relations by setting superseded_at to current timestamp.
   * Idempotent — ignores already-invalidated relations.
   * Returns the number of relations actually invalidated (0 if all were already inactive). */
  invalidateRelations(relations: InvalidateRelationInput[]): Promise<number>;
  /** Returns the knowledge graph, optionally filtered by project, with cursor-based pagination.
   *  Entities are sorted by most recently updated first. Relations are included only when
   *  both endpoints appear in the result set.
   *  @param projectId - Optional project scope. When set, includes project + global entities.
   *  @param pagination - Optional cursor and limit. Omit for all results (backward compat).
   *  @param asOf - Optional ISO 8601 UTC timestamp for point-in-time queries. When set,
   *    returns only observations/relations that were active at that moment. */
  readGraph(projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<Readonly<PaginatedKnowledgeGraph>>;
  /** Searches for entities matching a case-insensitive substring query against name,
   *  entityType, or observation content. Augmented with vector similarity search when
   *  the embedding model is ready (SQLite only). Results paginated by recency.
   *  @param query - Case-insensitive substring to search for
   *  @param projectId - Optional project scope
   *  @param pagination - Optional cursor and limit
   *  @param asOf - Optional ISO 8601 UTC timestamp for point-in-time queries
   *  @param memoryType - Optional filter: only return entities with at least one observation of this type (e.g., 'procedure', 'decision')
   *  @param orderBy - 'recency' (default, historical behavior) or 'relevance' (RRF over
   *    LIKE/FTS/vector lists, top-k, no cursor). Incompatible with cursor and asOf — throws. */
  searchNodes(query: string, projectId?: string, pagination?: PaginationParams, asOf?: string, memoryType?: string, orderBy?: SearchOrderBy): Promise<Readonly<PaginatedKnowledgeGraph>>;
  /** Retrieves specific entities by exact name match plus connected relations.
   *  Non-existent names are silently skipped. Use this instead of readGraph when you
   *  need full relation context for a known set of entities.
   *  @param asOf - Optional ISO 8601 UTC timestamp for point-in-time queries */
  openNodes(names: string[], projectId?: string, asOf?: string): Promise<Readonly<KnowledgeGraph>>;
  /** Walks the relation graph outward from a seed entity up to maxHops, returning the
   *  structurally-connected neighborhood (lightweight nodes + the active edges among them).
   *  Surfaces INDIRECT facts that semantic/recency search misses because they aren't
   *  textually similar to the seed (e.g. a sanction two hops from a loan applicant).
   *  Cycle-safe; nearest hop wins.
   *  @param seedEntity - entity to traverse from (any surface form)
   *  @param opts - traversal options (maxHops, direction, relationTypes, projectId, asOf, maxNodes) */
  getConnectedContext(seedEntity: string, opts?: ConnectedContextOptions): Promise<Readonly<ConnectedContextResult>>;
  /** Retrieves observations RANKED by semantic (cosine) similarity to `query` — the most similar
   *  PRIOR decisions/situations, which search_nodes (recency) and get_connected_context (structure)
   *  can't surface. Degrades to empty + flags when the model/vectors are unavailable; never silently
   *  recency-falls-back.
   *  @param query - situation/scenario to find precedents for
   *  @param projectId - optional scope (project + global); pre-normalized by the caller
   *  @param opts - memoryType filter, limit (default 5), minSimilarity floor (default 0.25) */
  findPrecedents(query: string, projectId?: string, opts?: FindPrecedentsOptions): Promise<Readonly<FindPrecedentsResult>>;
  /** Lists all distinct project names that have at least one entity.
   *  Global entities (project === null) are excluded. */
  listProjects(): Promise<string[]>;
  /** Returns full timeline for an entity (all observations and relations, active + superseded). */
  entityTimeline(entityName: string, projectId?: string): Promise<EntityTimelineResult | null>;
  /** Returns a concise summary snapshot: top observations by importance, recently updated
   *  entities, and aggregate stats. Designed for session-start briefings.
   *  @param projectId - Optional project scope. When set, includes project + global entities.
   *  @param excludeContextLayers - When true, excludes L0/L1 observations (for dedup with getContextLayers).
   *  @param limit - Max top observations to return (default 20).
   *  @param memoryType - Optional filter for topObservations and recentEntities. Stats remain unfiltered.
   *  @returns SummaryResult with topObservations, recentEntities, and stats */
  getSummary(projectId?: string, excludeContextLayers?: boolean, limit?: number, memoryType?: string): Promise<Readonly<SummaryResult>>;
  /** Returns L0 and L1 observations for a project, sorted by layer then importance DESC.
   *  Enforces soft token budgets (~100 tokens for L0, ~800 for L1). When observations
   *  exceed the budget, the response is truncated to the most important ones.
   *  @param projectId - Optional project scope. When set, includes project + global entities.
   *  @param layers - Which layers to return. Defaults to ['L0', 'L1'].
   *  @returns ContextLayersResult with L0 and L1 arrays plus tokenEstimate */
  getContextLayers(projectId?: string, layers?: string[]): Promise<Readonly<ContextLayersResult>>;
  /** Updates metadata (importance, contextLayer, memoryType) on existing active observations
   *  in-place. Does not change content, timestamps, or embeddings. Throws if entity not found.
   *  Idempotent — returns 0 if the observation content isn't found (not an error).
   *  @param updates - Array of SetObservationMetadataInput identifying observations and new metadata
   *  @returns Number of observations actually updated */
  setObservationMetadata(updates: SetObservationMetadataInput[]): Promise<number>;
  /** Pre-write duplicate check. Embeds candidate observations and queries for
   *  semantically similar existing observations (cosine > 0.80) on the same entity.
   *  Does NOT write anything — the caller decides what to do with the results.
   *  Returns modelReady: false with empty matches when vector search is unavailable.
   *  @param candidates - Array of { entityName, content } to check
   *  @returns Per-candidate matches plus a modelReady flag */
  checkDuplicates(candidates: CheckDuplicateInput[]): Promise<CheckDuplicatesResponse>;

  // --- Prospective memory (v1.7.0) ---

  /** Stores a "when situation X arises, remember Y" trigger and embeds its
   *  triggerText for later semantic matching. Fire-and-forget embedding (the
   *  background sweep catches it if the model isn't ready yet).
   *  @param triggerText - the CONDITION (matched semantically against context)
   *  @param payload - what to surface when the condition fires
   *  @param project - optional scope (null/omitted = global) */
  setProspectiveTrigger(triggerText: string, payload: string, project?: string): Promise<Readonly<ProspectiveTrigger>>;
  /** Embeds contextText once and fires every PENDING in-scope trigger whose
   *  triggerText clears `threshold` (raw cosine). Firing is atomic (stamps
   *  firedAt, drops the vec row). Degrades to { fired: [], vectorSearchEnabled:
   *  false } — never falls back to substring matching.
   *  @param contextText - the current situation to match triggers against
   *  @param project - optional scope (project + global; advisory)
   *  @param threshold - cosine floor to fire (default = resolved MEMORY_TRIGGER_THRESHOLD) */
  checkProspectiveTriggers(contextText: string, project?: string, threshold?: number): Promise<Readonly<CheckProspectiveTriggersResult>>;
  /** Lists triggers for management. Pending only by default; includeFired shows
   *  the full history. Scoped to project + global when project is given. */
  listProspectiveTriggers(project?: string, includeFired?: boolean): Promise<Readonly<ProspectiveTrigger[]>>;
  /** HARD-deletes triggers by id (and their vec rows). Idempotent — unknown ids
   *  are silently ignored. Triggers are ephemeral intent, not knowledge, so the
   *  preservation lifecycle deliberately does NOT apply (no soft-delete here).
   *  @returns the number of triggers actually deleted */
  deleteProspectiveTriggers(ids: number[]): Promise<number>;
}

/** Resolves which Claude Code instance is writing, from MEMORY_INSTANCE_NAME.
 *  Single definition for all three consumers (Issue #80 — they had drifted
 *  into three independent copies). Read PER CALL (not cached at module load)
 *  so tests can stub the env without resetModules; trimmed so a
 *  whitespace-only value can't masquerade as a real instance name. */
export function resolveSourceInstance(): string {
  return (process.env.MEMORY_INSTANCE_NAME ?? '').trim() || 'unknown';
}

/**
 * Creates a new Observation with the current UTC timestamp and optional metadata.
 * Called when observations are added through the API (not during migration).
 *
 * @param content - The observation content string
 * @param importance - 1.0-5.0 importance score (default 3.0 = medium)
 * @param contextLayer - 'L0', 'L1', or null (default null = L2, on-demand)
 * @param memoryType - Free-form type tag (default null = unclassified)
 * @param sourceRef - Provenance pointer (v1.7.0); '' (default) = unset, so the
 *   sourceRef field is omitted entirely — matching the absent-when-empty output
 *   convention (a stored '' would surface as a meaningless empty string).
 * @returns An Observation object with all fields populated
 */
export function createObservation(
  content: string,
  importance: number = 3.0,
  contextLayer: string | null = null,
  memoryType: string | null = null,
  sourceRef: string = ''
): Observation {
  const obs: Observation = { content, createdAt: new Date().toISOString(), importance, contextLayer, memoryType, sourceInstance: resolveSourceInstance() };
  if (sourceRef) obs.sourceRef = sourceRef;
  return obs;
}
