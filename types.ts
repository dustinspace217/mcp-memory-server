// types.ts -- Shared interfaces and types for the knowledge graph.
// Both JsonlStore and SqliteStore depend on these types.

/**
 * A single piece of knowledge attached to an entity.
 * Each observation carries a creation timestamp for staleness detection.
 * createdAt is ISO 8601 UTC, or 'unknown' for data migrated from the old string format.
 */
export interface Observation {
  content: string;
  createdAt: string;
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
  // message is the human-readable reason the cursor was rejected
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

/** Input type for addObservations. Each entry targets an entity by name. */
export type AddObservationInput = {
  entityName: string;
  contents: string[];
};

/** Input type for deleteObservations. Field is 'contents' (not 'observations')
 *  to be consistent with AddObservationInput. */
export type DeleteObservationInput = {
  entityName: string;
  contents: string[];
};

/** Return type for addObservations. Reports which observations were actually added
 *  (excludes duplicates). */
export type AddObservationResult = {
  entityName: string;
  addedObservations: Observation[];
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

  createEntities(entities: EntityInput[], projectId?: string): Promise<Readonly<CreateEntitiesResult>>;
  createRelations(relations: RelationInput[]): Promise<Readonly<Relation[]>>;
  addObservations(observations: AddObservationInput[]): Promise<Readonly<AddObservationResult[]>>;
  deleteEntities(entityNames: string[]): Promise<void>;
  deleteObservations(deletions: DeleteObservationInput[]): Promise<void>;
  deleteRelations(relations: RelationInput[]): Promise<void>;
  supersedeObservations(supersessions: SupersedeInput[]): Promise<void>;
  /** Invalidates relations by setting superseded_at to current timestamp.
   * Idempotent — ignores already-invalidated relations. */
  invalidateRelations(relations: InvalidateRelationInput[]): Promise<void>;
  readGraph(projectId?: string, pagination?: PaginationParams): Promise<Readonly<PaginatedKnowledgeGraph>>;
  searchNodes(query: string, projectId?: string, pagination?: PaginationParams): Promise<Readonly<PaginatedKnowledgeGraph>>;
  openNodes(names: string[], projectId?: string): Promise<Readonly<KnowledgeGraph>>;
  listProjects(): Promise<string[]>;
  /** Returns full timeline for an entity (all observations and relations, active + superseded). */
  entityTimeline(entityName: string, projectId?: string): Promise<EntityTimelineResult | null>;
}

/**
 * Creates a new Observation with the current UTC timestamp.
 * Called when observations are added through the API (not during migration).
 *
 * @param content - The observation content string
 * @returns An Observation object with content and an ISO 8601 createdAt timestamp
 */
export function createObservation(content: string): Observation {
  return { content, createdAt: new Date().toISOString() };
}
