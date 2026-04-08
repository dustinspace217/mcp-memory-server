// sqlite-store.ts -- SQLite storage backend for the knowledge graph.
// Uses better-sqlite3 for synchronous, high-performance database access.
// Methods are async (returning resolved promises) to match the GraphStore interface.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { promises as fs } from 'fs';
import { EmbeddingPipeline, EMBEDDING_DIM, type VectorState } from './embedding.js';
import {
  createObservation,
  ENTITY_TIMESTAMP_SENTINEL,
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
  type PaginationParams,
  type PaginatedKnowledgeGraph,
  type SupersedeInput,
} from './types.js';
import { JsonlStore } from './jsonl-store.js';
import {
  type CursorPayload,
  encodeCursor,
  decodeCursor,
  clampLimit,
  readGraphFingerprint,
  searchNodesFingerprint,
} from './cursor.js';

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

  /** Embedding pipeline for vector search. Created in constructor. */
  private embeddingPipeline = new EmbeddingPipeline();

  /** Whether the vec_observations virtual table exists (sqlite-vec loaded successfully). */
  private vecTableExists = false;

  /** Exposes the current vector search state for callers to inspect. */
  get vectorState(): VectorState {
    return this.embeddingPipeline.state;
  }

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

    // Migrate: add updated_at and created_at columns if upgrading from pre-Phase-4 schema.
    // These timestamps track when the entity itself was last modified and when it was first created.
    // Uses the same pragma table_info check pattern as the project column migration above.
    // Wrapped in an explicit transaction so a crash between ALTER and backfill doesn't leave
    // entities with permanent sentinel timestamps (which sort last in DESC order, effectively invisible).
    const hasUpdatedAt = columns.some(c => c.name === 'updated_at');
    if (!hasUpdatedAt) {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE entities ADD COLUMN updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}';
          ALTER TABLE entities ADD COLUMN created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}';
        `);
        // Backfill updated_at from the most recent observation timestamp.
        // Entities with no valid observation timestamps keep the sentinel value.
        this.db.exec(`
          UPDATE entities SET updated_at = (
            SELECT MAX(created_at) FROM observations
            WHERE entity_id = entities.id AND created_at != 'unknown'
          )
          WHERE updated_at = '${ENTITY_TIMESTAMP_SENTINEL}' AND EXISTS (
            SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
          );
        `);
        // Also backfill created_at from the earliest observation timestamp
        this.db.exec(`
          UPDATE entities SET created_at = (
            SELECT MIN(created_at) FROM observations
            WHERE entity_id = entities.id AND created_at != 'unknown'
          )
          WHERE created_at = '${ENTITY_TIMESTAMP_SENTINEL}' AND EXISTS (
            SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
          );
        `);
      })();
    }

    // Create indexes if they don't exist yet (idempotent).
    // idx_relations_to_entity: the UNIQUE composite index on relations has from_entity
    // as leftmost prefix, so from_entity IN (...) can use it. But to_entity IN (...)
    // in getConnectedRelations needs its own index to avoid full table scans.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_relations_to_entity ON relations(to_entity);');

    // Pagination indexes for keyset queries on (updated_at DESC, id DESC).
    // The composite index with project as leftmost column supports project-scoped reads.
    // The standalone index supports unscoped reads.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_project_updated ON entities(project, updated_at DESC, id DESC);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC, id DESC);');

    // Drop the single-column idx_entities_project — it's now covered by the composite
    // idx_entities_project_updated which has project as its leftmost column.
    // The single-column index was created during Phase 3 migration; once the composite exists,
    // it's redundant and wastes disk space + INSERT/UPDATE overhead.
    this.db.exec('DROP INDEX IF EXISTS idx_entities_project;');

    // Migrate: add superseded_at column to observations table.
    // SQLite can't ALTER a UNIQUE constraint, so we rebuild the table.
    // - superseded_at = '' means active observation (sentinel, not NULL, for UNIQUE correctness)
    // - superseded_at = ISO timestamp means the observation was retired at that time
    // New UNIQUE(entity_id, content, superseded_at) allows the same content to be
    // re-asserted after supersession (different superseded_at values).
    const obsColumns = this.db.pragma('table_info(observations)') as { name: string }[];
    const hasSupersededAt = obsColumns.some(c => c.name === 'superseded_at');
    if (!hasSupersededAt) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE observations_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            content     TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            superseded_at TEXT NOT NULL DEFAULT '',
            UNIQUE(entity_id, content, superseded_at)
          );
          INSERT INTO observations_new (id, entity_id, content, created_at, superseded_at)
            SELECT id, entity_id, content, created_at, '' FROM observations;
          DROP TABLE observations;
          ALTER TABLE observations_new RENAME TO observations;
        `);
      })();
    }

    // Partial index on active observations -- used by all queries that filter
    // by superseded_at = ''. Superseded observations don't need indexing.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_active
      ON observations(entity_id) WHERE superseded_at = '';
    `);

    // --- Crash recovery (#47): detect interrupted migration ---
    // If the database file already existed but has zero entities, AND a sibling .jsonl
    // file is present, a previous migration crashed between `new Database()` (which creates
    // the file) and the end of migrateFromJsonl(). Re-load JSONL data and retry migration.
    // migrateFromJsonl uses INSERT OR IGNORE, so partial data from the crashed attempt
    // is safely handled (duplicates are skipped).
    if (!migrationData && dbAlreadyExists) {
      const entityCount = (this.db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt;
      if (entityCount === 0) {
        const jsonlPath = this.dbPath.replace(/\.(db|sqlite)$/, '.jsonl');
        if (jsonlPath !== this.dbPath && await fileExists(jsonlPath)) {
          console.error(`DETECTED: Empty database with ${jsonlPath} present — recovering from interrupted migration`);
          const jsonlStore = new JsonlStore(jsonlPath);
          await jsonlStore.init();
          migrationData = await jsonlStore.readGraph();
          await jsonlStore.close();
        }
      }
    }

    // --- Run migration if data was loaded from JSONL ---
    if (migrationData) {
      const jsonlPath = this.dbPath.replace(/\.(db|sqlite)$/, '.jsonl');
      this.migrateFromJsonl(migrationData);

      // Backfill timestamps for entities still at the sentinel value after migration (#46).
      // Pre-Phase-4 JSONL files have no updatedAt/createdAt on entities, so migrateFromJsonl()
      // stores ENTITY_TIMESTAMP_SENTINEL. The Phase-4 schema migration backfill (above) only
      // runs when adding the columns to an EXISTING database — for FRESH databases the columns
      // already exist in CREATE TABLE, so that backfill is skipped. This post-migration backfill
      // closes the gap. Idempotent: the WHERE clause only touches entities with sentinel values.
      // Wrapped in a transaction so a crash between the two UPDATEs can't leave updated_at
      // backfilled but created_at still at sentinel (matches the schema-migration pattern above).
      this.db.transaction(() => {
        this.db.exec(`
          UPDATE entities SET updated_at = (
            SELECT MAX(created_at) FROM observations
            WHERE entity_id = entities.id AND created_at != 'unknown'
          )
          WHERE updated_at = '${ENTITY_TIMESTAMP_SENTINEL}' AND EXISTS (
            SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
          );
        `);
        this.db.exec(`
          UPDATE entities SET created_at = (
            SELECT MIN(created_at) FROM observations
            WHERE entity_id = entities.id AND created_at != 'unknown'
          )
          WHERE created_at = '${ENTITY_TIMESTAMP_SENTINEL}' AND EXISTS (
            SELECT 1 FROM observations WHERE entity_id = entities.id AND created_at != 'unknown'
          );
        `);
      })();

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

    // --- Vector search setup ---
    // Load sqlite-vec extension and create the vec_observations virtual table.
    // If loading fails (platform incompatibility, missing binary), degrade gracefully
    // to LIKE-only search. The MEMORY_VECTOR_SEARCH env var can disable this entirely.
    if (process.env.MEMORY_VECTOR_SEARCH === 'off') {
      console.error('Vector search disabled via MEMORY_VECTOR_SEARCH=off');
    } else {
      try {
        // sqliteVec.load() calls db.loadExtension() with the path to the native
        // sqlite-vec binary shipped by the npm package
        sqliteVec.load(this.db);

        // Create the virtual table if it doesn't exist.
        // vec0 is sqlite-vec's virtual table module for dense float vectors.
        // IMPORTANT: vec0 v0.1.9 does NOT support explicit INTEGER PRIMARY KEY
        // values on insert (only auto-assign). We use a TEXT auxiliary column
        // (+observation_id) instead, which maps 1:1 with observations.id.
        // The + prefix makes it an auxiliary column stored alongside vectors.
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(
            embedding float[${EMBEDDING_DIM}],
            +observation_id TEXT NOT NULL
          );
        `);

        this.vecTableExists = true;

        // Startup consistency check: find orphaned embeddings (vec row but no
        // matching active observation) and delete them. Handles CASCADE-deleted
        // observations whose vec rows weren't cleaned up.
        const orphanCount = (this.db.prepare(`
          SELECT COUNT(*) AS cnt FROM vec_observations v
          LEFT JOIN observations o ON CAST(v.observation_id AS INTEGER) = o.id
          WHERE o.id IS NULL
        `).get() as { cnt: number }).cnt;

        if (orphanCount > 0) {
          this.db.exec(`
            DELETE FROM vec_observations WHERE CAST(observation_id AS INTEGER) NOT IN (
              SELECT id FROM observations WHERE superseded_at = ''
            )
          `);
          console.error(`Vector search: cleaned up ${orphanCount} orphaned embeddings`);
        }

        // Start loading the embedding model in the background.
        // When ready, run the universal embedding sweep to generate embeddings
        // for any active observations that don't have one yet.
        this.embeddingPipeline.startLoading(() => {
          this.runEmbeddingSweep();
        });

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `sqlite-vec extension not available (${process.arch}/${process.platform}): ${msg}. ` +
          `Vector search disabled. LIKE search remains functional.`
        );
      }
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
      'INSERT OR IGNORE INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, ?, ?, ?)'
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
        // Normalize the project value (trim + lowercase + NFC) to match the normalization
        // applied by createEntities. Without this, mixed-case project values from JSONL
        // (e.g., "My-Project") would be stored verbatim and become invisible to
        // project-filtered queries that normalize to lowercase ("my-project").
        // NFC normalization ensures macOS (NFD) and Linux (NFC) path-derived names match.
        const migratedProject = typeof entity.project === 'string'
          ? entity.project.trim().toLowerCase().normalize('NFC') || null
          : null;
        // Use the entity's timestamps if available (from JSONL files written after Phase 4),
        // otherwise fall back to the sentinel value for legacy data
        const entityUpdatedAt = entity.updatedAt || ENTITY_TIMESTAMP_SENTINEL;
        const entityCreatedAt = entity.createdAt || ENTITY_TIMESTAMP_SENTINEL;
        insertEntity.run(entity.name, entity.entityType, migratedProject, entityUpdatedAt, entityCreatedAt);
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
   * Finds all active observations without embeddings and generates them.
   * Runs in batches of 100 with event loop yields between batches
   * so the server stays responsive to MCP requests during the sweep.
   * Called once after the embedding model finishes loading.
   */
  private async runEmbeddingSweep(): Promise<void> {
    if (!this.vecTableExists || this.embeddingPipeline.state.status !== 'ready') return;

    const BATCH_SIZE = 100;
    let totalEmbedded = 0;

    while (true) {
      // If the database was closed (e.g., during shutdown), stop the sweep
      if (!this.db) break;

      // Find active observations missing from vec_observations.
      // LEFT JOIN on the TEXT observation_id column (cast to match observations.id).
      const batch = this.db.prepare(`
        SELECT o.id, o.content FROM observations o
        LEFT JOIN vec_observations v ON CAST(v.observation_id AS INTEGER) = o.id
        WHERE v.observation_id IS NULL AND o.superseded_at = ''
        ORDER BY o.id
        LIMIT ?
      `).all(BATCH_SIZE) as { id: number; content: string }[];

      if (batch.length === 0) break;

      // Generate embeddings for this batch
      const results = await this.embeddingPipeline.embedBatch(batch);

      // Insert embeddings into vec_observations.
      // observation_id is stored as TEXT (String(id)) because vec0 v0.1.9
      // doesn't support explicit INTEGER PRIMARY KEY values on insert.
      if (results.length > 0 && this.db) {
        const insert = this.db.prepare(
          'INSERT INTO vec_observations (embedding, observation_id) VALUES (?, ?)'
        );
        const txn = this.db.transaction(() => {
          for (const { id, embedding } of results) {
            insert.run(
              Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
              String(id)
            );
          }
        });
        txn();
        totalEmbedded += results.length;
      }

      // Yield the event loop so the server can handle MCP requests between batches
      await new Promise(resolve => setImmediate(resolve));

      // If the model failed during this batch, stop the sweep
      if (this.embeddingPipeline.state.status !== 'ready') break;
    }

    if (totalEmbedded > 0) {
      console.error(`Vector search: embedded ${totalEmbedded} observations during sweep`);
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

    // Capture the current time once for all entities in this batch (consistent timestamps)
    const now = new Date().toISOString();

    // Prepared statements are compiled once and reused -- faster than db.exec() per row
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, ?, ?, ?)'
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
        const info = insertEntity.run(e.name, e.entityType, normalizedProject, now, now);
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

        created.push({ name: e.name, entityType: e.entityType, observations, project: normalizedProject, updatedAt: now, createdAt: now });
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
    // Prepared statement to bump updated_at when observations are added to an entity
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ? WHERE id = ?'
    );

    const results: AddObservationResult[] = [];

    const txn = this.db.transaction(() => {
      for (const o of observations) {
        const row = findEntity.get(o.entityName) as { id: number } | undefined;
        if (!row) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }

        // Capture a single timestamp for all observations in this entity's batch
        // so observation.createdAt and entity.updated_at are consistent
        const now = new Date().toISOString();
        const addedObservations: Observation[] = [];
        for (const content of o.contents) {
          const obs = { content, createdAt: now };
          const info = insertObs.run(row.id, obs.content, obs.createdAt);
          if (info.changes > 0) {
            addedObservations.push(obs);
          }
        }

        // Bump the entity's updated_at if any observations were actually added
        if (addedObservations.length > 0) {
          updateTimestamp.run(now, row.id);
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
      `DELETE FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
    );
    // Prepared statement to bump updated_at when observations are removed from an entity
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ? WHERE id = ?'
    );

    const txn = this.db.transaction(() => {
      for (const d of deletions) {
        const row = findEntity.get(d.entityName) as { id: number } | undefined;
        if (!row) continue;
        for (const content of d.contents) {
          delObs.run(row.id, content);
        }
        // Bump updated_at — the entity's content has changed
        updateTimestamp.run(new Date().toISOString(), row.id);
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
   * Atomically supersedes observations: retires the old content and inserts the new.
   * The old observation's superseded_at is set to the current timestamp (marking it retired).
   * A new observation row is created with the new content and superseded_at = '' (active).
   * All operations run in a single transaction -- all succeed or all roll back.
   *
   * @param supersessions - Array of { entityName, oldContent, newContent }
   * @throws Error if any entity is not found or oldContent doesn't match an active observation
   */
  async supersedeObservations(supersessions: SupersedeInput[]): Promise<void> {
    // Prepared statement to find an entity's ID by name
    const findEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    // Find the active observation matching this entity + content
    const findActiveObs = this.db.prepare(
      `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
    );
    // Mark the old observation as superseded (set superseded_at to current timestamp)
    const supersedeObs = this.db.prepare(
      `UPDATE observations SET superseded_at = ? WHERE id = ?`
    );
    // Insert the replacement observation as active (superseded_at defaults to '')
    const insertObs = this.db.prepare(
      `INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`
    );
    // Bump entity's updated_at timestamp
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ? WHERE id = ?'
    );

    // better-sqlite3 transactions are synchronous -- the outer async wrapper
    // satisfies the GraphStore interface contract
    const txn = this.db.transaction(() => {
      const now = new Date().toISOString();

      for (const s of supersessions) {
        // Look up the entity by name
        const entityRow = findEntity.get(s.entityName) as { id: number } | undefined;
        if (!entityRow) {
          throw new Error(`Entity with name ${s.entityName} not found`);
        }

        // Find the active observation to supersede
        const obsRow = findActiveObs.get(entityRow.id, s.oldContent) as { id: number } | undefined;
        if (!obsRow) {
          throw new Error(
            `Active observation "${s.oldContent}" not found on entity "${s.entityName}"`
          );
        }

        // Retire the old observation by setting its superseded_at timestamp
        supersedeObs.run(now, obsRow.id);

        // Insert the replacement (INSERT OR IGNORE: if newContent already exists
        // as an active observation on this entity, skip -- idempotent)
        insertObs.run(entityRow.id, s.newContent, now);

        // Bump updated_at so the entity surfaces in recency-ordered queries
        updateTimestamp.run(now, entityRow.id);
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
  private buildEntities(entityRows: { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id?: number }[]): Entity[] {
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
        WHERE e.name IN (${placeholders}) AND o.superseded_at = ''
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
      updatedAt: e.updated_at,
      createdAt: e.created_at,
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
   * Returns the knowledge graph, optionally filtered by project, with cursor-based pagination.
   * Entities are sorted by most recently updated first (updated_at DESC, id DESC).
   * When pagination is omitted (undefined), returns ALL matching entities -- this preserves
   * backward compatibility for tests and migration code that call readGraph() directly.
   * When pagination is provided, applies keyset pagination with limit+1 fetch to detect next page.
   *
   * @param projectId - Optional project name to filter by; normalized to lowercase/trimmed
   * @param pagination - Optional cursor and limit for paginated results; omit for all results
   * @returns PaginatedKnowledgeGraph with entities, relations, nextCursor, and totalCount
   */
  async readGraph(projectId?: string, pagination?: PaginationParams): Promise<PaginatedKnowledgeGraph> {
    const fingerprint = readGraphFingerprint(projectId);

    // When pagination is undefined, return all results (backward compat).
    // When provided, clamp the limit to valid range and optionally decode cursor.
    const isPaginated = pagination !== undefined;
    const limit = isPaginated ? clampLimit(pagination.limit) : undefined;

    let cursor: CursorPayload | undefined;
    if (pagination?.cursor) {
      cursor = decodeCursor(pagination.cursor, fingerprint);
    }

    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

    // Build the WHERE clause dynamically based on project filter and cursor position.
    // Conditions array collects SQL fragments; params array collects bound values.
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (normalizedProject) {
      // Include entities belonging to this project OR global entities (project IS NULL)
      conditions.push('(project = ? OR project IS NULL)');
      params.push(normalizedProject);
    }

    if (cursor) {
      // Keyset condition: fetch entities "after" the cursor position in DESC order.
      // An entity comes after the cursor if its updated_at is earlier (less than),
      // or if updated_at is the same but its id is smaller (tiebreaker).
      conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(cursor.u, cursor.u, cursor.i);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // When paginated, fetch limit+1 rows to detect if there's a next page without a separate COUNT query.
    // When not paginated, omit LIMIT entirely to return all rows.
    const limitClause = limit !== undefined ? `LIMIT ?` : '';
    const queryParams = limit !== undefined ? [...params, limit + 1] : params;

    const entityRows = this.db.prepare(`
      SELECT name, entity_type AS entityType, project, updated_at, created_at, id
      FROM entities
      ${whereClause}
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `).all(...queryParams) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number }[];

    // Determine if there's a next page (only possible when paginated)
    let hasMore = false;
    let pageRows: typeof entityRows;
    if (limit !== undefined) {
      // If we got more rows than the limit, there's another page
      hasMore = entityRows.length > limit;
      pageRows = hasMore ? entityRows.slice(0, limit) : entityRows;
    } else {
      // Not paginated -- all rows are the page
      pageRows = entityRows;
    }

    // Build the next cursor from the last entity on this page
    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor({ u: last.updated_at, i: last.id, n: last.name, q: fingerprint });
    }

    // Count total matching entities. When unpaginated, we already have all rows,
    // so skip the COUNT query and use the array length directly.
    let totalCount: number;
    if (isPaginated) {
      const countConditions: string[] = [];
      const countParams: (string | number)[] = [];
      if (normalizedProject) {
        countConditions.push('(project = ? OR project IS NULL)');
        countParams.push(normalizedProject);
      }
      const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
      totalCount = (this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM entities ${countWhere}`
      ).get(...countParams) as { cnt: number }).cnt;
    } else {
      totalCount = pageRows.length;
    }

    // Build full Entity objects with observations from the page rows
    const entities = this.buildEntities(pageRows);

    // Relations: when paginated or project-filtered, only include relations where
    // both endpoints are in the current page's entity set.
    // When not paginated and not project-filtered, return all relations (backward compat).
    if (isPaginated || projectId) {
      const entityNames = new Set(pageRows.map(e => e.name));
      const connectedRelations = this.getConnectedRelations(pageRows.map(e => e.name));
      const filteredRelations = connectedRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations, nextCursor, totalCount };
    }

    // Unscoped + unpaginated: return all relations (backward compatible with original behavior)
    const relations = this.db.prepare(
      'SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType FROM relations'
    ).all() as Relation[];

    return { entities, relations, nextCursor, totalCount };
  }

  /**
   * Searches entities by case-insensitive substring match against name, entityType,
   * or observation content. Results are paginated by most recently updated first.
   * When pagination is omitted (undefined), returns ALL matching entities -- backward compat.
   *
   * SQLite's LIKE is case-insensitive for ASCII characters (A-Z) by default.
   * For full Unicode case folding, FTS5 with ICU would be needed.
   *
   * Uses a subquery pattern to find matching entity IDs first (via LEFT JOIN + DISTINCT),
   * then applies keyset pagination on the outer query. This avoids the
   * DISTINCT + ORDER BY interaction issue that would occur with a flat query.
   *
   * @param query - Case-insensitive substring to search for
   * @param projectId - Optional project name; only returns entities in this project or global
   * @param pagination - Optional cursor and limit for paginated results; omit for all results
   * @returns PaginatedKnowledgeGraph with matching entities, relations, nextCursor, and totalCount
   */
  async searchNodes(query: string, projectId?: string, pagination?: PaginationParams): Promise<PaginatedKnowledgeGraph> {
    const fingerprint = searchNodesFingerprint(projectId, query);

    // When pagination is undefined, return all results (backward compat).
    const isPaginated = pagination !== undefined;
    const limit = isPaginated ? clampLimit(pagination.limit) : undefined;

    let cursor: CursorPayload | undefined;
    if (pagination?.cursor) {
      cursor = decodeCursor(pagination.cursor, fingerprint);
    }

    // Escape LIKE wildcards so user input like "100%" matches literally
    const escaped = escapeLike(query);
    const pattern = `%${escaped}%`;
    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

    // Use a CTE (Common Table Expression) to compute the set of matching entity IDs
    // once, then reuse it for both pagination and total count. This avoids running the
    // expensive LEFT JOIN + 3 LIKE patterns twice (was issue #50).
    // SQLite materializes CTEs referenced multiple times, so matched_ids is computed once.
    const cteParams: (string | number)[] = [pattern, pattern, pattern];
    let cteSql = `
      WITH matched_ids AS (
        SELECT DISTINCT e2.id FROM entities e2
        LEFT JOIN observations o ON o.entity_id = e2.id AND o.superseded_at = ''
        WHERE (e2.name LIKE ? ESCAPE '\\' OR e2.entity_type LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\')
    `;

    if (normalizedProject) {
      cteSql += ' AND (e2.project = ? OR e2.project IS NULL)';
      cteParams.push(normalizedProject);
    }
    cteSql += ')';

    // Build WHERE conditions for the outer query on the entities table.
    // id IN (matched_ids) restricts to search matches; cursor condition paginates.
    const conditions: string[] = ['id IN (SELECT id FROM matched_ids)'];
    const params: (string | number)[] = [...cteParams];

    // Cursor condition for keyset pagination (applied to outer query)
    if (cursor) {
      conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(cursor.u, cursor.u, cursor.i);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // When paginated, fetch limit+1 to detect next page; otherwise fetch all
    const limitClause = limit !== undefined ? `LIMIT ?` : '';
    const queryParams = limit !== undefined ? [...params, limit + 1] : params;

    // The scalar subquery (SELECT COUNT(*) FROM matched_ids) is embedded in the SELECT
    // list so the total count comes back with each row at zero extra cost — the CTE
    // is already materialized. When unpaginated, we skip the count (use array length).
    const countColumn = isPaginated
      ? ', (SELECT COUNT(*) FROM matched_ids) AS total_count'
      : '';

    const entityRows = this.db.prepare(`
      ${cteSql}
      SELECT name, entity_type AS entityType, project, updated_at, created_at, id
        ${countColumn}
      FROM entities
      ${whereClause}
      ORDER BY updated_at DESC, id DESC
      ${limitClause}
    `).all(...queryParams) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number; total_count?: number }[];

    // Determine if there's a next page
    let hasMore = false;
    let pageRows: typeof entityRows;
    if (limit !== undefined) {
      hasMore = entityRows.length > limit;
      pageRows = hasMore ? entityRows.slice(0, limit) : entityRows;
    } else {
      pageRows = entityRows;
    }

    // Build next cursor from the last entity on this page
    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor({ u: last.updated_at, i: last.id, n: last.name, q: fingerprint });
    }

    // Total count: when paginated, extract from the first row's total_count column
    // (embedded via the CTE scalar subquery). When unpaginated, use array length.
    // If no rows matched, total_count is absent so fall back to 0.
    const totalCount = isPaginated
      ? (pageRows.length > 0 ? pageRows[0].total_count! : 0)
      : pageRows.length;

    // Build full Entity objects with observations
    const entities = this.buildEntities(pageRows);

    // Relations: when paginated or project-filtered, both endpoints must be in the page.
    // When not paginated and not project-filtered, use OR logic (backward compat).
    const entityNames = new Set(pageRows.map(e => e.name));
    if (isPaginated || projectId) {
      const allRelations = this.getConnectedRelations(pageRows.map(e => e.name));
      const filteredRelations = allRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations, nextCursor, totalCount };
    }

    // Unscoped + unpaginated: OR logic for relations (at least one endpoint matches)
    const relations = this.getConnectedRelations(pageRows.map(e => e.name));
    return { entities, relations, nextCursor, totalCount };
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

    // Chunk the IN clause to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (999).
    // Safe via MCP (Zod .max(100) on names array) but needed for direct callers with 900+ names.
    type EntityRow = { name: string; entityType: string; project: string | null; updated_at: string; created_at: string };
    let entityRows: EntityRow[] = [];
    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

    for (let i = 0; i < names.length; i += CHUNK_SIZE) {
      const chunk = names.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      if (normalizedProject) {
        const rows = this.db.prepare(
          `SELECT name, entity_type AS entityType, project, updated_at, created_at FROM entities WHERE name IN (${placeholders}) AND (project = ? OR project IS NULL)`
        ).all(...chunk, normalizedProject) as EntityRow[];
        entityRows.push(...rows);
      } else {
        const rows = this.db.prepare(
          `SELECT name, entity_type AS entityType, project, updated_at, created_at FROM entities WHERE name IN (${placeholders})`
        ).all(...chunk) as EntityRow[];
        entityRows.push(...rows);
      }
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
