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
import { JsonlStore } from './jsonl-store.js';

/**
 * Checks if a file exists at the given path.
 * Uses fs.access() which resolves if the file is reachable and rejects otherwise.
 *
 * @param filePath - Absolute path to check
 * @returns true if the file is accessible, false otherwise
 */
async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

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
   *
   * If the .db file doesn't exist yet but a .jsonl file is found at the same path
   * (with extension swapped), the JSONL data is migrated into SQLite in a single
   * transaction and the JSONL file is renamed to .jsonl.bak.
   */
  async init(): Promise<void> {
    // --- Check for JSONL migration BEFORE opening the DB ---
    // (Opening the DB creates the file, which would defeat the "db doesn't exist" check)
    let migrationData: KnowledgeGraph | null = null;
    const dbAlreadyExists = await fileExists(this.dbPath);

    if (!dbAlreadyExists) {
      // Look for a JSONL file at the same path but with .jsonl extension instead of .db/.sqlite
      const jsonlPath = this.dbPath.replace(/\.(db|sqlite)$/, '.jsonl');
      if (jsonlPath !== this.dbPath && await fileExists(jsonlPath)) {
        console.error(`DETECTED: Found ${jsonlPath}, will migrate to SQLite`);
        // JsonlStore.init() is a no-op, but we call it for interface consistency
        const jsonlStore = new JsonlStore(jsonlPath);
        await jsonlStore.init();
        migrationData = await jsonlStore.readGraph();
        await jsonlStore.close();
      }
    }

    // --- Open database and create schema ---
    // new Database() creates the file if it doesn't exist (this is why we check first)
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

    // --- Run migration if data was loaded from JSONL ---
    if (migrationData) {
      const jsonlPath = this.dbPath.replace(/\.(db|sqlite)$/, '.jsonl');
      this.migrateFromJsonl(migrationData);
      // Rename the JSONL file to .bak so it won't be re-migrated on next startup
      try {
        await fs.rename(jsonlPath, jsonlPath + '.bak');
      } catch (renameError) {
        console.error(`WARNING: Migration succeeded but could not rename ${jsonlPath} to .bak:`, renameError);
      }
      console.error(
        `COMPLETED: Migrated ${migrationData.entities.length} entities and ` +
        `${migrationData.relations.length} relations to SQLite. Backup at ${jsonlPath}.bak`
      );
    }
  }

  /**
   * Imports a KnowledgeGraph (read from JSONL) into the SQLite database.
   * Runs in a single transaction -- rolls back on any error.
   * Uses INSERT OR IGNORE to tolerate duplicates in corrupted JSONL data.
   * Dangling relations (referencing non-existent entities) are silently skipped
   * because the FK constraint prevents insertion.
   *
   * @param graph - KnowledgeGraph loaded from the JSONL file by JsonlStore.readGraph()
   */
  private migrateFromJsonl(graph: KnowledgeGraph): void {
    // Prepared statements are compiled once and reused for every row in the transaction
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?)'
    );
    // Used to look up the auto-assigned id after inserting an entity
    const getEntityId = this.db.prepare(
      'SELECT id FROM entities WHERE name = ?'
    );
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );
    const insertRel = this.db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)'
    );

    // db.transaction() wraps everything in BEGIN/COMMIT and auto-rolls-back on throw
    const txn = this.db.transaction(() => {
      for (const entity of graph.entities) {
        // INSERT OR IGNORE: if name already exists (duplicate in JSONL), skip silently
        insertEntity.run(entity.name, entity.entityType);
        const row = getEntityId.get(entity.name) as { id: number };
        for (const obs of entity.observations) {
          // obs is already a normalized Observation object (JsonlStore.readGraph() calls normalizeObservation)
          insertObs.run(row.id, obs.content, obs.createdAt);
        }
      }
      for (const rel of graph.relations) {
        try {
          // INSERT OR IGNORE handles duplicate relations; the try/catch handles FK violations
          // (relation referencing an entity name that doesn't exist in this DB)
          insertRel.run(rel.from, rel.to, rel.relationType);
        } catch (err: unknown) {
          // FK violation -- one or both endpoint entities don't exist. Skip silently.
          // Re-throw unexpected errors to trigger transaction rollback.
          if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
            // Dangling relation from JSONL -- skip
          } else {
            throw err;
          }
        }
      }
    });
    txn();
  }

  /**
   * Closes the database connection. Call when done to release the file lock.
   * Guarded against double-close and uninitialized state (safe to call before init()).
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
    }
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

  /**
   * Fetches full Entity objects for a set of entity rows, including their observations.
   * Groups observation rows by entity name and assembles complete Entity objects.
   * Uses a single query to fetch all observations (avoids N+1 queries).
   *
   * @param entityRows - Array of { name, entityType } from an entities query
   * @returns Entity array with observations attached
   */
  private buildEntities(entityRows: { name: string; entityType: string }[]): Entity[] {
    if (entityRows.length === 0) return [];

    // Build placeholder string for SQL IN clause (one '?' per entity)
    const names = entityRows.map(e => e.name);
    const placeholders = names.map(() => '?').join(',');

    // Fetch all observations for these entities in one query
    const obsRows = this.db.prepare(`
      SELECT e.name AS entityName, o.content, o.created_at AS createdAt
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.name IN (${placeholders})
    `).all(...names) as { entityName: string; content: string; createdAt: string }[];

    // Group observations by entity name using a Map
    const obsMap = new Map<string, Observation[]>();
    for (const o of obsRows) {
      if (!obsMap.has(o.entityName)) obsMap.set(o.entityName, []);
      obsMap.get(o.entityName)!.push({ content: o.content, createdAt: o.createdAt });
    }

    return entityRows.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: obsMap.get(e.name) || [],
    }));
  }

  /**
   * Fetches all relations where at least one endpoint is in the given name set.
   *
   * @param entityNames - Array of entity name strings
   * @returns Relation array with from/to/relationType fields
   */
  private getConnectedRelations(entityNames: string[]): Relation[] {
    if (entityNames.length === 0) return [];

    const placeholders = entityNames.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType
      FROM relations
      WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})
    `).all(...entityNames, ...entityNames) as Relation[];
  }

  /**
   * Returns the entire knowledge graph (all entities with observations, all relations).
   * For an empty database, returns { entities: [], relations: [] }.
   */
  async readGraph(): Promise<KnowledgeGraph> {
    const entityRows = this.db.prepare(
      'SELECT name, entity_type AS entityType FROM entities'
    ).all() as { name: string; entityType: string }[];

    const entities = this.buildEntities(entityRows);

    const relations = this.db.prepare(
      'SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType FROM relations'
    ).all() as Relation[];

    return { entities, relations };
  }

  /**
   * Searches entities by case-insensitive substring match against name, entityType,
   * or observation content. Uses LIKE with escaped wildcards.
   *
   * SQLite's LIKE is case-insensitive for ASCII characters (A-Z) by default.
   * For full Unicode case folding, FTS5 with ICU would be needed.
   *
   * @param query - The search string, matched as a case-insensitive substring
   * @returns Matching entities + relations where at least one endpoint matches
   */
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const escaped = escapeLike(query);
    const pattern = `%${escaped}%`;

    // Find entities matching the query in name, type, or any observation content.
    // LEFT JOIN ensures entities with no observations are still checked.
    // DISTINCT prevents duplicates when multiple observations match.
    const entityRows = this.db.prepare(`
      SELECT DISTINCT e.name, e.entity_type AS entityType
      FROM entities e
      LEFT JOIN observations o ON o.entity_id = e.id
      WHERE e.name LIKE ? ESCAPE '\\'
         OR e.entity_type LIKE ? ESCAPE '\\'
         OR o.content LIKE ? ESCAPE '\\'
    `).all(pattern, pattern, pattern) as { name: string; entityType: string }[];

    const entities = this.buildEntities(entityRows);
    const relations = this.getConnectedRelations(entityRows.map(e => e.name));

    return { entities, relations };
  }

  /**
   * Retrieves specific entities by exact name match. Returns matching entities
   * plus relations where at least one endpoint is in the requested set.
   * Non-existent names are silently skipped.
   *
   * @param names - Array of entity name strings to retrieve
   * @returns Matching entities with observations + connected relations
   */
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (names.length === 0) return { entities: [], relations: [] };

    const placeholders = names.map(() => '?').join(',');
    const entityRows = this.db.prepare(
      `SELECT name, entity_type AS entityType FROM entities WHERE name IN (${placeholders})`
    ).all(...names) as { name: string; entityType: string }[];

    const entities = this.buildEntities(entityRows);
    const relations = this.getConnectedRelations(entityRows.map(e => e.name));

    return { entities, relations };
  }
}
