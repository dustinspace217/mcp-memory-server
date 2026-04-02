// sqlite-store.ts -- SQLite storage backend for the knowledge graph.
// Uses better-sqlite3 for synchronous, high-performance database access.
// Methods are async (returning resolved promises) to match the GraphStore interface.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import {
  createObservation,
  type Observation,
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
} from './types.js';

/**
 * Escapes LIKE special characters so they match as literal substrings.
 * Without this, a query containing '%' or '_' would act as a wildcard.
 *
 * @param query - Raw search string from the user
 * @returns Escaped string safe for use in LIKE '%escaped%' ESCAPE '\'
 */
function escapeLike(query: string): string {
  return query.replace(/[%_\\]/g, '\\$&');
}

/**
 * SQLite-backed knowledge graph store. Uses WAL mode for concurrent read performance
 * and foreign key constraints for referential integrity.
 *
 * Implements GraphStore so it can be swapped with JsonlStore transparently.
 */
export class SqliteStore implements GraphStore {
  // The '!' (definite assignment) tells TypeScript this is set in init() before use.
  // better-sqlite3's Database type -- a synchronous SQLite connection handle.
  private db!: Database.Database;

  /**
   * @param dbPath - Absolute path to the .db file. Created on first init() if missing.
   */
  constructor(private dbPath: string) {}

  /**
   * Opens the SQLite database, sets pragmas, and creates tables if they don't exist.
   * Must be called before any other method.
   *
   * WAL (Write-Ahead Logging) mode allows concurrent readers without blocking writers.
   * foreign_keys must be enabled per-connection (SQLite doesn't persist this setting).
   */
  async init(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create tables. IF NOT EXISTS makes this safe to call on an existing database.
    // entities.name has a UNIQUE constraint so it can be referenced by relations.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(entity_id, content)
      );

      CREATE TABLE IF NOT EXISTS relations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        relation_type TEXT NOT NULL,
        UNIQUE(from_entity, to_entity, relation_type)
      );
    `);
  }

  /** Closes the database connection. Call when done to release the file lock. */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Creates new entities in the SQLite database.
   * Uses INSERT OR IGNORE to skip name-duplicates (both existing and within-batch).
   * Observations are inserted with INSERT OR IGNORE to deduplicate by (entity_id, content).
   *
   * @param entities - Array of entities to create, each with observations as strings or objects
   * @returns Only the entities that were actually created (excludes name-duplicates)
   */
  async createEntities(entities: EntityInput[]): Promise<Entity[]> {
    // Prepared statements are compiled once and reused -- faster than db.exec() per row
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?)'
    );
    const getEntityId = this.db.prepare(
      'SELECT id FROM entities WHERE name = ?'
    );
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );

    const results: Entity[] = [];

    // db.transaction() wraps the callback in BEGIN/COMMIT. If the callback throws,
    // it automatically rolls back. This is a better-sqlite3 feature (not raw SQL).
    const txn = this.db.transaction(() => {
      for (const e of entities) {
        // INSERT OR IGNORE returns changes=0 if the name already exists (UNIQUE constraint)
        const info = insertEntity.run(e.name, e.entityType);
        if (info.changes === 0) continue;

        // Get the auto-generated id for inserting observations
        const row = getEntityId.get(e.name) as { id: number };
        const observations: Observation[] = [];

        for (const obs of e.observations) {
          const o = typeof obs === 'string' ? createObservation(obs) : obs;
          const obsInfo = insertObs.run(row.id, o.content, o.createdAt);
          if (obsInfo.changes > 0) {
            observations.push(o);
          }
        }

        results.push({ name: e.name, entityType: e.entityType, observations });
      }
    });
    txn();

    return results;
  }

  /**
   * Creates new relations in the SQLite database.
   * Uses INSERT OR IGNORE to skip duplicates (UNIQUE constraint on all 3 fields).
   * Foreign key constraints ensure both endpoint entities exist -- throws on violation.
   *
   * @param relations - Array of { from, to, relationType }
   * @returns Only the relations that were actually created
   * @throws SqliteError if from or to entity doesn't exist (FK constraint violation)
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)'
    );

    const results: Relation[] = [];

    const txn = this.db.transaction(() => {
      for (const r of relations) {
        const info = insert.run(r.from, r.to, r.relationType);
        if (info.changes > 0) {
          results.push(r);
        }
      }
    });
    txn();

    return results;
  }

  /**
   * Adds observations to existing entities. Throws if any entity is not found
   * (check happens before any insertions, so no partial writes).
   * Uses INSERT OR IGNORE to deduplicate by (entity_id, content).
   *
   * @param observations - Array of { entityName, contents: string[] }
   * @returns Per-entity results with only the observations actually added
   * @throws Error if any entityName doesn't match an existing entity
   */
  async addObservations(observations: AddObservationInput[]): Promise<AddObservationResult[]> {
    const findEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );

    const results: AddObservationResult[] = [];

    const txn = this.db.transaction(() => {
      for (const o of observations) {
        const row = findEntity.get(o.entityName) as { id: number } | undefined;
        if (!row) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }

        const addedObservations: Observation[] = [];
        for (const content of o.contents) {
          const obs = createObservation(content);
          const info = insertObs.run(row.id, obs.content, obs.createdAt);
          if (info.changes > 0) {
            addedObservations.push(obs);
          }
        }

        results.push({ entityName: o.entityName, addedObservations });
      }
    });
    txn();

    return results;
  }

  /**
   * Deletes entities by name. ON DELETE CASCADE on the observations and relations
   * foreign keys automatically removes related rows -- no manual cleanup needed.
   * Silently ignores names that don't exist (idempotent).
   *
   * @param entityNames - Array of entity name strings to delete
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    const del = this.db.prepare('DELETE FROM entities WHERE name = ?');
    const txn = this.db.transaction(() => {
      for (const name of entityNames) {
        del.run(name);
      }
    });
    txn();
  }

  /**
   * Deletes specific observations by content string from the named entities.
   * Silently ignores non-existent entities (idempotent -- absence is the goal).
   *
   * @param deletions - Array of { entityName, contents: string[] }
   */
  async deleteObservations(deletions: DeleteObservationInput[]): Promise<void> {
    const findEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    const delObs = this.db.prepare(
      'DELETE FROM observations WHERE entity_id = ? AND content = ?'
    );

    const txn = this.db.transaction(() => {
      for (const d of deletions) {
        const row = findEntity.get(d.entityName) as { id: number } | undefined;
        if (!row) continue;
        for (const content of d.contents) {
          delObs.run(row.id, content);
        }
      }
    });
    txn();
  }

  /**
   * Deletes specific relations by exact match on all three fields.
   * Silently ignores non-existent relations (idempotent).
   *
   * @param relations - Array of { from, to, relationType }
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    const del = this.db.prepare(
      'DELETE FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?'
    );
    const txn = this.db.transaction(() => {
      for (const r of relations) {
        del.run(r.from, r.to, r.relationType);
      }
    });
    txn();
  }

  async readGraph(): Promise<KnowledgeGraph> {
    throw new Error('SqliteStore.readGraph not implemented');
  }

  async searchNodes(_query: string): Promise<KnowledgeGraph> {
    throw new Error('SqliteStore.searchNodes not implemented');
  }

  async openNodes(_names: string[]): Promise<KnowledgeGraph> {
    throw new Error('SqliteStore.openNodes not implemented');
  }
}
