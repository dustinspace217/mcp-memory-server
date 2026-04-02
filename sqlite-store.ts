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

  async createEntities(_entities: EntityInput[]): Promise<Entity[]> {
    throw new Error('SqliteStore.createEntities not implemented');
  }

  async createRelations(_relations: Relation[]): Promise<Relation[]> {
    throw new Error('SqliteStore.createRelations not implemented');
  }

  async addObservations(_observations: AddObservationInput[]): Promise<AddObservationResult[]> {
    throw new Error('SqliteStore.addObservations not implemented');
  }

  async deleteEntities(_entityNames: string[]): Promise<void> {
    throw new Error('SqliteStore.deleteEntities not implemented');
  }

  async deleteObservations(_deletions: DeleteObservationInput[]): Promise<void> {
    throw new Error('SqliteStore.deleteObservations not implemented');
  }

  async deleteRelations(_relations: Relation[]): Promise<void> {
    throw new Error('SqliteStore.deleteRelations not implemented');
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
