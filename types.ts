// types.ts -- Shared interfaces and types for the knowledge graph.
// Both JsonlStore and SqliteStore depend on these types.

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
 *   'L1' = loaded at session start (~800 token budget, active work and decisions)
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

/** Input type for creating/deleting relations — just the triple, no temporal fields.
 * Used by createRelations() and deleteRelations() callers. */
export interface RelationInput {
  from: string;
  to: string;
  relationType: string;
}

/** Full relation as returned by queries — includes temporal tracking fields.
 * createdAt: ISO 8601 UTC when the relation was established (sentinel for legacy).
 * supersededAt: '' = active, ISO timestamp = invalidated. */
export interface Relation {
  from: string;
  to: string;
  relationType: string;
  createdAt: string;
  supersededAt: string;
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
  status: 'active' | 'superseded';
}

/** Relation entry in an entity timeline — includes invalidated relations. */
export interface TimelineRelation {
  from: string;
  to: string;
  relationType: string;
  createdAt: string;
  supersededAt: string;
  status: 'active' | 'superseded';
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
}

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
 *  ready and found near-matches (cosine > 0.85) for newly added observations. */
export type AddObservationResult = {
  entityName: string;
  addedObservations: Observation[];
  similarExisting?: SimilarObservation[];
};

/** An entity that was skipped during createEntities because its name
 *  already exists (possibly in a different project). */
export type SkippedEntity = {
  name: string;
  existingProject: string | null;
};

/** Return type for createEntities. Reports both created entities and
 *  skipped duplicates with their owning project for collision feedback. */
export type CreateEntitiesResult = {
  created: Entity[];
  skipped: SkippedEntity[];
};

/** Input for supersede_observations tool: replace one observation with another on an entity. */
export interface SupersedeInput {
  entityName: string;
  oldContent: string;
  newContent: string;
}

/**
 * The GraphStore interface -- the contract both JsonlStore and SqliteStore implement.
 * Methods mirror the MCP tool operations. Return types use Readonly to prevent
 * accidental mutation of returned data.
 */
export interface GraphStore {
  /** One-time setup: create tables, run migrations, etc. No-op for JSONL. */
  init(): Promise<void>;

  /** Cleanup: close DB connection. No-op for JSONL. */
  close(): Promise<void>;

  /** Signals the store to stop background work (e.g., embedding sweep) and
   *  prepare for shutdown. Call before close(). No-op for backends without
   *  background tasks. */
  shutdown(): void;

  /** Creates new entities. Skips entities whose names already exist (UNIQUE constraint)
   *  and reports them as skipped with their owning project for collision feedback.
   *  @param entities - Array of EntityInput objects. Observations can be plain strings
   *                    (auto-timestamped) or Observation objects.
   *  @param projectId - Optional project scope. Omit or pass undefined for global scope. */
  createEntities(entities: EntityInput[], projectId?: string): Promise<Readonly<CreateEntitiesResult>>;
  /** Creates new relations between existing entities. Deduplicates by composite key
   *  [from, to, relationType]. In SQLite, FK constraints enforce both endpoints exist.
   *  @param relations - Array of RelationInput (3-field). Temporal fields are system-assigned.
   *  @returns Only the relations actually created, as full Relation objects with temporal fields */
  createRelations(relations: RelationInput[]): Promise<Readonly<Relation[]>>;
  /** Adds observations to existing entities. Deduplicates by content string.
   *  Throws if any entityName does not match an existing entity.
   *  @param observations - Array of { entityName, contents: string[] }
   *  @returns Per-entity results with added observations and optional similarExisting warnings */
  addObservations(observations: AddObservationInput[]): Promise<Readonly<AddObservationResult[]>>;
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
   *  Not supported by JSONL backend (throws).
   *  @param supersessions - Array of { entityName, oldContent, newContent }
   *  @throws Error if entity or active observation not found, or if JSONL backend */
  supersedeObservations(supersessions: SupersedeInput[]): Promise<void>;
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
   *    returns only observations/relations that were active at that moment. JSONL ignores this. */
  readGraph(projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<Readonly<PaginatedKnowledgeGraph>>;
  /** Searches for entities matching a case-insensitive substring query against name,
   *  entityType, or observation content. Augmented with vector similarity search when
   *  the embedding model is ready (SQLite only). Results paginated by recency.
   *  @param query - Case-insensitive substring to search for
   *  @param projectId - Optional project scope
   *  @param pagination - Optional cursor and limit
   *  @param asOf - Optional ISO 8601 UTC timestamp for point-in-time queries */
  searchNodes(query: string, projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<Readonly<PaginatedKnowledgeGraph>>;
  /** Retrieves specific entities by exact name match plus connected relations.
   *  Non-existent names are silently skipped. Use this instead of readGraph when you
   *  need full relation context for a known set of entities.
   *  @param asOf - Optional ISO 8601 UTC timestamp for point-in-time queries */
  openNodes(names: string[], projectId?: string, asOf?: string): Promise<Readonly<KnowledgeGraph>>;
  /** Lists all distinct project names that have at least one entity.
   *  Global entities (project === null) are excluded. */
  listProjects(): Promise<string[]>;
  /** Returns full timeline for an entity (all observations and relations, active + superseded). */
  entityTimeline(entityName: string, projectId?: string): Promise<EntityTimelineResult | null>;
}

/**
 * Creates a new Observation with the current UTC timestamp and optional metadata.
 * Called when observations are added through the API (not during migration).
 *
 * @param content - The observation content string
 * @param importance - 1.0-5.0 importance score (default 3.0 = medium)
 * @param contextLayer - 'L0', 'L1', or null (default null = L2, on-demand)
 * @param memoryType - Free-form type tag (default null = unclassified)
 * @returns An Observation object with all fields populated
 */
export function createObservation(
  content: string,
  importance: number = 3.0,
  contextLayer: string | null = null,
  memoryType: string | null = null
): Observation {
  return { content, createdAt: new Date().toISOString(), importance, contextLayer, memoryType };
}
