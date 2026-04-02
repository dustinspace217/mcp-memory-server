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

/** A named node in the knowledge graph with a type and attached observations. */
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
}

/** A directed edge between two entities with a relation type. */
export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

/** The complete knowledge graph: all entities and all relations. */
export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
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

  createEntities(entities: EntityInput[]): Promise<Readonly<Entity[]>>;
  createRelations(relations: Relation[]): Promise<Readonly<Relation[]>>;
  addObservations(observations: AddObservationInput[]): Promise<Readonly<AddObservationResult[]>>;
  deleteEntities(entityNames: string[]): Promise<void>;
  deleteObservations(deletions: DeleteObservationInput[]): Promise<void>;
  deleteRelations(relations: Relation[]): Promise<void>;
  readGraph(): Promise<Readonly<KnowledgeGraph>>;
  searchNodes(query: string): Promise<Readonly<KnowledgeGraph>>;
  openNodes(names: string[]): Promise<Readonly<KnowledgeGraph>>;
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
