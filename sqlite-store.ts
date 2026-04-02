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
  type SkippedEntity,
  type CreateEntitiesResult,
} from './types.js';
import { JsonlStore } from './jsonl-store.js';

/**
 * Checks if a file exists at the given path.
 * Only treats ENOENT (file not found) as "doesn't exist."
 * Permission errors (EACCES), I/O errors (EIO), etc. propagate so they
 * aren't mistaken for "file doesn't exist."
 *
 * @param filePath - Absolute path to check
 * @returns true if the file exists and is accessible
 * @throws Error for non-ENOENT filesystem errors (EACCES, EIO, etc.)
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as any).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
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

// Max parameters per SQL IN clause. SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999.
// We use 900 to leave headroom for other parameters in the same query.
const CHUNK_SIZE = 900;

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
    // project is nullable: NULL means global (visible to all projects).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        project     TEXT
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

    // Migrate: add project column if upgrading from pre-Phase-3 schema.
    // Uses pragma table_info to check if the column exists (spec-prescribed approach).
    const columns = this.db.pragma('table_info(entities)') as { name: string }[];
    const hasProject = columns.some(c => c.name === 'project');
    if (!hasProject) {
      this.db.exec(`
        ALTER TABLE entities ADD COLUMN project TEXT;
        CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
      `);
    }

    // Create indexes if they don't exist yet (idempotent).
    // idx_entities_project: speeds up project-filtered entity queries.
    // idx_relations_to_entity: the UNIQUE composite index on relations has from_entity
    // as leftmost prefix, so from_entity IN (...) can use it. But to_entity IN (...)
    // in getConnectedRelations needs its own index to avoid full table scans.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_relations_to_entity ON relations(to_entity);');

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
      'INSERT OR IGNORE INTO entities (name, entity_type, project) VALUES (?, ?, ?)'
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
        // INSERT OR IGNORE: if name already exists (duplicate in JSONL), skip silently.
        // Normalize the project value (trim + lowercase) to match the normalization
        // applied by createEntities. Without this, mixed-case project values from JSONL
        // (e.g., "My-Project") would be stored verbatim and become invisible to
        // project-filtered queries that normalize to lowercase ("my-project").
        const migratedProject = typeof entity.project === 'string'
          ? entity.project.trim().toLowerCase() || null
          : null;
        insertEntity.run(entity.name, entity.entityType, migratedProject);
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
          // FK violation -- one or both endpoint entities don't exist.
          // Log the details so the user knows what was dropped.
          // Re-throw unexpected errors to trigger transaction rollback.
          if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
            console.error(`WARNING: Skipped dangling relation during migration: ${rel.from} -> ${rel.to} [${rel.relationType}] (entity not found)`);
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
   * Sets this.db to null after closing so subsequent calls are no-ops.
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null!;
    }
  }

  /**
   * Creates new entities in the SQLite database, optionally scoped to a project.
   * Uses INSERT OR IGNORE to skip name-duplicates (both existing and within-batch).
   * Observations are inserted with INSERT OR IGNORE to deduplicate by (entity_id, content).
   * Returns a CreateEntitiesResult with created entities and skipped duplicates.
   *
   * @param entities - Array of entities to create, each with observations as strings or objects
   * @param projectId - Optional project name; normalized to lowercase/trimmed. Omit for global.
   * @returns CreateEntitiesResult with created entities and skipped duplicates
   */
  async createEntities(entities: EntityInput[], projectId?: string): Promise<CreateEntitiesResult> {
    // Normalize the project ID: trim whitespace, lowercase, NFC normalize, or null for global
    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC') || null;

    // Prepared statements are compiled once and reused -- faster than db.exec() per row
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type, project) VALUES (?, ?, ?)'
    );
    const getEntityId = this.db.prepare(
      'SELECT id FROM entities WHERE name = ?'
    );
    // Look up existing entity's project for skip reporting
    const getExistingProject = this.db.prepare(
      'SELECT project FROM entities WHERE name = ?'
    );
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );

    const created: Entity[] = [];
    const skipped: SkippedEntity[] = [];

    // db.transaction() wraps the callback in BEGIN/COMMIT. If the callback throws,
    // it automatically rolls back. This is a better-sqlite3 feature (not raw SQL).
    const txn = this.db.transaction(() => {
      for (const e of entities) {
        // INSERT OR IGNORE returns changes=0 if the name already exists (UNIQUE constraint)
        const info = insertEntity.run(e.name, e.entityType, normalizedProject);
        if (info.changes === 0) {
          // Entity already exists -- report it as skipped with its existing project
          const existing = getExistingProject.get(e.name) as { project: string | null } | undefined;
          skipped.push({
            name: e.name,
            existingProject: existing?.project ?? null,
          });
          continue;
        }

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

        created.push({ name: e.name, entityType: e.entityType, observations, project: normalizedProject });
      }
    });
    txn();

    return { created, skipped };
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
   * Uses a single query per chunk to fetch all observations (avoids N+1 queries).
   * Chunks the IN clause to stay within SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (default 999).
   *
   * @param entityRows - Array of { name, entityType, project } from an entities query
   * @returns Entity array with observations attached
   */
  private buildEntities(entityRows: { name: string; entityType: string; project: string | null }[]): Entity[] {
    if (entityRows.length === 0) return [];

    const names = entityRows.map(e => e.name);

    // Group observations by entity name using a Map, fetching in chunks
    // to avoid exceeding SQLite's parameter limit (default 999)
    const obsMap = new Map<string, Observation[]>();
    for (let i = 0; i < names.length; i += CHUNK_SIZE) {
      const chunk = names.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      const obsRows = this.db.prepare(`
        SELECT e.name AS entityName, o.content, o.created_at AS createdAt
        FROM observations o
        JOIN entities e ON o.entity_id = e.id
        WHERE e.name IN (${placeholders})
      `).all(...chunk) as { entityName: string; content: string; createdAt: string }[];

      for (const o of obsRows) {
        if (!obsMap.has(o.entityName)) obsMap.set(o.entityName, []);
        obsMap.get(o.entityName)!.push({ content: o.content, createdAt: o.createdAt });
      }
    }

    return entityRows.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: obsMap.get(e.name) || [],
      project: e.project,
    }));
  }

  /**
   * Fetches all relations where at least one endpoint is in the given name set.
   * Chunks the IN clause to stay within SQLite's parameter limit.
   * Uses CHUNK_SIZE / 2 per chunk because each name appears twice (from OR to).
   *
   * @param entityNames - Array of entity name strings
   * @returns Relation array with from/to/relationType fields
   */
  private getConnectedRelations(entityNames: string[]): Relation[] {
    if (entityNames.length === 0) return [];

    // Each name is bound twice (from_entity IN (...) OR to_entity IN (...)),
    // so use half the chunk size to stay within the parameter limit
    const halfChunk = Math.floor(CHUNK_SIZE / 2);
    const results: Relation[] = [];

    for (let i = 0; i < entityNames.length; i += halfChunk) {
      const chunk = entityNames.slice(i, i + halfChunk);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType
        FROM relations
        WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})
      `).all(...chunk, ...chunk) as Relation[];
      results.push(...rows);
    }

    // Deduplicate: chunked queries may return the same relation if its endpoints
    // span different chunks (e.g., from in chunk 1, to in chunk 2)
    const seen = new Set<string>();
    return results.filter(r => {
      const key = JSON.stringify([r.from, r.to, r.relationType]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Returns the knowledge graph, optionally filtered by project.
   * When projectId is provided, returns entities belonging to that project
   * plus global entities (project IS NULL). Relations are included only
   * when both endpoints are in the filtered entity set.
   * When projectId is omitted, returns the entire unfiltered graph.
   *
   * @param projectId - Optional project name to filter by; normalized to lowercase/trimmed
   */
  async readGraph(projectId?: string): Promise<KnowledgeGraph> {
    let entityRows: { name: string; entityType: string; project: string | null }[];

    if (projectId) {
      const normalizedProject = projectId.trim().toLowerCase().normalize('NFC');
      // Return entities matching the project OR global entities (project IS NULL)
      entityRows = this.db.prepare(
        'SELECT name, entity_type AS entityType, project FROM entities WHERE project = ? OR project IS NULL'
      ).all(normalizedProject) as { name: string; entityType: string; project: string | null }[];
    } else {
      entityRows = this.db.prepare(
        'SELECT name, entity_type AS entityType, project FROM entities'
      ).all() as { name: string; entityType: string; project: string | null }[];
    }

    const entities = this.buildEntities(entityRows);

    if (projectId) {
      // When filtering by project, use getConnectedRelations to fetch only
      // relations touching our entity set (SQL-level filtering via idx_relations_to_entity),
      // then AND-filter to keep only relations where both endpoints are in the set
      const entityNames = new Set(entityRows.map(e => e.name));
      const connectedRelations = this.getConnectedRelations(entityRows.map(e => e.name));
      const filteredRelations = connectedRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations };
    }

    // Unscoped: return all relations (backward compatible)
    const relations = this.db.prepare(
      'SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType FROM relations'
    ).all() as Relation[];

    return { entities, relations };
  }

  /**
   * Searches entities by case-insensitive substring match against name, entityType,
   * or observation content. Uses LIKE with escaped wildcards.
   * When projectId is provided, results are restricted to entities belonging to
   * the project or global entities (project IS NULL).
   *
   * SQLite's LIKE is case-insensitive for ASCII characters (A-Z) by default.
   * For full Unicode case folding, FTS5 with ICU would be needed.
   *
   * @param query - The search string, matched as a case-insensitive substring
   * @param projectId - Optional project name; only returns entities in this project or global
   * @returns Matching entities + relations where both endpoints are in the result set
   */
  async searchNodes(query: string, projectId?: string): Promise<KnowledgeGraph> {
    const escaped = escapeLike(query);
    const pattern = `%${escaped}%`;

    let entityRows: { name: string; entityType: string; project: string | null }[];

    if (projectId) {
      const normalizedProject = projectId.trim().toLowerCase().normalize('NFC');
      // Find entities matching the query AND belonging to the project or global
      entityRows = this.db.prepare(`
        SELECT DISTINCT e.name, e.entity_type AS entityType, e.project
        FROM entities e
        LEFT JOIN observations o ON o.entity_id = e.id
        WHERE (e.name LIKE ? ESCAPE '\\'
           OR e.entity_type LIKE ? ESCAPE '\\'
           OR o.content LIKE ? ESCAPE '\\')
          AND (e.project = ? OR e.project IS NULL)
      `).all(pattern, pattern, pattern, normalizedProject) as { name: string; entityType: string; project: string | null }[];
    } else {
      // No project filter -- search across all entities
      entityRows = this.db.prepare(`
        SELECT DISTINCT e.name, e.entity_type AS entityType, e.project
        FROM entities e
        LEFT JOIN observations o ON o.entity_id = e.id
        WHERE e.name LIKE ? ESCAPE '\\'
           OR e.entity_type LIKE ? ESCAPE '\\'
           OR o.content LIKE ? ESCAPE '\\'
      `).all(pattern, pattern, pattern) as { name: string; entityType: string; project: string | null }[];
    }

    const entities = this.buildEntities(entityRows);
    // When project-filtered, use AND logic for relations (both endpoints in result set);
    // when unfiltered, use OR logic (at least one endpoint matches) for backward compat
    const entityNames = new Set(entityRows.map(e => e.name));
    if (projectId) {
      const allRelations = this.getConnectedRelations(entityRows.map(e => e.name));
      const filteredRelations = allRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations };
    }

    const relations = this.getConnectedRelations(entityRows.map(e => e.name));
    return { entities, relations };
  }

  /**
   * Retrieves specific entities by exact name match. Returns matching entities
   * plus relations where both endpoints are in the result set.
   * Non-existent names are silently skipped.
   * When projectId is provided, only returns entities in the project or global.
   *
   * @param names - Array of entity name strings to retrieve
   * @param projectId - Optional project name; only returns entities in this project or global
   * @returns Matching entities with observations + connected relations
   */
  async openNodes(names: string[], projectId?: string): Promise<KnowledgeGraph> {
    if (names.length === 0) return { entities: [], relations: [] };

    let entityRows: { name: string; entityType: string; project: string | null }[];

    if (projectId) {
      const normalizedProject = projectId.trim().toLowerCase().normalize('NFC');
      const placeholders = names.map(() => '?').join(',');
      entityRows = this.db.prepare(
        `SELECT name, entity_type AS entityType, project FROM entities WHERE name IN (${placeholders}) AND (project = ? OR project IS NULL)`
      ).all(...names, normalizedProject) as { name: string; entityType: string; project: string | null }[];
    } else {
      const placeholders = names.map(() => '?').join(',');
      entityRows = this.db.prepare(
        `SELECT name, entity_type AS entityType, project FROM entities WHERE name IN (${placeholders})`
      ).all(...names) as { name: string; entityType: string; project: string | null }[];
    }

    const entities = this.buildEntities(entityRows);

    // When project-filtered, use AND logic for relations (both endpoints in result set);
    // when unfiltered, use OR logic (at least one endpoint matches) for backward compat
    if (projectId) {
      const entityNames = new Set(entityRows.map(e => e.name));
      const allRelations = this.getConnectedRelations(entityRows.map(e => e.name));
      const filteredRelations = allRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations };
    }

    const relations = this.getConnectedRelations(entityRows.map(e => e.name));
    return { entities, relations };
  }

  /**
   * Lists all distinct project names that have at least one entity.
   * Global entities (project IS NULL) are excluded from the list.
   *
   * @returns Sorted array of project name strings
   */
  async listProjects(): Promise<string[]> {
    const rows = this.db.prepare(
      'SELECT DISTINCT project FROM entities WHERE project IS NOT NULL ORDER BY project'
    ).all() as { project: string }[];
    return rows.map(r => r.project);
  }
}
