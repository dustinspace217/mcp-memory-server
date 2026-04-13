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
  type RelationInput,
  type InvalidateRelationInput,
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
  type SimilarObservation,
  type SkippedEntity,
  type CreateEntitiesResult,
  type PaginationParams,
  type PaginatedKnowledgeGraph,
  type SupersedeInput,
  type SetObservationMetadataInput,
  type ContextLayersResult,
  type ContextLayerObservation,
  type SummaryResult,
  type SummaryObservation,
  type SummaryEntity,
  type EntityTimelineResult,
  type TimelineObservation,
  type TimelineRelation,
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
import { normalizeEntityName } from './normalize-name.js';
import { checkAndEvict, type EvictionResult } from './evict.js';

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

// How many write operations between eviction checks. The spec suggests ~1000.
// Each check is cheap (just a statSync on the DB file) so this can be low.
const EVICTION_CHECK_INTERVAL = 1000;

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

  /** Set to true when SIGTERM/SIGINT received. Tells the embedding sweep to stop. */
  private shuttingDown = false;

  /** Counts write operations since the last eviction check. Resets after each check. */
  private writesSinceLastEvictionCheck = 0;

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

    // === Create tables with current (v4) schema ===
    // IF NOT EXISTS makes this safe for existing databases. New databases get the
    // latest schema directly; existing databases get migrated below.
    // entities.name has a UNIQUE constraint so relations can reference it.
    // project is nullable: NULL means global (visible to all projects).
    // updated_at/created_at track entity-level timestamps (sentinel for legacy data).
    // observations.superseded_at: '' = active, ISO timestamp = retired.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        project     TEXT,
        updated_at  TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
        created_at  TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}'
      );
      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        superseded_at TEXT NOT NULL DEFAULT '',
        UNIQUE(entity_id, content, superseded_at)
      );
      CREATE TABLE IF NOT EXISTS relations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        relation_type TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
        superseded_at TEXT NOT NULL DEFAULT '',
        UNIQUE(from_entity, to_entity, relation_type, superseded_at)
      );
    `);

    // === Schema version tracking ===
    // Instead of checking pragma('table_info') for each column, we track a single
    // integer version. Makes migrations deterministic and future-proof.
    // Version history:
    //   1 = base schema (entities, observations, relations — no project, no timestamps)
    //   2 = added project column to entities
    //   3 = added updated_at, created_at to entities (with backfill from observations)
    //   4 = added superseded_at to observations (table rebuild for UNIQUE constraint change)
    //   5 = added created_at, superseded_at to relations (table rebuild for temporal relations)
    //   6 = added importance, context_layer, memory_type columns to observations (Phase A)
    //   7 = added superseded_at to entities + partial unique index on active rows (soft-delete)
    //   8 = added normalized_name to entities + rewrote relations to reference normalized form
    //       (Layer 1 entity name normalization — collapses surface variants under one identity)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
    `);

    // Read the current version. If the table is empty (first run or existing DB
    // predating version tracking), detect current state from column existence.
    let currentVersion: number;
    const versionRow = this.db.prepare(
      'SELECT version FROM schema_version'
    ).get() as { version: number } | undefined;

    if (versionRow) {
      currentVersion = versionRow.version;
    } else {
      // Detect version from existing schema for databases that predate version tracking.
      // pragma('table_info') returns column metadata for each table.
      const entityCols = this.db.pragma('table_info(entities)') as { name: string }[];
      const obsCols = this.db.pragma('table_info(observations)') as { name: string }[];
      const relCols = this.db.pragma('table_info(relations)') as { name: string }[];

      const hasProject = entityCols.some(c => c.name === 'project');
      const hasUpdatedAt = entityCols.some(c => c.name === 'updated_at');
      const hasObsSupersededAt = obsCols.some(c => c.name === 'superseded_at');
      const hasRelSupersededAt = relCols.some(c => c.name === 'superseded_at');

      if (hasRelSupersededAt) {
        currentVersion = 5;
      } else if (hasObsSupersededAt) {
        currentVersion = 4;
      } else if (hasUpdatedAt) {
        currentVersion = 3;
      } else if (hasProject) {
        currentVersion = 2;
      } else if (entityCols.length > 0) {
        // entities table exists but has no project column — v1 schema
        currentVersion = 1;
      } else {
        // Fresh database — tables were just created with the full v5 schema above
        currentVersion = 5;
      }

      // Seed the version table so future startups skip the pragma detection.
      // id=1 is enforced by CHECK(id = 1) — only one row can ever exist.
      this.db.prepare('INSERT INTO schema_version (id, version) VALUES (1, ?)').run(currentVersion);
    }

    // === Run sequential migrations ===
    // Each migration checks "if version < N", upgrades, and bumps the version.
    // Only runs for databases that predate the target version.

    if (currentVersion < 2) {
      // v1 → v2: add project column to entities
      this.db.exec(`
        ALTER TABLE entities ADD COLUMN project TEXT;
        CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
      `);
      this.db.prepare('UPDATE schema_version SET version = 2').run();
      currentVersion = 2;
    }

    if (currentVersion < 3) {
      // v2 → v3: add entity timestamps with backfill from observation data.
      // Wrapped in an explicit transaction so a crash between ALTER and backfill
      // doesn't leave entities with permanent sentinel timestamps.
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE entities ADD COLUMN updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}';
          ALTER TABLE entities ADD COLUMN created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}';
        `);
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
      this.db.prepare('UPDATE schema_version SET version = 3').run();
      currentVersion = 3;
    }

    if (currentVersion < 4) {
      // v3 → v4: add superseded_at to observations (table rebuild).
      // SQLite can't ALTER a UNIQUE constraint, so we rebuild the table.
      // superseded_at = '' means active; ISO timestamp means retired.
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
      this.db.prepare('UPDATE schema_version SET version = 4').run();
      currentVersion = 4;
    }

    if (currentVersion < 5) {
      // Migration 4 → 5: add temporal fields to relations (table rebuild).
      // Mirrors the observations pattern: superseded_at = '' means active,
      // ISO timestamp means the relation has been invalidated.
      // created_at tracks when the relation was established.
      // UNIQUE constraint includes superseded_at so the same triple can exist
      // with multiple time windows (active after re-creation post-invalidation).
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE relations_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
            to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
            relation_type TEXT NOT NULL,
            created_at    TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
            superseded_at TEXT NOT NULL DEFAULT '',
            UNIQUE(from_entity, to_entity, relation_type, superseded_at)
          );
          INSERT INTO relations_new (id, from_entity, to_entity, relation_type, created_at, superseded_at)
            SELECT id, from_entity, to_entity, relation_type, '${ENTITY_TIMESTAMP_SENTINEL}', '' FROM relations;
          DROP TABLE relations;
          ALTER TABLE relations_new RENAME TO relations;
        `);
      })();
      this.db.prepare('UPDATE schema_version SET version = 5').run();
      currentVersion = 5;
    }

    if (currentVersion < 6) {
      // Migration 5 to 6: add observation metadata columns for v1.1 features.
      // importance: REAL 1.0-5.0 score (default 3.0 = medium). Used by get_summary
      //   and get_context_layers to prioritize which observations surface.
      // context_layer: TEXT nullable. NULL = L2 (on-demand, the default).
      //   'L0' = always loaded (about 100 token budget, core identity/rules).
      //   'L1' = loaded at session start (about 800 token budget, active work/decisions).
      // memory_type: TEXT nullable. NULL = unclassified. Free-form tag classifying
      //   the nature of the observation (e.g., 'decision', 'preference', 'fact',
      //   'problem', 'milestone', 'emotional'). Enables type-filtered queries.
      // All three are simple column additions with no table rebuild or data backfill.
      // Wrapped in a transaction so a crash between ALTER TABLEs doesn't leave the
      // schema half-migrated (columns added but version not bumped → next startup
      // retries and hits "duplicate column" errors).
      this.db.transaction(() => {
        this.db.prepare(`ALTER TABLE observations ADD COLUMN importance REAL NOT NULL DEFAULT 3.0`).run();
        this.db.prepare(`ALTER TABLE observations ADD COLUMN context_layer TEXT DEFAULT NULL`).run();
        this.db.prepare(`ALTER TABLE observations ADD COLUMN memory_type TEXT DEFAULT NULL`).run();
        this.db.prepare('UPDATE schema_version SET version = 6').run();
      })();
      currentVersion = 6;
    }

    if (currentVersion < 7) {
      // Migration 6 to 7: soft-delete on entities + drop FK from relations.
      //
      // === Part 1: entities table rebuild (add superseded_at + partial unique index) ===
      // Adds superseded_at column to entities. Empty string sentinel = active row;
      // ISO timestamp = the entity has been soft-deleted (logically removed).
      // Mirrors the same pattern observations and relations got in v3→v4 and v4→v5.
      //
      // Why a partial unique index instead of UNIQUE(name) or UNIQUE(name, superseded_at):
      //   - UNIQUE(name) blocks re-creation after soft-delete.
      //   - UNIQUE(name, superseded_at) allows multiple soft-deleted rows with the same
      //     name but blocks re-creation of an active row after the first soft-delete
      //     (because two active rows would both have superseded_at='').
      //   - A partial unique index on (name) WHERE superseded_at='' enforces uniqueness
      //     ONLY among active rows, allowing a clean delete-then-create cycle while
      //     preserving full history.
      //
      // === Part 2: relations table rebuild (drop FK references) ===
      // The relations table previously had FK references to entities(name) with
      // ON DELETE CASCADE / ON UPDATE CASCADE. SQLite's FK validator requires the
      // referenced column to have a *full* UNIQUE constraint or PRIMARY KEY. Our
      // new partial unique index on entities(name) WHERE superseded_at='' does NOT
      // qualify — SQLite raises "foreign key mismatch" at PREPARE time on any
      // statement that touches relations once entities loses its full UNIQUE.
      //
      // The FK is also obsolete with soft-delete:
      //   - Hard-delete is gone (deleteEntities is now a soft-update).
      //   - Soft-CASCADE on entity delete is implemented in application code via
      //     atomic same-timestamp updates (see deleteEntities()).
      //   - createRelations() validates endpoint existence at the application layer.
      //
      // FK handling during the rebuild: relations referenced entities(name) with
      // ON DELETE/UPDATE CASCADE. We toggle foreign_keys OFF around the swap so
      // DROP TABLE entities doesn't cascade. After both rebuilds, FK is back ON
      // but relations no longer has any FK constraint to enforce.
      //
      // Each DDL statement uses this.db.prepare(...).run() individually rather than
      // a single multi-statement string — same workaround as in
      // __tests__/migration-validation.test.ts (see comment at line 451).
      this.withForeignKeysDisabled(() => {
        this.db.transaction(() => {
          // Part 1: rebuild entities
          this.db.prepare(`
            CREATE TABLE entities_new (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              name          TEXT NOT NULL,
              entity_type   TEXT NOT NULL,
              project       TEXT,
              updated_at    TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
              created_at    TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
              superseded_at TEXT NOT NULL DEFAULT ''
            )
          `).run();
          this.db.prepare(`
            INSERT INTO entities_new (id, name, entity_type, project, updated_at, created_at, superseded_at)
            SELECT id, name, entity_type, project, updated_at, created_at, '' FROM entities
          `).run();
          this.db.prepare(`DROP TABLE entities`).run();
          this.db.prepare(`ALTER TABLE entities_new RENAME TO entities`).run();
          this.db.prepare(`
            CREATE UNIQUE INDEX idx_entities_name_active ON entities(name) WHERE superseded_at = ''
          `).run();

          // Part 2: rebuild relations to drop the FK references to entities(name).
          // New schema preserves all columns and the UNIQUE composite, but the
          // from_entity / to_entity columns are now plain TEXT with no FK clause.
          this.db.prepare(`
            CREATE TABLE relations_new (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              from_entity   TEXT NOT NULL,
              to_entity     TEXT NOT NULL,
              relation_type TEXT NOT NULL,
              created_at    TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
              superseded_at TEXT NOT NULL DEFAULT '',
              UNIQUE(from_entity, to_entity, relation_type, superseded_at)
            )
          `).run();
          this.db.prepare(`
            INSERT INTO relations_new (id, from_entity, to_entity, relation_type, created_at, superseded_at)
            SELECT id, from_entity, to_entity, relation_type, created_at, superseded_at FROM relations
          `).run();
          this.db.prepare(`DROP TABLE relations`).run();
          this.db.prepare(`ALTER TABLE relations_new RENAME TO relations`).run();

          this.db.prepare('UPDATE schema_version SET version = 7').run();
        })();
      });
      currentVersion = 7;
    }

    if (currentVersion < 8) {
      // Migration 7 → 8: entity name normalization (Layer 1).
      //
      // Adds a `normalized_name` column to entities. The column is the
      // IDENTITY KEY: a partial unique index on normalized_name (where
      // superseded_at = '') collapses surface variants like 'dustin-space',
      // 'dustin_space', 'Dustin Space' into a single entity. The original
      // `name` column is preserved for display (Option B / hybrid).
      //
      // Relations rewrite: relations.from_entity / to_entity previously held
      // the display form of names. After this migration they hold the
      // normalized form, so identity matching at the relations layer goes
      // through normalized_name. Read paths JOIN entities to translate
      // back to display names for output.
      //
      // Collision detection: if two ACTIVE entities normalize to the same
      // identity key, the migration ABORTS the transaction with a structured
      // error listing the colliding pairs. Resolution requires manual
      // cleanup (rename or soft-delete one of each pair) before retry.
      //
      // The live MCP memory DB had 0 collisions on 142 entities at the
      // time this migration was written (verified 2026-04-11).
      //
      // Each DDL statement uses this.db.prepare(...).run() individually
      // rather than a single multi-statement string -- same workaround
      // documented in the v6→v7 block above.
      //
      // foreign_keys is toggled OFF for the duration of the migration. The
      // v6→v7 migration was supposed to drop the FK from relations to
      // entities(name), but some historical databases may have arrived at
      // schema_version=7 while still carrying the FK (e.g. schema_version
      // manipulated directly, or a fresh `CREATE TABLE IF NOT EXISTS` that
      // re-created the relations table with the inline REFERENCES clause
      // before the v6→v7 rebuild path ran). With the FK still present,
      // rewriting relations.from_entity / to_entity to the normalized form
      // (which no longer matches entities.name) fails with
      // "foreign key mismatch". Turning FKs off sidesteps that; any
      // integrity we need is enforced explicitly by the orphan check in
      // Step 5 below. Pragma runs OUTSIDE the transaction (SQLite does not
      // allow `PRAGMA foreign_keys` inside an open transaction).
      this.withForeignKeysDisabled(() => {
        this.db.transaction(() => {
          // Step 1: add the normalized_name column with empty default so
        // existing rows satisfy NOT NULL until the backfill runs.
        this.db.prepare(`ALTER TABLE entities ADD COLUMN normalized_name TEXT NOT NULL DEFAULT ''`).run();

        // Step 2: backfill normalized_name for every existing row.
        // SQLite has no built-in NFC/lowercase/separator-strip helper, so
        // we SELECT all rows and run normalizeEntityName() in JS.
        // We backfill BOTH active and soft-deleted rows -- the partial
        // unique index only constrains active rows, but historical rows
        // need the column populated for any future read that filters on it.
        const allEntities = this.db.prepare(
          `SELECT id, name FROM entities`
        ).all() as { id: number; name: string }[];
        const updateNormalized = this.db.prepare(
          `UPDATE entities SET normalized_name = ? WHERE id = ?`
        );
        for (const row of allEntities) {
          // normalizeEntityName throws on empty/invalid input. Existing
          // rows should never be empty (createEntities validation has
          // always required non-empty names), but if it happens the
          // throw aborts the transaction and surfaces a clean error.
          const normalized = normalizeEntityName(row.name);
          updateNormalized.run(normalized, row.id);
        }

        // Step 3: collision check among ACTIVE rows only.
        // Two active entities with different display forms but the same
        // normalized form would violate the upcoming partial unique
        // index. Detect them now so the error is actionable instead of
        // an opaque SQLITE_CONSTRAINT failure on index creation.
        // JSON_GROUP_ARRAY produces a proper JSON array of colliding names,
        // avoiding the ambiguity of a delimited string (display names could
        // contain any plain-text separator character).
        const collisions = this.db.prepare(`
          SELECT normalized_name,
                 JSON_GROUP_ARRAY(name) AS display_names_json,
                 COUNT(*) AS cnt
          FROM entities
          WHERE superseded_at = ''
          GROUP BY normalized_name
          HAVING COUNT(*) > 1
        `).all() as { normalized_name: string; display_names_json: string; cnt: number }[];

        if (collisions.length > 0) {
          const lines = collisions.map(c => {
            const names = JSON.parse(c.display_names_json) as string[];
            return `  - [${names.map(n => `"${n}"`).join(', ')}] all normalize to "${c.normalized_name}"`;
          });
          throw new Error(
            `v7→v8 migration aborted: ${collisions.length} entity name collision(s) detected.\n` +
            `Resolve manually before retrying (rename or soft-delete one of each pair).\n` +
            lines.join('\n')
          );
        }

        // Step 4: rewrite relations.from_entity / to_entity from display
        // form to normalized form. Each relation row's from/to value is
        // looked up in entities (by name) and replaced with the
        // normalized_name of that entity.
        //
        // The WHERE EXISTS guards against orphan relations (rows whose
        // from/to references no current entity). Orphans should not
        // exist after the v5→v7 schema work, but the guard prevents
        // them from being silently nulled here.
        this.db.prepare(`
          UPDATE relations
          SET from_entity = (
            SELECT normalized_name FROM entities WHERE entities.name = relations.from_entity
          )
          WHERE EXISTS (
            SELECT 1 FROM entities WHERE entities.name = relations.from_entity
          )
        `).run();
        this.db.prepare(`
          UPDATE relations
          SET to_entity = (
            SELECT normalized_name FROM entities WHERE entities.name = relations.to_entity
          )
          WHERE EXISTS (
            SELECT 1 FROM entities WHERE entities.name = relations.to_entity
          )
        `).run();

        // Step 5: verify post-rewrite FK integrity at the application
        // layer. Every relations.from_entity / to_entity should now
        // resolve to an entities.normalized_name. Any that don't are
        // orphans -- the migration aborts so the database isn't left
        // in a half-translated state.
        const orphans = this.db.prepare(`
          SELECT id, from_entity, to_entity FROM relations
          WHERE from_entity NOT IN (SELECT normalized_name FROM entities)
             OR to_entity   NOT IN (SELECT normalized_name FROM entities)
        `).all() as { id: number; from_entity: string; to_entity: string }[];

        if (orphans.length > 0) {
          const sample = orphans.slice(0, 10).map(o =>
            `  - relation id=${o.id}: "${o.from_entity}" -> "${o.to_entity}"`
          );
          throw new Error(
            `v7→v8 migration aborted: ${orphans.length} relation(s) reference non-existent entity names after rewrite.\n` +
            `This indicates pre-existing FK orphans in the relations table. ` +
            `Inspect and clean up before retrying.\n` +
            sample.join('\n') +
            (orphans.length > 10 ? `\n  ... and ${orphans.length - 10} more` : '')
          );
        }

        // Step 6: drop the v7 partial unique index on display name and
        // create the new one on normalized_name. The new index enforces
        // identity uniqueness among active rows.
        this.db.prepare(`DROP INDEX IF EXISTS idx_entities_name_active`).run();
        this.db.prepare(`
          CREATE UNIQUE INDEX idx_entities_normalized_active
            ON entities(normalized_name) WHERE superseded_at = ''
        `).run();

          this.db.prepare('UPDATE schema_version SET version = 8').run();
        })();
      });
      currentVersion = 8;
    }

    if (currentVersion < 9) {
      // Migration 8 → 9: eviction infrastructure — tombstoned_at + last_accessed_at.
      //
      // Adds columns for the four-tier degradation chain (§12 of the v1.1 design spec):
      //   Active → Superseded → Tombstoned → Hard-deleted
      //
      // - `entities.tombstoned_at`: empty string = not tombstoned, ISO timestamp = content stripped.
      //   When tombstoned, the entity skeleton (name, type, timestamps) is preserved but
      //   all its observations have their content set to '' and their vec embeddings removed.
      // - `entities.last_accessed_at`: tracks intentional access (search_nodes, open_nodes,
      //   entity_timeline, any write). read_graph (bulk) does NOT update this. Used by the
      //   LRU shield: entities accessed within 6 months are protected from eviction.
      //   Initialized to updated_at so existing entities start with a reasonable access time.
      // - `observations.tombstoned_at`: mirrors entity tombstoning at the observation level.
      // - `relations.tombstoned_at`: mirrors entity tombstoning at the relation level.
      //
      // Each ALTER TABLE is a separate statement (SQLite limitation: one ALTER per statement).
      this.db.transaction(() => {
        // Entities: add tombstoned_at and last_accessed_at.
        this.db.prepare(
          `ALTER TABLE entities ADD COLUMN tombstoned_at TEXT NOT NULL DEFAULT ''`
        ).run();
        this.db.prepare(
          `ALTER TABLE entities ADD COLUMN last_accessed_at TEXT NOT NULL DEFAULT ''`
        ).run();

        // Backfill last_accessed_at from updated_at so existing entities aren't immediately
        // eligible for eviction. Entities with sentinel timestamps ('0000-...') get the
        // sentinel — they'll be refreshed on first intentional access.
        this.db.prepare(
          `UPDATE entities SET last_accessed_at = updated_at`
        ).run();

        // Observations: add tombstoned_at.
        this.db.prepare(
          `ALTER TABLE observations ADD COLUMN tombstoned_at TEXT NOT NULL DEFAULT ''`
        ).run();

        // Relations: add tombstoned_at.
        this.db.prepare(
          `ALTER TABLE relations ADD COLUMN tombstoned_at TEXT NOT NULL DEFAULT ''`
        ).run();

        this.db.prepare('UPDATE schema_version SET version = 9').run();
      })();
      currentVersion = 9;
    }

    // === Indexes (idempotent, run on every startup) ===
    // idx_relations_to_entity: the UNIQUE composite index on relations has from_entity
    // as leftmost prefix, so from_entity IN (...) can use it. But to_entity IN (...)
    // in getConnectedRelations needs its own index to avoid full table scans.
    // Partial index on active relations only (superseded_at = '') since queries always filter.
    // Drop+recreate: v5 migration changed the schema, old non-partial index is stale.
    this.db.exec('DROP INDEX IF EXISTS idx_relations_to_entity;');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to_entity_active ON relations(to_entity) WHERE superseded_at = '';`);

    // Pagination indexes for keyset queries on (updated_at DESC, id DESC).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_project_updated ON entities(project, updated_at DESC, id DESC);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC, id DESC);');

    // Drop the single-column idx_entities_project — covered by composite idx_entities_project_updated.
    this.db.exec('DROP INDEX IF EXISTS idx_entities_project;');

    // Partial index on active observations — used by WHERE superseded_at = '' filters.
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

        // Startup consistency check: find stale embeddings and delete them.
        // Catches both truly orphaned vec rows (observation was CASCADE-deleted)
        // AND embeddings for superseded observations that should no longer be searchable.
        // Count and delete use the same NOT IN (active observations) predicate.
        const staleCount = (this.db.prepare(`
          SELECT COUNT(*) AS cnt FROM vec_observations
          WHERE CAST(observation_id AS INTEGER) NOT IN (
            SELECT id FROM observations WHERE superseded_at = ''
          )
        `).get() as { cnt: number }).cnt;

        if (staleCount > 0) {
          this.db.exec(`
            DELETE FROM vec_observations WHERE CAST(observation_id AS INTEGER) NOT IN (
              SELECT id FROM observations WHERE superseded_at = ''
            )
          `);
          console.error(`Vector search: cleaned up ${staleCount} stale/orphaned embeddings`);
        }

        // Start loading the embedding model in the background.
        // When ready, run the universal embedding sweep to generate embeddings
        // for any active observations that don't have one yet.
        // The sweep is async — .catch() prevents unhandled promise rejection
        // from crashing Node.js if the sweep hits a DB error (SQLITE_BUSY, disk full, etc.)
        this.embeddingPipeline.startLoading(() => {
          this.runEmbeddingSweep().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Embedding sweep failed: ${msg}`);
          });
        });

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `sqlite-vec extension not available (${process.arch}/${process.platform}): ${msg}. ` +
          `Vector search disabled. LIKE search remains functional.`
        );
      }
    }

    // --- Startup eviction check ---
    // Run one eviction check at startup in case the database grew past the cap while
    // the server was down. This is cheap (just a statSync) and only triggers actual
    // eviction work if the DB exceeds 90% of the configured cap.
    // Wrap in try/catch so an eviction bug doesn't prevent the server from starting.
    // A broken eviction sweep should degrade gracefully — the server is still usable,
    // just without size pressure relief until the bug is fixed. (Issue #72.)
    try {
      const startupEviction = checkAndEvict(this.db, this.dbPath);
      if (startupEviction.triggered) {
        console.error(
          `Startup eviction: hard-deleted ${startupEviction.hardDeleted} entities, ` +
          `tombstoned ${startupEviction.tombstoned} entities (DB size: ${(startupEviction.dbSize / 1_000_000).toFixed(1)} MB)`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Startup eviction failed (non-fatal): ${msg}`);
    }
  }

  /**
   * Imports a KnowledgeGraph (read from JSONL) into the SQLite database.
   * Runs in a single transaction -- rolls back on any error.
   * Uses INSERT OR IGNORE to tolerate duplicates in corrupted JSONL data.
   * Dangling relations (referencing non-existent entities) are silently skipped
   * via an explicit application-level check (the FK was dropped in v7).
   *
   * Note: does NOT call syncEmbedding() for migrated observations. This is intentional --
   * migration runs during init() before the embedding model starts loading (startLoading()
   * is called after migration). The universal embedding sweep catches all un-embedded
   * observations after the model is ready, regardless of how they were created.
   *
   * @param graph - KnowledgeGraph loaded from the JSONL file by JsonlStore.readGraph()
   */

  /**
   * Runs a callback with `PRAGMA foreign_keys = OFF`, restoring it to ON in a `finally`
   * block so it's restored even if the callback throws. SQLite doesn't allow toggling
   * this pragma inside an open transaction, so this wraps the toggle around the caller's
   * transaction, not inside it.
   *
   * Used by table-rebuild migrations (v6→v7, v7→v8) that DROP/RENAME tables with
   * historical FK references. Without the toggle, DROP TABLE entities would CASCADE
   * into the relations table.
   *
   * @param fn - Function to execute with FKs disabled. Typically wraps a
   *             `this.db.transaction(() => { ... })()` call.
   */
  private withForeignKeysDisabled(fn: () => void): void {
    this.db.pragma('foreign_keys = OFF');
    try {
      fn();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Updates `last_accessed_at` on one or more entities to the current timestamp.
   * Called by methods that represent intentional access: search_nodes, open_nodes,
   * entity_timeline, and all write operations. NOT called by read_graph (bulk) or
   * the eviction sweep (which uses raw SQL to avoid the observer effect — see §12
   * of the v1.1 design spec).
   *
   * Accepts entity IDs (integers) to avoid re-lookups. Uses IN-clause chunking
   * (same CHUNK_SIZE as openNodes) for large batches. Silently ignores empty input.
   *
   * @param entityIds - Array of entity row IDs to touch
   */
  private touchEntities(entityIds: number[]): void {
    if (entityIds.length === 0) return;
    const now = new Date().toISOString();
    // Deduplicate so we don't issue redundant updates for the same entity.
    const unique = [...new Set(entityIds)];
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      this.db.prepare(
        `UPDATE entities SET last_accessed_at = ? WHERE id IN (${placeholders}) AND superseded_at = ''`
      ).run(now, ...chunk);
    }
  }

  /**
   * Variant of touchEntities that accepts normalized entity names instead of IDs.
   * Used by methods where we have names but not IDs (e.g. searchNodes, openNodes).
   *
   * @param normalizedNames - Array of normalized entity names to touch
   */
  private touchEntitiesByName(normalizedNames: string[]): void {
    if (normalizedNames.length === 0) return;
    const now = new Date().toISOString();
    const unique = [...new Set(normalizedNames)];
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      const chunk = unique.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      this.db.prepare(
        `UPDATE entities SET last_accessed_at = ? WHERE normalized_name IN (${placeholders}) AND superseded_at = ''`
      ).run(now, ...chunk);
    }
  }

  /**
   * Increments the write counter and runs eviction if the interval threshold is reached.
   * Called at the end of every write method. The check itself is cheap — just a statSync
   * on the DB file to check size. Actual eviction only runs if the DB exceeds 90% of the
   * configured cap (default 1 GB).
   *
   * Eviction uses raw SQL through the db handle directly (via evict.ts), NOT through
   * any GraphStore method. This is the "observer effect" discipline from §12 of the
   * design spec — the eviction sweep must never update last_accessed_at while scanning.
   */
  private maybeRunEviction(): void {
    this.writesSinceLastEvictionCheck++;
    if (this.writesSinceLastEvictionCheck < EVICTION_CHECK_INTERVAL) return;
    this.writesSinceLastEvictionCheck = 0;

    // Wrap in try/catch so an eviction bug doesn't propagate through the user's
    // write operation. The user's data is already committed at this point — an
    // eviction failure would be confusing noise. Matches syncEmbedding's
    // fire-and-forget pattern. (Issue #72.)
    try {
      const result = checkAndEvict(this.db, this.dbPath);
      if (result.triggered) {
        console.error(
          `Eviction sweep: hard-deleted ${result.hardDeleted} entities, ` +
          `tombstoned ${result.tombstoned} entities (DB size: ${(result.dbSize / 1_000_000).toFixed(1)} MB)`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Eviction check failed (non-fatal): ${msg}`);
    }
  }

  private migrateFromJsonl(graph: KnowledgeGraph): void {
    // Prepared statements are compiled once and reused for every row in the transaction.
    // Schema v8 added normalized_name as the identity key — every entity insert must populate it.
    // last_accessed_at initialized to updated_at — migration data gets a reasonable starting point.
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, normalized_name, entity_type, project, updated_at, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // Look up the auto-assigned id after inserting. Goes through normalized_name +
    // active filter so a hypothetical re-run (after partial crash) finds the right row
    // even if a soft-deleted shadow exists for the same display name.
    const getEntityId = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // INSERT includes metadata columns — schema v6 guarantees they exist.
    // Legacy JSONL observations will have default values (3.0, null, null).
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // Relations store the NORMALIZED form for from_entity / to_entity (post-v8). The
    // JSONL file holds display names, so we normalize before insert.
    const insertRel = this.db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)'
    );

    // Track valid normalized names so we can skip dangling relations (no FK to enforce
    // this since v7 dropped the FK constraint on relations).
    const validNormalizedNames = new Set<string>();

    // db.transaction() wraps everything in BEGIN/COMMIT and auto-rolls-back on throw
    const txn = this.db.transaction(() => {
      for (const entity of graph.entities) {
        // INSERT OR IGNORE: if normalized_name already exists (duplicate or surface
        // variant in JSONL), the partial unique index drops the second one silently.
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
        // Compute the identity key. normalizeEntityName() throws on empty/separator-only
        // names — that throws out of the txn callback and rolls back the migration cleanly.
        const normalizedName = normalizeEntityName(entity.name);
        insertEntity.run(entity.name, normalizedName, entity.entityType, migratedProject, entityUpdatedAt, entityCreatedAt, entityUpdatedAt);
        const row = getEntityId.get(normalizedName) as { id: number } | undefined;
        if (!row) {
          // INSERT OR IGNORE skipped (collision with an earlier surface variant in
          // the same JSONL file). Log it so the operator sees what happened, and
          // skip the observations — they'd attach to the wrong row otherwise.
          console.error(`WARNING: Skipped duplicate entity during migration: "${entity.name}" (normalizes to "${normalizedName}")`);
          continue;
        }
        validNormalizedNames.add(normalizedName);
        for (const obs of entity.observations) {
          // obs is already a normalized Observation object (JsonlStore.readGraph() calls normalizeObservation).
          // Read metadata fields with defaults for legacy JSONL data that predates v1.1.
          insertObs.run(row.id, obs.content, obs.createdAt, obs.importance ?? 3.0, obs.contextLayer ?? null, obs.memoryType ?? null);
        }
      }
      for (const rel of graph.relations) {
        // Normalize the relation endpoints from display form (JSONL stores display)
        // to the identity form (post-v8 relations table stores normalized).
        const fromNorm = normalizeEntityName(rel.from);
        const toNorm = normalizeEntityName(rel.to);
        // Application-level dangling-relation check (replaces dropped FK constraint).
        if (!validNormalizedNames.has(fromNorm) || !validNormalizedNames.has(toNorm)) {
          console.error(`WARNING: Skipped dangling relation during migration: ${rel.from} -> ${rel.to} [${rel.relationType}] (entity not found)`);
          continue;
        }
        // INSERT OR IGNORE handles duplicate relations
        insertRel.run(fromNorm, toNorm, rel.relationType);
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
   * Signals the store to stop accepting new work and shut down gracefully.
   * The current embedding batch finishes, but no new batches start.
   * Call close() after this to release the database connection.
   */
  shutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Centralized helper for maintaining vec_observations in sync with observations.
   * All mutation paths (create, add, delete, supersede) call this after their
   * core transaction commits. Never throws -- embedding is best-effort.
   *
   * For 'delete': removes the embedding synchronously (can run inside or outside txn).
   * For 'upsert': generates embedding async, then inserts. Skips if model not ready.
   *
   * @param observationId - The observations.id to sync
   * @param content - The observation content text (only used for 'upsert')
   * @param action - 'upsert' to generate+insert embedding, 'delete' to remove it
   */
  private async syncEmbedding(
    observationId: number,
    content: string,
    action: 'upsert' | 'delete'
  ): Promise<void> {
    if (!this.vecTableExists) return;

    if (action === 'delete') {
      try {
        this.db.prepare('DELETE FROM vec_observations WHERE observation_id = ?').run(String(observationId));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`syncEmbedding delete failed for observation ${observationId}: ${msg}`);
      }
      return;
    }

    // 'upsert' -- need the model to be ready
    if (this.embeddingPipeline.state.status !== 'ready') return;

    const embedding = await this.embeddingPipeline.embed(content);
    if (!embedding) return;

    try {
      // Delete any existing embedding first, then insert new one.
      // vec0 doesn't support INSERT OR REPLACE, so we do delete+insert.
      this.db.prepare('DELETE FROM vec_observations WHERE observation_id = ?').run(String(observationId));
      this.db.prepare(
        'INSERT INTO vec_observations (embedding, observation_id) VALUES (?, ?)'
      ).run(
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        String(observationId)
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`syncEmbedding upsert failed for observation ${observationId}: ${msg}`);
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
      // If shutdown was signaled, let the current batch finish but don't start new ones
      if (this.shuttingDown) break;

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
      // DELETE-before-INSERT prevents duplicates if syncEmbedding() from a
      // concurrent MCP request already embedded this observation between
      // our query and this insert (race window during await embedBatch).
      if (results.length > 0 && this.db) {
        const del = this.db.prepare('DELETE FROM vec_observations WHERE observation_id = ?');
        const insert = this.db.prepare(
          'INSERT INTO vec_observations (embedding, observation_id) VALUES (?, ?)'
        );
        try {
          const txn = this.db.transaction(() => {
            for (const { id, embedding } of results) {
              del.run(String(id));
              insert.run(
                Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
                String(id)
              );
            }
          });
          txn();
          totalEmbedded += results.length;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Embedding sweep batch insert failed: ${msg}`);
          break; // stop the sweep on DB error (disk full, SQLITE_BUSY, etc.)
        }
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
    // projectId arrives pre-normalized from normalizeProjectId() in index.ts.
    // Convert undefined (global scope) to null for the SQLite column value.
    const normalizedProject = projectId ?? null;

    // Capture the current time once for all entities in this batch (consistent timestamps)
    const now = new Date().toISOString();

    // Prepared statements are compiled once and reused -- faster than parsing per row.
    // INSERT now writes both `name` (display, preserved as the caller supplied) and
    // `normalized_name` (identity key, used by the partial unique index for collision detection).
    // last_accessed_at is set to creation time — the act of creating is the strongest access signal.
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, normalized_name, entity_type, project, updated_at, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // Lookups go through normalized_name now (the identity key). Filter superseded_at = ''
    // so we only see the active row, not historical soft-deleted rows that may share
    // the same normalized form (allowed by the partial unique index being WHERE active).
    const getEntityId = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // For skip reporting: return the EXISTING display name and project so the caller can see
    // which surface variant won when their input collided with a different one.
    const getExistingForSkip = this.db.prepare(
      `SELECT name AS existing_name, project FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // INSERT includes all three observation metadata columns (importance, context_layer, memory_type).
    // Schema v6 guarantees these columns exist. Defaults (3.0, NULL, NULL) match the column defaults.
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const created: Entity[] = [];
    const skipped: SkippedEntity[] = [];

    // db.transaction() wraps the callback in BEGIN/COMMIT. If the callback throws,
    // it automatically rolls back. This is a better-sqlite3 feature (not raw SQL).
    const txn = this.db.transaction(() => {
      for (const e of entities) {
        // Compute the identity key once per input. normalizeEntityName throws on
        // empty/whitespace-only/separator-only names -- the throw aborts the
        // transaction and surfaces a clean error to the caller.
        const normalizedName = normalizeEntityName(e.name);

        // INSERT OR IGNORE returns changes=0 if normalized_name already exists
        // among ACTIVE rows (the partial unique index enforces this).
        const info = insertEntity.run(e.name, normalizedName, e.entityType, normalizedProject, now, now, now);
        if (info.changes === 0) {
          // Collision -- look up the existing winner so we can report both the
          // input display form (caller's `name`) and the stored display form (`existingName`).
          // These differ when the caller submitted a surface variant of an existing entity.
          const existing = getExistingForSkip.get(normalizedName) as
            | { existing_name: string; project: string | null }
            | undefined;
          skipped.push({
            name: e.name,
            existingProject: existing?.project ?? null,
            existingName: existing?.existing_name,
          });
          continue;
        }

        // Get the auto-generated id for inserting observations. Lookup uses
        // the normalized form -- the row we just inserted is the active match.
        const row = getEntityId.get(normalizedName) as { id: number };
        const observations: Observation[] = [];

        for (const obs of e.observations) {
          // createObservation() now accepts importance/contextLayer/memoryType params,
          // but EntityInput observations are plain strings or Observation objects --
          // strings get defaults via createObservation(obs), objects pass through as-is
          const o = typeof obs === 'string' ? createObservation(obs) : obs;
          const obsInfo = insertObs.run(row.id, o.content, o.createdAt, o.importance, o.contextLayer, o.memoryType);
          if (obsInfo.changes > 0) {
            observations.push(o);
          }
        }

        // The created Entity reports the DISPLAY name (e.name), not the normalized form.
        // Display names are what callers see in subsequent reads.
        created.push({ name: e.name, entityType: e.entityType, observations, project: normalizedProject, updatedAt: now, createdAt: now });
      }
    });
    txn();

    // Fire-and-forget embedding generation for new observations (best-effort).
    // Not awaited — the MCP response returns immediately after the sync transaction.
    // If the model isn't ready, syncEmbedding returns instantly and the sweep catches these later.
    for (const entity of created) {
      // Lookup uses normalized_name (recomputed from the display name) so it
      // matches the row we just inserted regardless of surface form.
      const entityRow = this.db.prepare(
        `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
      ).get(normalizeEntityName(entity.name)) as { id: number };
      for (const obs of entity.observations) {
        const obsRow = this.db.prepare(
          `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
        ).get(entityRow.id, obs.content) as { id: number } | undefined;
        if (obsRow) {
          // syncEmbedding never rejects (internal try-catch), safe to not await
          this.syncEmbedding(obsRow.id, obs.content, 'upsert');
        }
      }
    }

    this.maybeRunEviction();
    return { created, skipped };
  }

  /**
   * Creates new relations in the SQLite database.
   * Uses INSERT OR IGNORE to skip duplicates (UNIQUE constraint on from, to, type, superseded_at).
   * Foreign key constraints ensure both endpoint entities exist -- throws on violation.
   * Sets created_at to current timestamp; superseded_at defaults to '' (active).
   *
   * @param relations - Array of { from, to, relationType }
   * @returns Only the relations that were actually created, with temporal fields
   * @throws SqliteError if from or to entity doesn't exist (FK constraint violation)
   */
  async createRelations(relations: RelationInput[]): Promise<Relation[]> {
    const now = new Date().toISOString();
    // Endpoint existence check: previously enforced by FK constraint (relations
    // referenced entities(name) ON DELETE CASCADE). The v7 migration dropped that
    // FK because the partial unique index on entities(name) WHERE superseded_at=''
    // doesn't satisfy SQLite's FK target requirement. We now validate at the
    // application layer — only ACTIVE (non-soft-deleted) entities count as valid
    // endpoints, matching the previous semantics.
    //
    // Lookup goes through normalized_name (the identity key, post-v8). The query
    // also returns the canonical display name so the result Relation reflects how
    // the entity is actually stored, not whichever surface variant the caller
    // happened to type. Two callers with different casings for the same entity
    // get the same canonical Relation back.
    const findActive = this.db.prepare(
      `SELECT name FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // INSERT stores the NORMALIZED form for from_entity / to_entity (post-v8).
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)'
    );

    const results: Relation[] = [];

    const txn = this.db.transaction(() => {
      for (const r of relations) {
        // normalizeEntityName throws on empty/separator-only — surfaces as a clean error.
        const fromNorm = normalizeEntityName(r.from);
        const toNorm = normalizeEntityName(r.to);
        const fromRow = findActive.get(fromNorm) as { name: string } | undefined;
        if (!fromRow) {
          throw new Error(`Relation references non-existent entity: ${r.from}`);
        }
        const toRow = findActive.get(toNorm) as { name: string } | undefined;
        if (!toRow) {
          throw new Error(`Relation references non-existent entity: ${r.to}`);
        }
        const info = insert.run(fromNorm, toNorm, r.relationType, now);
        if (info.changes > 0) {
          // Return the CANONICAL display names from the entities table — not the
          // surface variants the caller typed. This keeps the result consistent
          // with what subsequent reads will return.
          results.push({
            from: fromRow.name,
            to: toRow.name,
            relationType: r.relationType,
            createdAt: now,
            supersededAt: '',
          });
        }
      }
    });
    txn();

    // Touch last_accessed_at on endpoint entities — creating a relation is a write that
    // signals the caller cares about these entities.
    if (results.length > 0) {
      const endpointNames = new Set<string>();
      for (const r of relations) {
        try { endpointNames.add(normalizeEntityName(r.from)); } catch { /* skip */ }
        try { endpointNames.add(normalizeEntityName(r.to)); } catch { /* skip */ }
      }
      this.touchEntitiesByName([...endpointNames]);
    }

    this.maybeRunEviction();
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
    // Lookup goes through normalized_name (post-v8 identity key) so callers can
    // pass any surface variant of the name. Filter superseded_at = '' so soft-deleted
    // entities are treated as nonexistent — matching hard-delete semantics: the entity
    // is logically gone for new writes.
    const findEntity = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // INSERT includes all three metadata columns — schema v6 guarantees they exist
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // Prepared statement to bump updated_at and last_accessed_at when observations
    // are added to an entity — writes are the strongest access signal.
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
    );

    const results: AddObservationResult[] = [];

    const txn = this.db.transaction(() => {
      for (const o of observations) {
        // normalizeEntityName throws on empty/separator-only — bubbles out as a clean error.
        const normalizedName = normalizeEntityName(o.entityName);
        const row = findEntity.get(normalizedName) as { id: number } | undefined;
        if (!row) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }

        // Capture a single timestamp for all observations in this entity's batch
        // so observation.createdAt and entity.updated_at are consistent
        const now = new Date().toISOString();
        const addedObservations: Observation[] = [];
        for (let i = 0; i < o.contents.length; i++) {
          const content = o.contents[i];
          // Read metadata from parallel arrays, falling back to defaults when
          // the array is omitted or shorter than contents
          const importance = o.importances?.[i] ?? 3.0;
          const contextLayer = o.contextLayers?.[i] ?? null;
          const memoryType = o.memoryTypes?.[i] ?? null;
          const obs: Observation = { content, createdAt: now, importance, contextLayer, memoryType };
          const info = insertObs.run(row.id, content, now, importance, contextLayer, memoryType);
          if (info.changes > 0) {
            addedObservations.push(obs);
          }
        }

        // Bump the entity's updated_at and last_accessed_at if any observations were actually added
        if (addedObservations.length > 0) {
          updateTimestamp.run(now, now, row.id);
        }

        results.push({ entityName: o.entityName, addedObservations });
      }
    });
    txn();

    // Fire-and-forget embedding generation for newly added observations (best-effort).
    // Not awaited — the MCP response returns immediately after the sync transaction.
    for (const result of results) {
      // Lookup uses normalized_name (recomputed from the entity name the caller passed).
      const entityRow = this.db.prepare(
        `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
      ).get(normalizeEntityName(result.entityName)) as { id: number } | undefined;
      if (!entityRow) continue;
      for (const obs of result.addedObservations) {
        const obsRow = this.db.prepare(
          `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
        ).get(entityRow.id, obs.content) as { id: number } | undefined;
        if (obsRow) {
          // syncEmbedding never rejects (internal try-catch), safe to not await
          this.syncEmbedding(obsRow.id, obs.content, 'upsert');
        }
      }
    }

    // --- Similarity check: find semantically similar existing observations ---
    // After inserting new observations, if the embedding model is ready,
    // embed each new observation and find near-neighbors on the same entity.
    // Returns matches with cosine similarity > 0.85 so the caller can decide
    // whether to supersede, append, or ignore. Best-effort: omitted if model not ready.
    if (this.vecTableExists && this.embeddingPipeline.state.status === 'ready') {
      try {
        for (const r of results) {
          if (r.addedObservations.length === 0) continue;

          // Get the entity ID for similarity queries — findEntity is the
          // already-prepared statement that takes normalized_name.
          const entityRow = findEntity.get(normalizeEntityName(r.entityName)) as { id: number } | undefined;
          if (!entityRow) continue;

          const similar: SimilarObservation[] = [];

          for (const obs of r.addedObservations) {
            const embedding = await this.embeddingPipeline.embed(obs.content);
            if (!embedding) continue;

            // KNN search for nearest neighbors across all entities.
            // We request a larger k (20) because we filter to same-entity
            // afterward — with a small k (3), all top results might belong
            // to unrelated entities and the real same-entity match could be
            // missed entirely. At scale (50k+ observations), consider
            // partitioned vec0 tables or a WHERE clause on entity_id if
            // sqlite-vec adds support for filtered KNN.
            const knnRows = this.db.prepare(`
              SELECT v.observation_id, v.distance FROM vec_observations v
              WHERE v.embedding MATCH ? AND k = 20
            `).all(
              Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            ) as { observation_id: string; distance: number }[];

            // Track how many same-entity matches we've found for this observation.
            // Cap at 3 to avoid flooding the response when many observations
            // on the same entity are semantically related.
            let matchesForThisObs = 0;
            const MAX_SIMILAR_PER_OBS = 3;

            for (const knn of knnRows) {
              if (matchesForThisObs >= MAX_SIMILAR_PER_OBS) break;

              // Convert L2 distance on normalized vectors to cosine similarity.
              // For unit vectors: cos_sim = 1 - (L2_dist² / 2).
              // sqlite-vec default metric is L2 (Euclidean), not squared L2,
              // so we must square it ourselves before dividing by 2.
              const similarity = 1 - (knn.distance * knn.distance) / 2;
              if (similarity <= 0.85) continue;

              // Check that this observation belongs to the same entity AND is not
              // the just-inserted observation itself (filter by content != obs.content)
              const obsRow = this.db.prepare(`
                SELECT o.content FROM observations o
                WHERE o.id = ? AND o.entity_id = ? AND o.superseded_at = '' AND o.content != ?
              `).get(parseInt(knn.observation_id, 10), entityRow.id, obs.content) as { content: string } | undefined;

              if (obsRow) {
                similar.push({ content: obsRow.content, similarity: Math.round(similarity * 1000) / 1000 });
                matchesForThisObs++;
              }
            }
          }

          if (similar.length > 0) {
            r.similarExisting = similar;
          }
        }
      } catch (err: unknown) {
        // Similarity check is best-effort — don't fail the whole operation
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Similarity check failed: ${msg}`);
      }
    }

    this.maybeRunEviction();
    return results;
  }

  /**
   * Soft-deletes entities by name. Sets superseded_at on the entity row, all of
   * its active observations, and all active relations referencing it (incoming
   * and outgoing). Atomic in a single transaction — partial failure rolls back
   * the whole thing. A single `now` timestamp is used for all updates so that
   * an `entity_timeline` query at exactly that timestamp shows a clean cut.
   * Silently ignores names that don't exist or are already soft-deleted (idempotent).
   *
   * Why soft-delete instead of hard DELETE: Phase B Task 3 (as_of point-in-time
   * queries) needs to faithfully recall what existed at past timestamps. A hard
   * delete removes the row irrecoverably and breaks Goal B (faithful recall of
   * who/what/when/where/why/how). The partial unique index on (name) WHERE
   * superseded_at='' (added in v6→v7) makes re-creation after soft-delete
   * possible without UNIQUE collisions.
   *
   * vec_observations is intentionally NOT cleaned up — historical embeddings
   * survive soft-delete the same way they survive observation supersession.
   * This is what makes vector search at an earlier asOf still recoverable.
   *
   * @param entityNames - Array of entity name strings to soft-delete
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    // Look up only active entities — already-superseded ones are silently ignored.
    // Lookup goes through normalized_name (post-v8 identity key).
    const findActiveEntity = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // Soft-delete the entity row.
    const supersedeEntity = this.db.prepare(
      `UPDATE entities SET superseded_at = ? WHERE id = ? AND superseded_at = ''`
    );
    // Soft-delete all of the entity's active observations.
    const supersedeEntityObservations = this.db.prepare(
      `UPDATE observations SET superseded_at = ? WHERE entity_id = ? AND superseded_at = ''`
    );
    // Soft-delete all active relations originating from this entity. After v8,
    // relations.from_entity holds the normalized form, so we bind the normalized name.
    const supersedeOutgoingRelations = this.db.prepare(
      `UPDATE relations SET superseded_at = ? WHERE from_entity = ? AND superseded_at = ''`
    );
    // Soft-delete all active relations terminating at this entity (same normalization).
    const supersedeIncomingRelations = this.db.prepare(
      `UPDATE relations SET superseded_at = ? WHERE to_entity = ? AND superseded_at = ''`
    );

    const txn = this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const name of entityNames) {
        // deleteEntities is documented as idempotent — empty/separator-only names
        // can't refer to anything that exists, so swallow the normalize error and
        // treat as a silent miss instead of throwing out of the transaction.
        let normalizedName: string;
        try {
          normalizedName = normalizeEntityName(name);
        } catch {
          continue;
        }
        const row = findActiveEntity.get(normalizedName) as { id: number } | undefined;
        if (!row) continue; // already soft-deleted or never existed
        supersedeEntity.run(now, row.id);
        supersedeEntityObservations.run(now, row.id);
        supersedeOutgoingRelations.run(now, normalizedName);
        supersedeIncomingRelations.run(now, normalizedName);
      }
    });
    txn();
    this.maybeRunEviction();
  }

  /**
   * Deletes specific observations by content string from the named entities.
   * Silently ignores non-existent entities (idempotent -- absence is the goal).
   *
   * @param deletions - Array of { entityName, contents: string[] }
   */
  async deleteObservations(deletions: DeleteObservationInput[]): Promise<void> {
    // Lookup uses normalized_name (post-v8 identity key). Filter superseded_at = ''
    // so soft-deleted entities are treated as nonexistent — deleteObservations on a
    // soft-deleted entity is a silent no-op (the observations are already retired as
    // part of the soft-delete CASCADE).
    const findEntity = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    const delObs = this.db.prepare(
      `DELETE FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
    );
    // Prepared statement to bump updated_at and last_accessed_at when observations
    // are removed from an entity — writes are the strongest access signal.
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
    );

    const deletedObsIds: number[] = [];

    const txn = this.db.transaction(() => {
      for (const d of deletions) {
        // deleteObservations is idempotent — empty/separator-only names can't refer
        // to anything that exists, so swallow the normalize error and skip silently.
        let normalizedName: string;
        try {
          normalizedName = normalizeEntityName(d.entityName);
        } catch {
          continue;
        }
        const row = findEntity.get(normalizedName) as { id: number } | undefined;
        if (!row) continue;
        let anyDeleted = false;
        for (const content of d.contents) {
          // Look up the observation ID before deleting (needed for vec cleanup)
          if (this.vecTableExists) {
            const obsRow = this.db.prepare(
              `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
            ).get(row.id, content) as { id: number } | undefined;
            if (obsRow) deletedObsIds.push(obsRow.id);
          }
          const result = delObs.run(row.id, content);
          if (result.changes > 0) anyDeleted = true;
        }
        // Only bump updated_at if observations were actually deleted —
        // avoids spurious timestamp advances on no-op deletions (e.g., misspelled content)
        if (anyDeleted) {
          const deleteNow = new Date().toISOString();
          updateTimestamp.run(deleteNow, deleteNow, row.id);
        }
      }
    });
    txn();

    // Clean up vec_observations for deleted observations (fire-and-forget).
    // Delete path in syncEmbedding is synchronous internally, but we still
    // don't need to await — it never rejects.
    for (const obsId of deletedObsIds) {
      this.syncEmbedding(obsId, '', 'delete');
    }
    this.maybeRunEviction();
  }

  /**
   * Deletes active relations by exact match on all three fields.
   * Only deletes relations where superseded_at = '' (active). Invalidated relations
   * are preserved for history and are not affected by this operation.
   * Silently ignores non-existent or already-invalidated relations (idempotent).
   *
   * @param relations - Array of { from, to, relationType }
   */
  async deleteRelations(relations: RelationInput[]): Promise<void> {
    // After v8, relations.from_entity / to_entity hold the NORMALIZED form.
    // Bind normalized values so the WHERE matches what's actually stored.
    const del = this.db.prepare(
      `DELETE FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ? AND superseded_at = ''`
    );
    const txn = this.db.transaction(() => {
      for (const r of relations) {
        // deleteRelations is idempotent — bad names just don't match anything.
        let fromNorm: string, toNorm: string;
        try {
          fromNorm = normalizeEntityName(r.from);
          toNorm = normalizeEntityName(r.to);
        } catch {
          continue;
        }
        del.run(fromNorm, toNorm, r.relationType);
      }
    });
    txn();
    this.maybeRunEviction();
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
    // Prepared statement to find an active entity by normalized identity key.
    // Soft-deleted entities are excluded — supersession on a logically-removed
    // entity throws "not found" (matching pre-soft-delete semantics for missing entities).
    const findEntity = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // Find the active observation matching this entity + content.
    // SELECT includes metadata columns so we can carry them forward to the replacement.
    const findActiveObs = this.db.prepare(
      `SELECT id, importance, context_layer, memory_type FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
    );
    // Mark the old observation as superseded (set superseded_at to current timestamp)
    const supersedeObs = this.db.prepare(
      `UPDATE observations SET superseded_at = ? WHERE id = ?`
    );
    // Insert the replacement observation as active (superseded_at defaults to '').
    // Carries forward importance/context_layer/memory_type from the superseded observation
    // so metadata isn't lost during content updates (use set_observation_metadata to change these).
    const insertObs = this.db.prepare(
      `INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type) VALUES (?, ?, ?, ?, ?, ?)`
    );
    // Bump entity's updated_at and last_accessed_at — writes are the strongest access signal.
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
    );

    // better-sqlite3 transactions are synchronous -- the outer async wrapper
    // satisfies the GraphStore interface contract
    const txn = this.db.transaction(() => {
      const now = new Date().toISOString();

      for (const s of supersessions) {
        // Look up the entity by its normalized identity key.
        // normalizeEntityName throws on empty/separator-only — bubbles out cleanly.
        const normalizedName = normalizeEntityName(s.entityName);
        const entityRow = findEntity.get(normalizedName) as { id: number } | undefined;
        if (!entityRow) {
          throw new Error(`Entity with name ${s.entityName} not found`);
        }

        // Find the active observation to supersede (includes metadata for carry-forward)
        const obsRow = findActiveObs.get(entityRow.id, s.oldContent) as {
          id: number; importance: number; context_layer: string | null; memory_type: string | null;
        } | undefined;
        if (!obsRow) {
          throw new Error(
            `Active observation "${s.oldContent}" not found on entity "${s.entityName}"`
          );
        }

        // Retire the old observation by setting its superseded_at timestamp.
        // We deliberately do NOT delete the corresponding vec_observations row:
        // historical embeddings must survive supersession so that point-in-time
        // vector search at an asOf earlier than `now` can still recover the
        // historically-active observation. The vec table grows monotonically
        // with observation history. (~1.5KB per superseded observation; acceptable
        // cost for Goal A correctness — see Phase B Task 3 fix #4 Part B.)
        supersedeObs.run(now, obsRow.id);

        // Insert the replacement — carry forward importance, context_layer, and memory_type
        // from the old observation so metadata survives content updates.
        // INSERT OR IGNORE: if newContent already exists as an active observation, skip.
        insertObs.run(entityRow.id, s.newContent, now, obsRow.importance, obsRow.context_layer, obsRow.memory_type);

        // Bump updated_at and last_accessed_at so the entity surfaces in recency-ordered queries
        updateTimestamp.run(now, now, entityRow.id);
      }
    });
    txn();

    // Fire-and-forget embedding generation for replacement observations (best-effort).
    // Not awaited — the MCP response returns immediately after the sync transaction.
    for (const s of supersessions) {
      // findEntity is the prepared statement that takes normalized_name.
      const entityRow = findEntity.get(normalizeEntityName(s.entityName)) as { id: number } | undefined;
      if (!entityRow) continue;
      const newObsRow = this.db.prepare(
        `SELECT id FROM observations WHERE entity_id = ? AND content = ? AND superseded_at = ''`
      ).get(entityRow.id, s.newContent) as { id: number } | undefined;
      if (newObsRow) {
        // syncEmbedding never rejects (internal try-catch), safe to not await
        this.syncEmbedding(newObsRow.id, s.newContent, 'upsert');
      }
    }
    this.maybeRunEviction();
  }

  /**
   * Builds SQL WHERE conditions for point-in-time observation filtering.
   * When asOf is provided, returns only observations that were active at that moment:
   * created on or before asOf AND either still active or superseded after asOf.
   * When asOf is undefined, returns only currently-active observations.
   *
   * Three-state contract: undefined = current, valid ISO timestamp = point-in-time,
   * empty string = throws (invalid). The strict `=== undefined` check (rather than `!asOf`)
   * exists so an empty string can't silently fall through to the "no filter" branch
   * and collide with `undefined` in the cursor fingerprint system.
   *
   * @param asOf - ISO 8601 UTC timestamp for point-in-time queries, or undefined for current
   * @returns Object with { clause: SQL string, params: bind values to append }
   * @throws Error if asOf is the empty string
   */
  private temporalObsFilter(asOf?: string): { clause: string; params: string[] } {
    if (asOf === '') {
      throw new Error('temporalObsFilter: asOf must be undefined or a valid ISO 8601 timestamp, not empty string');
    }
    if (asOf === undefined) return { clause: `o.superseded_at = ''`, params: [] };
    return {
      clause: `o.created_at <= ? AND (o.superseded_at = '' OR o.superseded_at > ?)`,
      params: [asOf, asOf],
    };
  }

  /**
   * Same as temporalObsFilter but for the relations table.
   * Accepts an optional alias prefix so the helper can serve both joined queries
   * (e.g., `relations r` -> pass alias `'r'`) and unaliased queries on the bare
   * relations table (pass alias `''` or omit). Defaults to `''` (unaliased) to
   * preserve the previous call signature.
   *
   * @param asOf - ISO 8601 UTC timestamp for point-in-time queries, or undefined for current
   * @param alias - SQL alias for the relations table; pass `''` for unaliased queries
   * @returns Object with { clause: SQL string, params: bind values to append }
   * @throws Error if asOf is the empty string
   */
  private temporalRelFilter(
    asOf?: string,
    alias: string = '',
  ): { clause: string; params: string[] } {
    if (asOf === '') {
      throw new Error('temporalRelFilter: asOf must be undefined or a valid ISO 8601 timestamp, not empty string');
    }
    const prefix = alias ? `${alias}.` : '';
    if (asOf === undefined) return { clause: `${prefix}superseded_at = ''`, params: [] };
    return {
      clause: `${prefix}created_at <= ? AND (${prefix}superseded_at = '' OR ${prefix}superseded_at > ?)`,
      params: [asOf, asOf],
    };
  }

  /**
   * Same as temporalObsFilter but for the entities table.
   * Accepts an optional alias prefix so the helper can serve both joined queries
   * (e.g., `entities e` → pass alias `'e'`) and unaliased queries on the bare
   * entities table (pass alias `''`). Defaults to `'e'` to match the convention
   * used by temporalObsFilter and temporalRelFilter.
   *
   * @param asOf - ISO 8601 UTC timestamp for point-in-time queries, or undefined for current
   * @param alias - SQL alias for the entities table; pass `''` for unaliased queries
   * @returns Object with { clause: SQL string, params: bind values to append }
   * @throws Error if asOf is the empty string
   */
  private temporalEntFilter(
    asOf?: string,
    alias: string = 'e',
  ): { clause: string; params: string[] } {
    if (asOf === '') {
      throw new Error('temporalEntFilter: asOf must be undefined or a valid ISO 8601 timestamp, not empty string');
    }
    const prefix = alias ? `${alias}.` : '';
    if (asOf === undefined) return { clause: `${prefix}superseded_at = ''`, params: [] };
    return {
      clause: `${prefix}created_at <= ? AND (${prefix}superseded_at = '' OR ${prefix}superseded_at > ?)`,
      params: [asOf, asOf],
    };
  }

  /**
   * Fetches full Entity objects for a set of entity rows, including their observations.
   * Groups observation rows by entity ID (not name) and assembles complete Entity objects.
   *
   * Why id-based grouping: post-v8 the same display `name` can appear on multiple
   * entity rows (one active + soft-deleted historical rows under the same display
   * form). Joining by name would over-fetch observations from soft-deleted rows.
   * Joining by id is unambiguous regardless of display-name reuse.
   *
   * Uses a single query per chunk to fetch all observations (avoids N+1 queries).
   * Chunks the IN clause to stay within SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (default 999).
   *
   * @param entityRows - Array of { id, name, entityType, project, updated_at, created_at } —
   *                     id is REQUIRED so we can group observations unambiguously
   * @param asOf - Optional ISO 8601 UTC timestamp for point-in-time observation filtering
   * @returns Entity array with observations attached, in the same order as the input rows
   */
  private buildEntities(entityRows: { id: number; name: string; entityType: string; project: string | null; updated_at: string; created_at: string }[], asOf?: string): Entity[] {
    if (entityRows.length === 0) return [];

    const ids = entityRows.map(e => e.id);
    // Build temporal filter for observations — controls which observations are included
    const obsFilter = this.temporalObsFilter(asOf);

    // Group observations by entity_id using a Map, fetching in chunks
    // to avoid exceeding SQLite's parameter limit (default 999)
    const obsMap = new Map<number, Observation[]>();
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      const obsRows = this.db.prepare(`
        SELECT o.entity_id AS entityId, o.content, o.created_at AS createdAt,
               o.importance, o.context_layer, o.memory_type
        FROM observations o
        WHERE o.entity_id IN (${placeholders}) AND ${obsFilter.clause}
      `).all(...chunk, ...obsFilter.params) as { entityId: number; content: string; createdAt: string;
        importance: number; context_layer: string | null; memory_type: string | null }[];

      for (const o of obsRows) {
        if (!obsMap.has(o.entityId)) obsMap.set(o.entityId, []);
        obsMap.get(o.entityId)!.push({
          content: o.content,
          createdAt: o.createdAt,
          importance: o.importance ?? 3.0,
          contextLayer: o.context_layer ?? null,
          memoryType: o.memory_type ?? null,
        });
      }
    }

    return entityRows.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: obsMap.get(e.id) || [],
      project: e.project,
      updatedAt: e.updated_at,
      createdAt: e.created_at,
    }));
  }

  /**
   * Fetches all relations where at least one endpoint is in the given name set.
   * Filters out invalidated relations (superseded_at != '') unless asOf is set.
   * Chunks the IN clause to stay within SQLite's parameter limit.
   * Uses CHUNK_SIZE / 2 per chunk because each name appears twice (from OR to).
   *
   * Post-v8 storage shape: relations.from_entity / to_entity store the NORMALIZED
   * form, not the display form. This function:
   *   1. Normalizes the input names so the IN-clause matches what's actually stored.
   *   2. LEFT-JOINs entities (twice — once for each endpoint) to translate the
   *      stored normalized form back into the canonical display name for the
   *      Relation result. The JOIN filter `superseded_at = ''` picks the active
   *      display variant when one exists.
   *   3. Uses COALESCE to fall back to the normalized form if no active entity
   *      row matches — defensive for historical / asOf reads where the cascading
   *      soft-delete may leave a relation pointing at a normalized identity that
   *      no longer has an active display form.
   *
   * Note on asOf: the JOIN currently always picks the *currently-active* display
   * variant. For point-in-time recall, this means the displayed surface form may
   * be the one in use today, even if a different surface form was canonical at
   * asOf. The IDENTITY (normalized_name) is preserved either way — only the
   * display form may lag. Acceptable trade-off; revisit if it becomes a bug.
   *
   * @param entityNames - Array of entity name strings (any surface form)
   * @returns Relation array with from/to translated to canonical display names
   */
  private getConnectedRelations(entityNames: string[], asOf?: string): Relation[] {
    if (entityNames.length === 0) return [];

    // Normalize input names so the IN-clause matches the stored identity form.
    // Skip names that fail normalization — they can't refer to anything stored.
    const normalizedNames: string[] = [];
    for (const n of entityNames) {
      try {
        normalizedNames.push(normalizeEntityName(n));
      } catch {
        // Skip names that can't be normalized — they won't match anything anyway.
      }
    }
    if (normalizedNames.length === 0) return [];

    // Build temporal filter for relations — controls which relations are included.
    // Pass alias 'r' so the emitted clause qualifies its column references; the
    // query below LEFT JOINs `entities` twice (ef, et), and an unqualified
    // `superseded_at` would be ambiguous between relations and entities columns.
    const relFilter = this.temporalRelFilter(asOf, 'r');

    // Each name is bound twice (from_entity IN (...) OR to_entity IN (...)),
    // so use half the chunk size to stay within the parameter limit
    const halfChunk = Math.floor(CHUNK_SIZE / 2);
    const results: Relation[] = [];

    for (let i = 0; i < normalizedNames.length; i += halfChunk) {
      const chunk = normalizedNames.slice(i, i + halfChunk);
      const placeholders = chunk.map(() => '?').join(',');
      // LEFT JOIN entities twice (once per endpoint) to translate normalized form
      // back to display name. COALESCE returns the normalized form if the JOIN
      // misses (defensive against orphan relations or historical reads).
      const rows = this.db.prepare(`
        SELECT
          COALESCE(ef.name, r.from_entity) AS "from",
          COALESCE(et.name, r.to_entity)   AS "to",
          r.relation_type AS relationType,
          r.created_at    AS createdAt,
          r.superseded_at AS supersededAt
        FROM relations r
        LEFT JOIN entities ef ON ef.normalized_name = r.from_entity AND ef.superseded_at = ''
        LEFT JOIN entities et ON et.normalized_name = r.to_entity   AND et.superseded_at = ''
        WHERE (r.from_entity IN (${placeholders}) OR r.to_entity IN (${placeholders}))
          AND ${relFilter.clause}
      `).all(...chunk, ...chunk, ...relFilter.params) as Relation[];
      results.push(...rows);
    }

    // Deduplicate: chunked queries may return the same relation if its endpoints
    // span different chunks (e.g., from in chunk 1, to in chunk 2).
    // Uses null-byte (\0) separator instead of JSON.stringify for efficiency —
    // avoids allocating a JSON array string per relation. \0 can't appear in
    // entity names (Zod .min(1) + MCP JSON transport rejects null bytes).
    const seen = new Set<string>();
    return results.filter(r => {
      const key = `${r.from}\0${r.to}\0${r.relationType}`;
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
   * @param asOf - Optional ISO 8601 UTC timestamp for point-in-time observation/relation filtering
   * @returns PaginatedKnowledgeGraph with entities, relations, nextCursor, and totalCount
   */
  async readGraph(projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<PaginatedKnowledgeGraph> {
    const fingerprint = readGraphFingerprint(projectId, asOf);

    // When pagination is undefined, return all results (backward compat).
    // When provided, clamp the limit to valid range and optionally decode cursor.
    const isPaginated = pagination !== undefined;
    const limit = isPaginated ? clampLimit(pagination.limit) : undefined;

    let cursor: CursorPayload | undefined;
    if (pagination?.cursor) {
      cursor = decodeCursor(pagination.cursor, fingerprint);
    }

    // projectId arrives pre-normalized from normalizeProjectId() in index.ts
    const normalizedProject = projectId;

    // Build the WHERE clause dynamically based on project filter, temporal filter,
    // and cursor position. Conditions array collects SQL fragments; params array
    // collects bound values.
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Temporal filter on entities. With asOf undefined, this is just `superseded_at = ''`
    // (active rows only). With asOf set, returns rows that were active at that moment.
    // alias='' because the FROM clause uses bare `entities` without an alias.
    const entFilter = this.temporalEntFilter(asOf, '');
    conditions.push(entFilter.clause);
    params.push(...entFilter.params);

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
      // Mirror the temporal filter applied to the main query so totalCount
      // matches the page contents at this asOf.
      const countEntFilter = this.temporalEntFilter(asOf, '');
      countConditions.push(countEntFilter.clause);
      countParams.push(...countEntFilter.params);
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

    // Build full Entity objects with observations from the page rows.
    // asOf controls temporal filtering — when set, only observations active at that moment.
    const entities = this.buildEntities(pageRows, asOf);

    // Relations: when paginated or project-filtered, only include relations where
    // both endpoints are in the current page's entity set.
    // When not paginated and not project-filtered, return all relations (backward compat).
    if (isPaginated || projectId) {
      // Build the name set from both display names AND normalized names. This handles
      // the COALESCE fallback in getConnectedRelations: when a relation endpoint's
      // entity is soft-deleted, the LEFT JOIN misses and COALESCE returns the normalized
      // form instead of the display form. Without the normalized form in the set, those
      // relations would be silently dropped. Matches the openNodes pattern. (Issue #73.)
      const entityNames = new Set(pageRows.map(e => e.name));
      for (const row of pageRows) {
        try {
          entityNames.add(normalizeEntityName(row.name));
        } catch {
          // Name can't be normalized — display form is already in the set.
        }
      }
      const connectedRelations = this.getConnectedRelations(pageRows.map(e => e.name), asOf);
      const filteredRelations = connectedRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations, nextCursor, totalCount };
    }

    // Unscoped + unpaginated: return all active relations (backward compatible with original behavior).
    // When asOf is set, apply temporal filter; otherwise filter by superseded_at = ''.
    // LEFT JOIN entities twice to translate stored normalized form back to display
    // names (post-v8 storage shape). COALESCE falls back to the normalized form if
    // no active entity row matches. Pass alias 'r' so the temporal filter qualifies
    // its column references and doesn't collide with the JOINed entities.superseded_at.
    const relFilter = this.temporalRelFilter(asOf, 'r');
    const relations = this.db.prepare(
      `SELECT
          COALESCE(ef.name, r.from_entity) AS "from",
          COALESCE(et.name, r.to_entity)   AS "to",
          r.relation_type AS relationType,
          r.created_at    AS createdAt,
          r.superseded_at AS supersededAt
       FROM relations r
       LEFT JOIN entities ef ON ef.normalized_name = r.from_entity AND ef.superseded_at = ''
       LEFT JOIN entities et ON et.normalized_name = r.to_entity   AND et.superseded_at = ''
       WHERE ${relFilter.clause}`
    ).all(...relFilter.params) as Relation[];

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
  async searchNodes(query: string, projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<PaginatedKnowledgeGraph> {
    const fingerprint = searchNodesFingerprint(projectId, query, asOf);

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
    // projectId arrives pre-normalized from normalizeProjectId() in index.ts
    const normalizedProject = projectId;

    // Use a CTE (Common Table Expression) to compute the set of matching entity IDs
    // once, then reuse it for both pagination and total count. This avoids running the
    // expensive LEFT JOIN + 3 LIKE patterns twice (was issue #50).
    // SQLite materializes CTEs referenced multiple times, so matched_ids is computed once.
    // When asOf is set, both the entity and observation filters become temporal.
    const obsFilter = this.temporalObsFilter(asOf);
    const entFilter = this.temporalEntFilter(asOf, 'e2');
    // Parameter binding order matches textual order in the statement.
    // SQL text order: JOIN ON (obsFilter) → WHERE entFilter → WHERE LIKE patterns → optional project.
    // SQL parameter binding follows textual order, so the params array must mirror it exactly.
    //
    // Four LIKE conditions: display name, normalized name, entity type, and observation content.
    // The normalized pattern is built from the normalized query so that searching "dustinspace"
    // matches an entity whose normalized_name is "dustinspace" even if its display name is
    // "Dustin-Space". Try/catch handles queries that normalize to empty (e.g. pure separators)
    // — in that case we skip the normalized column (it can't match anything useful).
    let normalizedPattern: string | null = null;
    try {
      const normalizedQuery = normalizeEntityName(query);
      normalizedPattern = `%${escapeLike(normalizedQuery)}%`;
    } catch {
      // Query is empty after normalization (e.g. all separators) — skip normalized_name match.
    }

    const cteParams: (string | number)[] = [
      ...obsFilter.params,
      ...entFilter.params,
      pattern, pattern, pattern,
    ];
    // Build the LIKE OR clause — always includes display name, entity type, and observation content.
    // Conditionally adds normalized_name if the query normalizes to something non-empty.
    let likeClause = '(e2.name LIKE ? ESCAPE \'\\\' OR e2.entity_type LIKE ? ESCAPE \'\\\' OR o.content LIKE ? ESCAPE \'\\\'';
    if (normalizedPattern !== null) {
      likeClause += ' OR e2.normalized_name LIKE ? ESCAPE \'\\\'';
      cteParams.push(normalizedPattern);
    }
    likeClause += ')';

    let cteSql = `
      WITH matched_ids AS (
        SELECT DISTINCT e2.id FROM entities e2
        LEFT JOIN observations o ON o.entity_id = e2.id AND ${obsFilter.clause}
        WHERE ${entFilter.clause}
          AND ${likeClause}
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
    // totalCount starts from the LIKE query count. It may be adjusted upward
    // after vector search adds supplementary entities that LIKE missed.
    let totalCount = isPaginated
      ? (pageRows.length > 0 ? pageRows[0].total_count! : 0)
      : pageRows.length;

    // Build full Entity objects with observations (asOf controls temporal filtering)
    const entities = this.buildEntities(pageRows, asOf);

    // --- Vector search: find additional entities LIKE missed ---
    // If the embedding model is ready, run a KNN search for semantically
    // similar observations. Merge results with LIKE results by entity ID.
    // Vector results appear as supplementary matches appended to the page.
    if (this.vecTableExists && this.embeddingPipeline.state.status === 'ready') {
      try {
        const queryEmbedding = await this.embeddingPipeline.embed(query);
        if (queryEmbedding) {
          // Request more KNN results than the page limit to account for
          // duplicates and multiple observations per entity
          const knnK = Math.min((limit ?? 40) * 2, 200);
          const knnRows = this.db.prepare(`
            SELECT observation_id, distance
            FROM vec_observations
            WHERE embedding MATCH ? AND k = ${knnK}
          `).all(
            Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
          ) as { observation_id: string; distance: number }[];

          if (knnRows.length > 0) {
            // Map KNN observation IDs (stored as TEXT) to entity IDs,
            // filtering for active observations + project scope
            const obsIds = knnRows.map(r => parseInt(r.observation_id, 10));
            const vecEntityIds = new Set<number>();

            // Temporal filters for the KNN result hydration. With asOf undefined,
            // both filters reduce to `superseded_at = ''` (current state). With
            // asOf set, both filters check the temporal interval — including the
            // case where the observation has since been superseded but was active
            // at asOf, which is exactly the historical recall path that depends on
            // vec_observations rows surviving supersession (see Phase B fix #4).
            const knnObsFilter = this.temporalObsFilter(asOf);
            const knnEntFilter = this.temporalEntFilter(asOf, 'e');
            for (let i = 0; i < obsIds.length; i += CHUNK_SIZE) {
              const chunk = obsIds.slice(i, i + CHUNK_SIZE);
              const placeholders = chunk.map(() => '?').join(',');
              // Param order matches textual SQL order: chunk IN clause → obsFilter → entFilter → optional project.
              let vecSql = `
                SELECT DISTINCT e.id FROM observations o
                JOIN entities e ON o.entity_id = e.id
                WHERE o.id IN (${placeholders})
                  AND ${knnObsFilter.clause}
                  AND ${knnEntFilter.clause}
              `;
              const vecParams: (string | number)[] = [
                ...chunk,
                ...knnObsFilter.params,
                ...knnEntFilter.params,
              ];
              if (normalizedProject) {
                vecSql += ' AND (e.project = ? OR e.project IS NULL)';
                vecParams.push(normalizedProject);
              }
              const rows = this.db.prepare(vecSql).all(...vecParams) as { id: number }[];
              for (const r of rows) vecEntityIds.add(r.id);
            }

            // Filter out entities that LIKE already matches (on ANY page, not just current).
            // When paginated, query the full CTE matched_ids set so we don't re-add
            // entities that would appear on a different LIKE page.
            const allLikeIds = isPaginated
              ? new Set(
                  (this.db.prepare(`${cteSql} SELECT id FROM matched_ids`).all(...cteParams) as { id: number }[])
                    .map(r => r.id)
                )
              : new Set(pageRows.map(r => r.id));
            const newIds = [...vecEntityIds].filter(id => !allLikeIds.has(id));

            if (newIds.length > 0) {
              // Fetch and build the vector-only entities. Temporal filter is
              // redundant because vecEntityIds is already filtered through the
              // KNN JOIN above, but applied here as defense-in-depth so this
              // query never returns soft-deleted rows under any reordering.
              const hydrateFilter = this.temporalEntFilter(asOf, '');
              const ph = newIds.map(() => '?').join(',');
              const newRows = this.db.prepare(`
                SELECT name, entity_type AS entityType, project, updated_at, created_at, id
                FROM entities WHERE id IN (${ph}) AND ${hydrateFilter.clause}
                ORDER BY updated_at DESC, id DESC
              `).all(...newIds, ...hydrateFilter.params) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number }[];
              const vecEntities = this.buildEntities(newRows, asOf);
              entities.push(...vecEntities);
            }
          }
        }
      } catch (err: unknown) {
        // Vector search failed -- LIKE results are already in entities, just continue
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Vector search augmentation failed: ${msg}`);
      }
    }

    // Adjust totalCount upward to account for vector-supplementary entities
    // that weren't found by the LIKE query. This ensures totalCount >= entities.length,
    // which is the safe direction for "should I fetch more?" decisions.
    if (entities.length > totalCount) {
      totalCount = entities.length;
    }

    // Relations: include vector-supplementary entities in the lookup set.
    // entities[] may have more entries than pageRows if vector search found additional matches.
    // Include normalized names alongside display names — when a relation endpoint's entity
    // is soft-deleted, COALESCE falls back to the normalized form. Without it in the set,
    // those relations would be silently dropped. Matches the openNodes pattern. (Issue #73.)
    const entityNames = new Set(entities.map(e => e.name));
    for (const entity of entities) {
      try {
        entityNames.add(normalizeEntityName(entity.name));
      } catch {
        // Name can't be normalized — display form is already in the set.
      }
    }
    const allEntityNamesList = [...entityNames];

    // Touch last_accessed_at on all returned entities — targeted search expresses intent.
    // Only for current-time queries (not asOf historical reads, which are about the past).
    if (!asOf && entities.length > 0) {
      const normalizedNames = entities.map(e => normalizeEntityName(e.name));
      this.touchEntitiesByName(normalizedNames);
    }

    // When paginated or project-filtered, both endpoints must be in the result set.
    // When not paginated and not project-filtered, use OR logic (backward compat).
    if (isPaginated || projectId) {
      const allRelations = this.getConnectedRelations(allEntityNamesList, asOf);
      const filteredRelations = allRelations.filter(r =>
        entityNames.has(r.from) && entityNames.has(r.to)
      );
      return { entities, relations: filteredRelations, nextCursor, totalCount };
    }

    // Unscoped + unpaginated: OR logic for relations (at least one endpoint matches)
    const relations = this.getConnectedRelations(allEntityNamesList, asOf);
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
  async openNodes(names: string[], projectId?: string, asOf?: string): Promise<KnowledgeGraph> {
    if (names.length === 0) return { entities: [], relations: [] };

    // Step 1: normalize the input names so we can look them up against the
    // partial unique index on `normalized_name`. Surface variants supplied by
    // the caller (case differences, hyphens, etc.) all collapse to the same
    // identity key. We swallow normalize errors here because openNodes is
    // a read operation — bad input names just match nothing, they don't throw.
    const normalizedNames: string[] = [];
    for (const n of names) {
      try {
        normalizedNames.push(normalizeEntityName(n));
      } catch {
        // skip — malformed name can't refer to anything stored
      }
    }
    if (normalizedNames.length === 0) return { entities: [], relations: [] };

    // Chunk the IN clause to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (999).
    // Safe via MCP (Zod .max(100) on names array) but needed for direct callers with 900+ names.
    // We SELECT id so buildEntities can use id-based JOINs (display names can be
    // ambiguous after soft-delete: an active row may share `name` with historical rows).
    type EntityRow = { id: number; name: string; entityType: string; project: string | null; updated_at: string; created_at: string };
    let entityRows: EntityRow[] = [];
    // projectId arrives pre-normalized from normalizeProjectId() in index.ts
    const normalizedProject = projectId;

    // Temporal filter on entities — when asOf is undefined, this is the simple
    // active filter. When asOf is set, the entity must have existed at that time.
    const entFilter = this.temporalEntFilter(asOf, '');

    for (let i = 0; i < normalizedNames.length; i += CHUNK_SIZE) {
      const chunk = normalizedNames.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');

      if (normalizedProject) {
        const rows = this.db.prepare(
          `SELECT id, name, entity_type AS entityType, project, updated_at, created_at FROM entities
           WHERE normalized_name IN (${placeholders}) AND ${entFilter.clause} AND (project = ? OR project IS NULL)`
        ).all(...chunk, ...entFilter.params, normalizedProject) as EntityRow[];
        entityRows.push(...rows);
      } else {
        const rows = this.db.prepare(
          `SELECT id, name, entity_type AS entityType, project, updated_at, created_at FROM entities
           WHERE normalized_name IN (${placeholders}) AND ${entFilter.clause}`
        ).all(...chunk, ...entFilter.params) as EntityRow[];
        entityRows.push(...rows);
      }
    }

    const entities = this.buildEntities(entityRows, asOf);

    // Touch last_accessed_at — naming an entity is intent. Skip for historical reads.
    if (!asOf && entityRows.length > 0) {
      this.touchEntities(entityRows.map(e => e.id));
    }

    // When project-filtered, use AND logic for relations (both endpoints in result set);
    // when unfiltered, use OR logic (at least one endpoint matches) for backward compat.
    // We pass the canonical display names returned by the entity rows; getConnectedRelations
    // will re-normalize them for the actual lookup against relations.from_entity/to_entity.
    const displayNames = entityRows.map(e => e.name);
    if (projectId) {
      // Build the name set from both display names AND normalized names. This handles the
      // COALESCE fallback in getConnectedRelations: when a relation endpoint's entity is
      // soft-deleted, the LEFT JOIN misses and COALESCE returns the normalized form instead
      // of the display form. Without the normalized form in the set, those relations would
      // be silently dropped from project-scoped results (issue #55).
      const entityNameSet = new Set(displayNames);
      for (const name of displayNames) {
        try {
          entityNameSet.add(normalizeEntityName(name));
        } catch {
          // Name can't be normalized — display form is already in the set.
        }
      }
      const allRelations = this.getConnectedRelations(displayNames, asOf);
      // r.from / r.to are COALESCE(display, normalized) — check both forms via the set.
      const filteredRelations = allRelations.filter(r =>
        entityNameSet.has(r.from) && entityNameSet.has(r.to)
      );
      return { entities, relations: filteredRelations };
    }

    const relations = this.getConnectedRelations(displayNames, asOf);
    return { entities, relations };
  }

  /**
   * Lists all distinct project names that have at least one entity.
   * Global entities (project IS NULL) are excluded from the list.
   *
   * @returns Sorted array of project name strings
   */
  async listProjects(): Promise<string[]> {
    // Exclude soft-deleted entities — listProjects shows projects with at least
    // one currently-active entity. A project where every entity has been
    // soft-deleted should not appear in the list. (Historical/timeline access
    // for those projects is still available via entityTimeline by name.)
    const rows = this.db.prepare(
      `SELECT DISTINCT project FROM entities WHERE project IS NOT NULL AND superseded_at = '' ORDER BY project`
    ).all() as { project: string }[];
    return rows.map(r => r.project);
  }

  /**
   * Invalidates relations by setting superseded_at to current timestamp.
   * The relation row is preserved for history — it just won't appear in active queries.
   * Idempotent: already-invalidated relations (superseded_at != '') are unaffected
   * because the WHERE clause only matches active rows.
   *
   * @param relations - Array of { from, to, relationType } identifying relations to invalidate
   */
  async invalidateRelations(relations: InvalidateRelationInput[]): Promise<number> {
    const now = new Date().toISOString();
    // After v8, relations.from_entity / to_entity hold the NORMALIZED form, so
    // bind normalized values to match what's actually stored.
    // Only update active relations (superseded_at = '') — already-invalidated are skipped.
    const invalidate = this.db.prepare(
      `UPDATE relations SET superseded_at = ?
       WHERE from_entity = ? AND to_entity = ? AND relation_type = ? AND superseded_at = ''`
    );
    let totalChanged = 0;
    const txn = this.db.transaction(() => {
      for (const r of relations) {
        // Idempotent — bad names just match nothing.
        let fromNorm: string, toNorm: string;
        try {
          fromNorm = normalizeEntityName(r.from);
          toNorm = normalizeEntityName(r.to);
        } catch {
          continue;
        }
        const result = invalidate.run(now, fromNorm, toNorm, r.relationType);
        totalChanged += result.changes;
      }
    });
    txn();

    // Touch last_accessed_at on endpoint entities — invalidating a relation is a write.
    if (totalChanged > 0) {
      const endpointNames = new Set<string>();
      for (const r of relations) {
        try { endpointNames.add(normalizeEntityName(r.from)); } catch { /* skip */ }
        try { endpointNames.add(normalizeEntityName(r.to)); } catch { /* skip */ }
      }
      this.touchEntitiesByName([...endpointNames]);
    }

    this.maybeRunEviction();
    return totalChanged;
  }

  /**
   * Returns full timeline for an entity including ALL observations and relations
   * (both active and superseded). This is the "history view" — unlike readGraph/searchNodes
   * which only show active items, this shows the complete change history.
   *
   * @param entityName - The entity to retrieve timeline for
   * @param projectId - Optional project scope (entity must belong to this project or be global)
   * @returns EntityTimelineResult with observations and relations sorted chronologically, or null if not found
   */
  async entityTimeline(entityName: string, projectId?: string): Promise<EntityTimelineResult | null> {
    const normalizedProject = projectId ?? null;

    // Normalize the input entity name into its canonical identity key. The timeline
    // aggregates across all surface variants of the same name (e.g. 'Dustin Space',
    // 'dustin-space', 'DustinSpace' all collapse to 'dustinspace'). If the caller
    // supplies an unparseable name, treat it as "no such entity" — read operations
    // are idempotent.
    let normalizedName: string;
    try {
      normalizedName = normalizeEntityName(entityName);
    } catch {
      return null;
    }

    // Find ALL entity rows with this normalized name. After v7 (soft-delete), the
    // same identity key can legitimately have multiple rows: at most one active row
    // plus any number of historical soft-deleted rows. Order them so the active row
    // (if any) comes first; otherwise the most recently soft-deleted row. This is
    // what we use for entity-level metadata. The timeline aggregates observations
    // across ALL incarnations of the identity key.
    let entitySql = `SELECT id, name, entity_type, project, updated_at, created_at, superseded_at
                     FROM entities WHERE normalized_name = ?`;
    const params: (string | null)[] = [normalizedName];
    if (normalizedProject) {
      // Include entities belonging to this project OR global entities (project IS NULL)
      entitySql += ' AND (project = ? OR project IS NULL)';
      params.push(normalizedProject);
    }
    // Active row (superseded_at='') sorts first; among soft-deleted rows, most recent first.
    // SQLite booleans return 0/1, so `superseded_at = ''` sorts true (active) above false.
    entitySql += ` ORDER BY (superseded_at = '') DESC, created_at DESC`;

    const entityRows = this.db.prepare(entitySql).all(...params) as {
      id: number; name: string; entity_type: string;
      project: string | null; updated_at: string; created_at: string; superseded_at: string;
    }[];

    if (entityRows.length === 0) return null;
    // Use the first row (active if any, else most recent soft-deleted) as the canonical metadata.
    const entityRow = entityRows[0];
    // Collect all entity IDs for the observation lookup so we get the full history
    // across re-creation cycles.
    const allEntityIds = entityRows.map(r => r.id);

    // Touch last_accessed_at — viewing history expresses intent. Only touch active rows.
    const activeIds = entityRows.filter(r => r.superseded_at === '').map(r => r.id);
    this.touchEntities(activeIds);
    const idPlaceholders = allEntityIds.map(() => '?').join(',');

    // Fetch ALL observations (active AND superseded) across ALL incarnations of the
    // name, sorted chronologically. Unlike buildEntities() which filters
    // superseded_at = '', this returns everything for the timeline view.
    const obsRows = this.db.prepare(`
      SELECT content, created_at, superseded_at, tombstoned_at
      FROM observations WHERE entity_id IN (${idPlaceholders})
      ORDER BY created_at ASC
    `).all(...allEntityIds) as { content: string; created_at: string; superseded_at: string; tombstoned_at: string }[];

    // Map DB rows to TimelineObservation with computed status field.
    // Three states: active (superseded_at=''), tombstoned (tombstoned_at!='', content stripped
    // by eviction), or superseded (retired by a newer version).
    const observations: TimelineObservation[] = obsRows.map(o => ({
      content: o.content,
      createdAt: o.created_at,
      supersededAt: o.superseded_at,
      status: o.tombstoned_at !== '' ? 'tombstoned' as const
            : o.superseded_at === '' ? 'active' as const
            : 'superseded' as const,
    }));

    // Fetch ALL relations (active AND superseded) involving this entity.
    // Unlike getConnectedRelations() which filters active only, this returns everything.
    // After v8, relations.from_entity / to_entity store the NORMALIZED form, so
    // bind the normalized name. LEFT JOIN entities twice (once per endpoint) to
    // translate the stored normalized form back to the canonical display name.
    // COALESCE falls back to the normalized form if no active entity row matches
    // (e.g. the related entity has been soft-deleted with no active replacement).
    const relRows = this.db.prepare(`
      SELECT
        COALESCE(ef.name, r.from_entity) AS from_entity,
        COALESCE(et.name, r.to_entity)   AS to_entity,
        r.relation_type,
        r.created_at,
        r.superseded_at,
        r.tombstoned_at
      FROM relations r
      LEFT JOIN entities ef ON ef.normalized_name = r.from_entity AND ef.superseded_at = ''
      LEFT JOIN entities et ON et.normalized_name = r.to_entity   AND et.superseded_at = ''
      WHERE r.from_entity = ? OR r.to_entity = ?
      ORDER BY r.created_at ASC
    `).all(normalizedName, normalizedName) as {
      from_entity: string; to_entity: string; relation_type: string;
      created_at: string; superseded_at: string; tombstoned_at: string;
    }[];

    // Map DB rows to TimelineRelation with computed status field.
    // Same three-state logic as observations: tombstoned > superseded > active.
    const relations: TimelineRelation[] = relRows.map(r => ({
      from: r.from_entity,
      to: r.to_entity,
      relationType: r.relation_type,
      createdAt: r.created_at,
      supersededAt: r.superseded_at,
      status: r.tombstoned_at !== '' ? 'tombstoned' as const
            : r.superseded_at === '' ? 'active' as const
            : 'superseded' as const,
    }));

    return {
      name: entityRow.name,
      entityType: entityRow.entity_type,
      project: entityRow.project,
      createdAt: entityRow.created_at,
      updatedAt: entityRow.updated_at,
      observations,
      relations,
    };
  }

  /**
   * Returns a concise summary snapshot for session-start briefings.
   * Three sections: top observations by importance, recently updated entities,
   * and aggregate stats.
   *
   * @param projectId - Optional project scope. Includes project + global entities.
   * @param excludeContextLayers - When true, excludes L0/L1 observations to avoid
   *   double-loading when used alongside getContextLayers(). Default false.
   * @param limit - Max top observations to return (default 20, max 100).
   * @returns SummaryResult with topObservations, recentEntities, and stats
   */
  async getSummary(projectId?: string, excludeContextLayers?: boolean, limit?: number): Promise<Readonly<SummaryResult>> {
    const obsLimit = Math.min(Math.max(limit ?? 20, 1), 100);

    // Build project filter clause — reused across all three queries.
    const projectClause = projectId !== undefined
      ? `AND (e.project = ? OR e.project IS NULL)`
      : '';
    const projectParams = projectId !== undefined ? [projectId] : [];

    // Optional filter: exclude L0/L1 observations when caller already has them
    // from get_context_layers (prevents double-loading).
    const layerClause = excludeContextLayers
      ? `AND o.context_layer IS NULL`
      : '';

    // -- 1. Top observations by importance DESC, then entity recency DESC --
    const topObs = this.db.prepare(`
      SELECT e.name AS entityName, o.content, o.importance, o.memory_type, e.updated_at
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.superseded_at = ''
        AND e.superseded_at = ''
        ${layerClause}
        ${projectClause}
      ORDER BY o.importance DESC, e.updated_at DESC
      LIMIT ?
    `).all(...projectParams, obsLimit) as Array<{
      entityName: string; content: string; importance: number;
      memory_type: string | null; updated_at: string;
    }>;

    // Map DB column names (snake_case) to interface field names (camelCase).
    const topObservations: SummaryObservation[] = topObs.map(row => ({
      entityName: row.entityName,
      content: row.content,
      importance: row.importance,
      memoryType: row.memory_type ?? null,
      updatedAt: row.updated_at ?? '',
    }));

    // -- 2. Recently updated entities (last 5) --
    const entityProjectClause = projectId !== undefined
      ? `AND (project = ? OR project IS NULL)`
      : '';

    const recentRows = this.db.prepare(`
      SELECT name, entity_type, updated_at,
        (SELECT COUNT(*) FROM observations WHERE entity_id = e.id AND superseded_at = '') AS obs_count
      FROM entities e
      WHERE superseded_at = ''
        ${entityProjectClause}
      ORDER BY updated_at DESC
      LIMIT 5
    `).all(...projectParams) as Array<{
      name: string;
      entity_type: string;
      updated_at: string;
      obs_count: number;
    }>;

    const recentEntities: SummaryEntity[] = recentRows.map(row => ({
      name: row.name,
      entityType: row.entity_type,
      observationCount: row.obs_count,
      updatedAt: row.updated_at,
    }));

    // -- 3. Aggregate stats --
    // Use separate count queries — simple and efficient.
    const entityCount = (this.db.prepare(
      `SELECT COUNT(*) AS c FROM entities WHERE superseded_at = ''`
    ).get() as { c: number }).c;

    const obsCount = (this.db.prepare(
      `SELECT COUNT(*) AS c FROM observations WHERE superseded_at = ''`
    ).get() as { c: number }).c;

    const relCount = (this.db.prepare(
      `SELECT COUNT(*) AS c FROM relations WHERE superseded_at = ''`
    ).get() as { c: number }).c;

    const projectCount = (this.db.prepare(
      `SELECT COUNT(DISTINCT project) AS c FROM entities WHERE superseded_at = '' AND project IS NOT NULL`
    ).get() as { c: number }).c;

    return {
      topObservations,
      recentEntities,
      stats: {
        totalEntities: entityCount,
        totalObservations: obsCount,
        totalRelations: relCount,
        projectCount,
      },
    };
  }

  // -- Token budget constant for context layers (from spec §7) --
  // L1 budget: ~800 tokens ≈ 3200 chars. Session-start context — updated frequently.
  // L0 has no budget enforcement by design: core identity/rules are always included
  // regardless of size (~100 tokens is a guideline, not a hard cap).
  private static readonly L1_CHAR_BUDGET = 3200;

  /**
   * Returns L0 and L1 observations for a project, sorted by layer then importance DESC.
   * Enforces soft token budgets: observations that would exceed the budget are truncated
   * (most important ones kept). Designed to be called by SessionStart / PostCompact hooks.
   *
   * @param projectId - Optional project scope. When set, includes project + global entities.
   * @param layers - Which layers to return. Defaults to ['L0', 'L1'].
   * @returns ContextLayersResult with L0 and L1 arrays plus tokenEstimate
   */
  async getContextLayers(projectId?: string, layers?: string[]): Promise<Readonly<ContextLayersResult>> {
    // Default to both layers if not specified.
    const requestedLayers = new Set(layers ?? ['L0', 'L1']);

    // Build the project filter — same pattern as readGraph: include project + global entities.
    const projectClause = projectId !== undefined
      ? `AND (e.project = ? OR e.project IS NULL)`
      : '';
    const projectParams = projectId !== undefined ? [projectId] : [];

    // Build the layer filter — only query layers that were requested.
    const layerValues = [...requestedLayers].filter(l => l === 'L0' || l === 'L1');
    if (layerValues.length === 0) {
      return { L0: [], L1: [], tokenEstimate: 0 };
    }
    const layerPlaceholders = layerValues.map(() => '?').join(', ');

    // Single query: fetch all matching observations with their entity's display name
    // and updated_at. Sorted by layer (L0 first) then importance DESC.
    const rows = this.db.prepare(`
      SELECT e.name AS entityName, o.content, o.importance, o.context_layer, o.memory_type, e.updated_at
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.superseded_at = ''
        AND e.superseded_at = ''
        AND o.context_layer IN (${layerPlaceholders})
        ${projectClause}
      ORDER BY o.context_layer ASC, o.importance DESC, e.updated_at DESC
    `).all(...layerValues, ...projectParams) as Array<{
      entityName: string;
      content: string;
      importance: number;
      context_layer: string;
      memory_type: string | null;
      updated_at: string;
    }>;

    // Partition into L0 and L1 arrays, applying character budgets.
    const L0: ContextLayerObservation[] = [];
    const L1: ContextLayerObservation[] = [];
    let l0Chars = 0;
    let l1Chars = 0;

    for (const row of rows) {
      const charCost = row.entityName.length + row.content.length;

      if (row.context_layer === 'L0' && requestedLayers.has('L0')) {
        // L0 observations always included — but track char count for token estimate.
        l0Chars += charCost;
        L0.push({
          entityName: row.entityName,
          content: row.content,
          importance: row.importance,
          memoryType: row.memory_type,
          // L0 omits updatedAt per spec — these are identity/rules, not timestamped context.
        });
      } else if (row.context_layer === 'L1' && requestedLayers.has('L1')) {
        // L1 observations truncated at budget — most important first (already sorted).
        if (l1Chars + charCost > SqliteStore.L1_CHAR_BUDGET && L1.length > 0) {
          // Budget exceeded — stop adding L1 observations. Using break (not continue)
          // ensures we don't bin-pack smaller lower-importance observations past a
          // larger higher-importance one that didn't fit. The first one always gets
          // included even if it alone exceeds the budget (the L1.length > 0 guard).
          break;
        }
        l1Chars += charCost;
        L1.push({
          entityName: row.entityName,
          content: row.content,
          importance: row.importance,
          memoryType: row.memory_type,
          updatedAt: row.updated_at,
        });
      }
    }

    // Token estimate: rough chars / 4 approximation.
    const totalChars = l0Chars + l1Chars;
    const tokenEstimate = Math.ceil(totalChars / 4);

    return { L0, L1, tokenEstimate };
  }

  /**
   * Updates importance, context_layer, and/or memory_type on existing active
   * observations in-place. Does NOT change content, timestamps, or embeddings —
   * the observation's identity is preserved, which means the vec_observations row
   * (keyed on content embedding) stays valid.
   *
   * The observation is identified by (entityName, content) where entityName is
   * resolved via normalized_name (schema v8) so any surface variant works.
   *
   * Transaction-wrapped: all updates succeed or all fail. Entity's updated_at is
   * bumped when any of its observations are modified.
   *
   * @param updates - Array of SetObservationMetadataInput. Each must have at least
   *                  one of importance, contextLayer, or memoryType present.
   * @returns Number of observations actually updated (0 if content not found)
   * @throws Error if an entity name doesn't resolve to any active entity
   */
  async setObservationMetadata(updates: SetObservationMetadataInput[]): Promise<number> {
    if (updates.length === 0) return 0;

    let totalUpdated = 0;
    const now = new Date().toISOString();

    // Set of entity IDs whose updated_at needs bumping (deduped so we don't
    // bump the same entity multiple times if multiple observations are updated).
    const touchedEntityIds = new Set<number>();

    this.db.transaction(() => {
      for (const u of updates) {
        // Resolve entity by normalized name — any surface variant works.
        const normalizedName = normalizeEntityName(u.entityName);
        const entity = this.db.prepare(
          `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
        ).get(normalizedName) as { id: number } | undefined;

        if (!entity) {
          throw new Error(`Entity with name ${u.entityName} not found`);
        }

        // Build dynamic SET clause — only include fields that were explicitly
        // provided. We use 'key in object' checks (not !== undefined) so that
        // passing contextLayer: null or memoryType: null explicitly sets them
        // to NULL (demotes / unclassifies), while omitting the key entirely
        // leaves the existing value untouched.
        const setClauses: string[] = [];
        const params: (string | number | null)[] = [];

        if ('importance' in u) {
          setClauses.push('importance = ?');
          params.push(u.importance!);
        }
        if ('contextLayer' in u) {
          setClauses.push('context_layer = ?');
          params.push(u.contextLayer ?? null);
        }
        if ('memoryType' in u) {
          setClauses.push('memory_type = ?');
          params.push(u.memoryType ?? null);
        }

        // Nothing to update — skip this entry.
        if (setClauses.length === 0) continue;

        // Append the WHERE params: entity_id and content (exact match on active obs).
        params.push(entity.id, u.content);

        const result = this.db.prepare(
          `UPDATE observations SET ${setClauses.join(', ')}
           WHERE entity_id = ? AND content = ? AND superseded_at = ''`
        ).run(...params);

        totalUpdated += result.changes;
        if (result.changes > 0) {
          touchedEntityIds.add(entity.id);
        }
      }

      // Bump updated_at and last_accessed_at on every entity that had at least one
      // observation modified — writes are the strongest access signal.
      if (touchedEntityIds.size > 0) {
        const updateEntity = this.db.prepare(
          'UPDATE entities SET updated_at = ?, last_accessed_at = ? WHERE id = ?'
        );
        for (const id of touchedEntityIds) {
          updateEntity.run(now, now, id);
        }
      }
    })();

    this.maybeRunEviction();
    return totalUpdated;
  }
}
