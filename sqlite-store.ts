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
  type CheckDuplicateInput,
  type CheckDuplicatesResponse,
  type DuplicateMatch,
  type ConnectedContextOptions,
  type ConnectedContextResult,
  type ConnectedNode,
  type PrecedentMatch,
  type FindPrecedentsResult,
  type FindPrecedentsOptions,
  type SearchOrderBy,
} from './types.js';
import { fuseRanks, toFtsQuery, activationScore } from './rank-fusion.js';
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

// Which Claude Code instance is running. Set via MEMORY_INSTANCE_NAME env var
// in the MCP server config (e.g. "fedora", "windows-mele"). Tagged on every
// observation at insert time so cross-instance setups can trace provenance.
// 'unknown' is the fallback when the env var isn't set — makes misconfigured
// instances visible rather than silently producing untagged observations.
const SOURCE_INSTANCE = process.env.MEMORY_INSTANCE_NAME || 'unknown';

/**
 * Final ranking stage for findPrecedents: gate by the minSimilarity floor, rank by similarity
 * DESC, cap at `limit`, and round similarity to 3 decimals for display.
 *
 * The ORDER here is load-bearing (Finding E): the floor and the sort run on the RAW cosine, and
 * rounding is the LAST, display-only step (after slice). Rounding before the floor would let a
 * 0.2496 cosine round up to 0.250 and slip past a 0.25 floor (a boundary leak surfacing a
 * sub-floor precedent as if it cleared the bar — a Goal-A drift); rounding before the sort could
 * also reorder near-ties. Extracted as a pure function so this invariant is unit-testable WITHOUT
 * loading the embedding model (per the project's compute-expensive-testing rule: exercise the
 * logic around the expensive resource cheaply, the resource itself in a small opt-in suite).
 *
 * @param precedents - hydrated matches carrying RAW cosine in `.similarity`
 * @param minSimilarity - cosine floor; gates on the raw value
 * @param limit - max matches to return
 * @returns filtered + raw-DESC-sorted + capped matches, with `.similarity` rounded for display
 */
export function rankAndFloorPrecedents(precedents: PrecedentMatch[], minSimilarity: number, limit: number): PrecedentMatch[] {
  return precedents
    .filter(p => p.similarity >= minSimilarity)        // gate on raw cosine
    .sort((a, b) => b.similarity - a.similarity)        // rank on raw cosine
    .slice(0, limit)
    .map(p => ({ ...p, similarity: Math.round(p.similarity * 1000) / 1000 })); // round for display only
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
    // Wait up to 5 seconds if another process holds the write lock (e.g. weekly
    // consolidation running concurrently with an active Claude session). Without
    // this, better-sqlite3 defaults to 0ms and throws SQLITE_BUSY immediately.
    this.db.pragma('busy_timeout = 5000');
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
    //   9 = added tombstoned_at + last_accessed_at for eviction (§12)
    //  10 = added source_instance to observations for multi-machine tracking
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

    if (currentVersion < 10) {
      // Migration 9 → 10: source instance tracking for multi-machine setups.
      //
      // Adds `source_instance` to observations so each observation records which
      // Claude Code instance (machine/environment) created it. The value comes
      // from the MEMORY_INSTANCE_NAME env var at insert time.
      //
      // Why on observations (not entities): the same entity ("dustin" profile,
      // "working-relationship") can have observations from multiple machines.
      // The entity is global; provenance is per-observation.
      //
      // Queries do NOT filter by source_instance — cross-instance visibility is
      // the point. The only consumer that filters is the audit/freshness hook,
      // which checks file mtimes that are instance-local.
      //
      // DEFAULT 'unknown' (not NULL) prevents query issues with NULL comparisons
      // and makes misconfigured instances visible rather than silently broken.
      this.db.transaction(() => {
        // try-catch on ALTER TABLE: when multiple MCP server instances share
        // the same database (11 concurrent sessions in this deployment), they
        // all read schema_version=9 and race to migrate. The first one adds
        // the column; the rest hit "duplicate column name". Catching that
        // specific error lets the losers continue to the idempotent backfill
        // and version bump without crashing. (Issue #78.)
        try {
          this.db.prepare(
            `ALTER TABLE observations ADD COLUMN source_instance TEXT NOT NULL DEFAULT 'unknown'`
          ).run();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('duplicate column name')) throw err;
          // Another process already added the column — safe to continue.
        }

        // Backfill: all existing observations came from the Fedora machine.
        // WHERE clause makes this idempotent — re-running after a race doesn't
        // overwrite observations that were already correctly tagged.
        this.db.prepare(
          `UPDATE observations SET source_instance = 'fedora' WHERE source_instance = 'unknown'`
        ).run();

        this.db.prepare('UPDATE schema_version SET version = 10').run();
        // IMMEDIATE retrofitted alongside v12's fix (Discussion #84): this
        // migration shares the deferred-transaction shape whose loser could
        // die on SQLITE_BUSY_SNAPSHOT instead of reaching the duplicate-column
        // catch above. Same one-word fix, same rationale as v11/v12.
      }).immediate();
      currentVersion = 10;
    }

    if (currentVersion < 11) {
      // Migration 10 → 11: FTS5 full-text index over observation content.
      //
      // External-content FTS5 table + sync TRIGGERS (not code-level sync). Why
      // triggers: evict.ts writes observations via raw SQL, deliberately bypassing
      // GraphStore (the §12 observer-effect rule), and future migrations may too —
      // DB-level triggers catch every writer; a code-level sync helper would miss
      // them silently.
      //
      // The index holds ALL observations, active and superseded: supersede/delete
      // only UPDATE superseded_at, which fires no content trigger. Active-only
      // filtering therefore lives in exactly ONE place — the query-time
      // `JOIN observations o ON o.id = obs_fts.rowid AND o.superseded_at = ''`.
      // Keeping the triggers unconditional also keeps them correct: an
      // external-content FTS5 'delete' command must be fed the EXACT content the
      // index holds, which is only guaranteed when every content change flows
      // through the same trigger set.
      //
      // tokenize: unicode61 with remove_diacritics 2 — folds case AND accents,
      // an improvement over LIKE's ASCII-only case folding (Known Limitations).
      //
      // Race safety (Issue #78 — concurrent server instances migrate in parallel):
      // IF NOT EXISTS on table + triggers makes losers no-op, and losers SKIP the
      // corpus-sized 'rebuild' via the in-transaction version re-check below.
      // The transaction is IMMEDIATE (write lock taken at BEGIN), which is what
      // makes the re-check sound: a DEFERRED transaction would read version=10
      // under a pre-commit snapshot and then die with SQLITE_BUSY_SNAPSHOT on its
      // first write (busy_timeout does not retry snapshot conflicts) — the
      // re-check must happen under the write lock to observe the winner's commit.
      // (Caught in review cross-exam, Discussion #82.)
      this.db.transaction(() => {
        const v = (this.db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
        if (v >= 11) return; // another instance already migrated — skip the rebuild
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
            content,
            content='observations',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
          );
          CREATE TRIGGER IF NOT EXISTS obs_fts_ai AFTER INSERT ON observations BEGIN
            INSERT INTO obs_fts(rowid, content) VALUES (new.id, new.content);
          END;
          CREATE TRIGGER IF NOT EXISTS obs_fts_ad AFTER DELETE ON observations BEGIN
            INSERT INTO obs_fts(obs_fts, rowid, content) VALUES ('delete', old.id, old.content);
          END;
          CREATE TRIGGER IF NOT EXISTS obs_fts_au AFTER UPDATE OF content ON observations BEGIN
            INSERT INTO obs_fts(obs_fts, rowid, content) VALUES ('delete', old.id, old.content);
            INSERT INTO obs_fts(rowid, content) VALUES (new.id, new.content);
          END;
        `);
        // Rebuild pulls every existing observations row into the index in one
        // statement — this is what indexes the pre-v11 corpus.
        this.db.exec(`INSERT INTO obs_fts(obs_fts) VALUES ('rebuild')`);
        this.db.prepare('UPDATE schema_version SET version = 11').run();
      }).immediate();
      currentVersion = 11;
    }

    if (currentVersion < 12) {
      // Migration 11 → 12: access_count for retrieval strengthening (Phase B).
      //
      // WHY: last_accessed_at alone can't distinguish "touched once last week"
      // from "reached for forty times" — the ACT-R activation term in
      // rank-fusion.ts needs the count. Human memory strengthens with retrieval
      // (the testing effect); this column is the substrate for that.
      //
      // PARITY RULE: access_count increments at EXACTLY the sites that write
      // last_accessed_at — the touchEntities helpers AND the inline writers
      // (createEntities' INSERT seeds 1; the four updated_at+last_accessed_at
      // UPDATEs increment). One concept, two columns. WHY parity over
      // "retrieval-only" counting: supersede-heavy entities (continuity
      // threads, checkpointed every session) are among the most-used memories
      // but are mostly WRITTEN — retrieval-only counting would rank them as
      // never-accessed. readGraph and evict.ts's raw SQL write neither column.
      // No backfill — there is no historical access data to backfill from;
      // DEFAULT 0 = "never counted", which activationScore ranks last (-Infinity).
      //
      // DEF-RR-03 (deliberately not wired): access_count could later feed the
      // eviction tiers as a retention signal; left as a comment-only note.
      //
      // Race safety: same try-catch-duplicate-column pattern as v10 (Issue #78 —
      // concurrent instances race the ALTER; losers continue to the version bump),
      // PLUS IMMEDIATE like v11: even a write-first migration can pin a read
      // snapshot at prepare() time inside a deferred transaction and die with
      // SQLITE_BUSY_SNAPSHOT instead of reaching the duplicate-column catch.
      // (The snapshot mechanism is a review hypothesis — Discussion #84 — and
      // isn't testable without a two-process harness [DEF-RR-04]; IMMEDIATE is
      // free and structurally closes the question either way.)
      this.db.transaction(() => {
        try {
          this.db.prepare(
            `ALTER TABLE entities ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`
          ).run();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('duplicate column name')) throw err;
          // Another process already added the column — safe to continue.
        }
        this.db.prepare('UPDATE schema_version SET version = 12').run();
      }).immediate();
      currentVersion = 12;
    }

    // === Indexes (idempotent, run on every startup) ===
    // idx_relations_to_entity: the UNIQUE composite index on relations has from_entity
    // as leftmost prefix, so from_entity IN (...) can use it. But to_entity IN (...)
    // in getConnectedRelations needs its own index to avoid full table scans.
    // Partial index on active relations only (superseded_at = '') since queries always filter.
    // Drop+recreate: v5 migration changed the schema, old non-partial index is stale.
    this.db.exec('DROP INDEX IF EXISTS idx_relations_to_entity;');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_to_entity_active ON relations(to_entity) WHERE superseded_at = '';`);
    // Mirror index on from_entity for the out-direction leg of multi-hop traversal
    // (getConnectedContext): the `edges` CTE is materialized ONCE per call (the recursive walk
    // joins against it), and this index lets that one materialization seek by from_entity
    // instead of full-scanning relations. Partial (active-only). NOTE: the partial predicate
    // only applies on the no-asOf path, where `superseded_at = ''` is a top-level conjunct.
    // When opts.asOf is set, temporalRelFilter emits `... AND (superseded_at = '' OR
    // superseded_at > ?)` — a disjunction the partial index can't satisfy, so asOf walks fall
    // back to a relations scan. Negligible at current scale (a once-per-call scan); if asOf
    // traversal ever gets hot on a large corpus, add a non-partial (from_entity, created_at,
    // superseded_at) index — but only if profiling shows the materialization is the bottleneck.
    // This is an index, not a schema_version change.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_from_entity_active ON relations(from_entity) WHERE superseded_at = '';`);

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
   * Updates `last_accessed_at` AND increments `access_count` on one or more
   * entities. Called by methods that represent intentional access: search_nodes,
   * open_nodes, entity_timeline, and all write operations. NOT called by
   * read_graph (bulk) or the eviction sweep (which uses raw SQL to avoid the
   * observer effect — see §12 of the v1.1 design spec).
   *
   * access_count (v12) follows the PARITY RULE: it increments at exactly the
   * sites that write last_accessed_at — these helpers plus the inline writers
   * (createEntities' INSERT, the four updated_at+last_accessed_at UPDATEs).
   * Together the two columns feed the ACT-R activation term (rank-fusion.ts)
   * that reranks relevance-mode search results toward frequently-and-recently-
   * accessed memories. If you add a new last_accessed_at write site, it must
   * increment access_count too (the v12 migration comment has the rationale).
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
        `UPDATE entities SET last_accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders}) AND superseded_at = ''`
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
        `UPDATE entities SET last_accessed_at = ?, access_count = access_count + 1 WHERE normalized_name IN (${placeholders}) AND superseded_at = ''`
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
    // access_count seeded to 1 (PARITY RULE — this INSERT writes last_accessed_at, so it counts;
    // same "encoding is the first presentation" rationale as createEntities).
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, normalized_name, entity_type, project, updated_at, created_at, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    );
    // Look up the auto-assigned id after inserting. Goes through normalized_name +
    // active filter so a hypothetical re-run (after partial crash) finds the right row
    // even if a soft-deleted shadow exists for the same display name.
    const getEntityId = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );
    // INSERT includes metadata columns — schema v6 guarantees they exist.
    // Legacy JSONL observations will have default values (3.0, null, null).
    // source_instance = 'fedora' for migrated data (all JSONL data predates multi-instance).
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type, source_instance) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
          insertObs.run(row.id, obs.content, obs.createdAt, obs.importance ?? 3.0, obs.contextLayer ?? null, obs.memoryType ?? null, 'fedora');
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
    // access_count starts at 1, not 0: ACT-R counts the encoding as the first
    // presentation, and the parity rule (access_count increments exactly where
    // last_accessed_at updates) keeps the two columns one concept, not two.
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, normalized_name, entity_type, project, updated_at, created_at, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
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
    // INSERT includes observation metadata columns + source_instance (schema v6/v10).
    // Defaults (3.0, NULL, NULL, SOURCE_INSTANCE) match the column defaults.
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type, source_instance) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
          const obsInfo = insertObs.run(row.id, o.content, o.createdAt, o.importance, o.contextLayer, o.memoryType, SOURCE_INSTANCE);
          if (obsInfo.changes > 0) {
            observations.push({ ...o, sourceInstance: SOURCE_INSTANCE });
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
    // INSERT includes metadata columns + source_instance (schema v6/v10)
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type, source_instance) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // Prepared statement to bump updated_at and last_accessed_at when observations
    // are added to an entity — writes are the strongest access signal.
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ?, last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?'
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
          const obs: Observation = { content, createdAt: now, importance, contextLayer, memoryType, sourceInstance: SOURCE_INSTANCE };
          const info = insertObs.run(row.id, content, now, importance, contextLayer, memoryType, SOURCE_INSTANCE);
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
        // Similarity check is best-effort — don't fail the whole operation.
        // But flag it on every result so the caller knows "no similarExisting"
        // means "check couldn't run" rather than "no duplicates exist."
        const detail = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`Similarity check failed: ${detail}`);
        for (const r of results) {
          r.similarityCheckFailed = true;
        }
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
    // Soft-delete: RETIRE the observation (stamp superseded_at) rather than DELETE FROM.
    // The row is kept — excluded from active queries by the superseded_at = '' filter,
    // but recoverable via asOf / entityTimeline — matching supersedeObservations and the
    // four-tier preservation model. Actual removal is the automatic eviction sweep's job,
    // never this method. (This aligns to the long-documented "Tier 2, recoverable" intent;
    // the prior hard DELETE FROM was the anomaly — see
    // docs/superpowers/plans/2026-05-30-delete-observations-soft-delete.md.)
    const softDeleteObs = this.db.prepare(
      `UPDATE observations SET superseded_at = ? WHERE entity_id = ? AND content = ? AND superseded_at = ''`
    );
    // Prepared statement to bump updated_at and last_accessed_at when observations
    // are retired from an entity — writes are the strongest access signal.
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ?, last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?'
    );

    const txn = this.db.transaction(() => {
      // One timestamp for the whole batch: the superseded_at marker and the entity
      // access bump share it.
      const now = new Date().toISOString();
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
        let anyRetired = false;
        for (const content of d.contents) {
          // Stamp superseded_at on the active row. The vec_observations embedding is
          // deliberately KEPT (not deleted) so asOf vector search can still recover the
          // historically-active observation — same rationale as supersedeObservations.
          const result = softDeleteObs.run(now, row.id, content);
          if (result.changes > 0) anyRetired = true;
        }
        // Only bump updated_at if observations were actually retired —
        // avoids spurious timestamp advances on no-op deletions (e.g., misspelled content)
        if (anyRetired) {
          updateTimestamp.run(now, now, row.id);
        }
      }
    });
    txn();
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
    // source_instance is set from the CURRENT instance (the one performing the supersede),
    // not carried forward — the new observation was authored by this instance.
    const insertObs = this.db.prepare(
      `INSERT OR IGNORE INTO observations (entity_id, content, created_at, importance, context_layer, memory_type, source_instance) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    // Bump entity's updated_at and last_accessed_at — writes are the strongest access signal.
    const updateTimestamp = this.db.prepare(
      'UPDATE entities SET updated_at = ?, last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?'
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
        insertObs.run(entityRow.id, s.newContent, now, obsRow.importance, obsRow.context_layer, obsRow.memory_type, SOURCE_INSTANCE);

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
               o.importance, o.context_layer, o.memory_type, o.source_instance
        FROM observations o
        WHERE o.entity_id IN (${placeholders}) AND ${obsFilter.clause}
      `).all(...chunk, ...obsFilter.params) as { entityId: number; content: string; createdAt: string;
        importance: number; context_layer: string | null; memory_type: string | null; source_instance: string }[];

      for (const o of obsRows) {
        if (!obsMap.has(o.entityId)) obsMap.set(o.entityId, []);
        obsMap.get(o.entityId)!.push({
          content: o.content,
          createdAt: o.createdAt,
          importance: o.importance ?? 3.0,
          contextLayer: o.context_layer ?? null,
          memoryType: o.memory_type ?? null,
          sourceInstance: o.source_instance ?? 'unknown',
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
  async searchNodes(query: string, projectId?: string, pagination?: PaginationParams, asOf?: string, memoryType?: string, orderBy?: SearchOrderBy): Promise<PaginatedKnowledgeGraph> {
    // Relevance mode is top-k only: rank is query-relative and shifts under
    // mutation, so a keyset cursor over it would silently skip or duplicate
    // results; and the FTS index holds only current content, so historical
    // (asOf) ranking would be quietly wrong. Reject both loudly rather than
    // degrade silently. NOTE: this guard is the ONLY enforcement point — the
    // MCP layer cannot cross-field-validate (registerTool takes a per-field
    // ZodRawShape with no cross-field refinement hook; see index.ts), so MCP
    // callers reach this guard directly. Do not remove it in favor of "the
    // Zod layer handles it" — it doesn't and can't.
    if (orderBy === 'relevance') {
      if (pagination?.cursor) {
        throw new Error("orderBy:'relevance' does not support cursor pagination — ranked results are top-k; omit the cursor");
      }
      if (asOf) {
        throw new Error("orderBy:'relevance' does not support asOf — the FTS index reflects current content only; use recency order for historical queries");
      }
    }

    const fingerprint = searchNodesFingerprint(projectId, query, asOf, memoryType);

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

    // memoryType filter: restrict to entities with at least one active observation
    // of the requested type. The observation JOIN is already in the CTE, so this
    // is just an additional WHERE clause. When omitted, all types are included.
    if (memoryType) {
      cteSql += ' AND o.memory_type = ?';
      cteParams.push(memoryType);
    }

    if (normalizedProject) {
      cteSql += ' AND (e2.project = ? OR e2.project IS NULL)';
      cteParams.push(normalizedProject);
    }
    cteSql += ')';

    // ── Relevance mode: fuse LIKE / FTS / vector candidate lists, return top-k ──
    // Branches here (after the CTE is assembled, before the recency outer query)
    // so both modes share ONE definition of "what matches" — the matched_ids CTE
    // with its project/memoryType/temporal filters. The recency path below is
    // untouched: existing callers (SessionStart hooks, paginating consumers) see
    // byte-identical behavior when orderBy is omitted.
    if (orderBy === 'relevance') {
      return this.searchNodesRanked(cteSql, cteParams, query, normalizedProject, memoryType, clampLimit(pagination?.limit));
    }

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
          // duplicates and multiple observations per entity. When memoryType is
          // set, use a larger k because the post-retrieval filter may discard most
          // results (e.g., 3 "decision" observations among 1000 total — a sparse
          // type would be drowned out in the global top-80).
          const baseK = (limit ?? 40) * 2;
          const knnK = Math.min(memoryType ? Math.max(baseK, 200) : baseK, 500);
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
              // memoryType filter: ensure vector matches also have a matching observation type.
              // Without this, a vector match for entity X could be included even if X has
              // no observations of the requested type — inconsistent with the LIKE path.
              if (memoryType) {
                vecSql += ' AND o.memory_type = ?';
                vecParams.push(memoryType);
              }
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
   * Relevance-ranked search: fuses three entity-level candidate lists with
   * weighted Reciprocal Rank Fusion (rank-fusion.ts) and returns the top-k.
   *
   * Receives: the matched_ids CTE (SQL + params) already assembled by
   * searchNodes — so LIKE matching, project scoping, and memoryType filtering
   * have ONE definition shared by both modes — plus the raw query for the FTS
   * and vector lists, and the clamped page limit.
   * Returns: PaginatedKnowledgeGraph with nextCursor always null (ranked
   * results are top-k by design — see the guard in searchNodes) and totalCount
   * = size of the fused candidate union AT COLLECTION TIME. Under concurrent
   * mutation an entity can be superseded between candidate collection and
   * hydration and silently drop from the page, so totalCount can exceed
   * entities.length; that is the documented semantic (candidate-union size),
   * not a bug — no subtraction is attempted because off-page casualties are
   * undetectable anyway (review Discussion #82, F3). rankingDegraded lists
   * candidate signals lost to errors/unavailability this call (see types.ts).
   *
   * The three lists and their weights (design: 2026-07-02 spec §4.5):
   *   1.0 LIKE  — substring recall over name/normalized/type/obs content,
   *               recency-ordered (its natural order; recency is a reasonable
   *               relevance prior among equal substring matches)
   *   1.0 FTS   — BM25 over observation content (precision: quoted-token AND)
   *   1.0 vector— KNN semantic matches, best-cosine-first (skipped unless the
   *               embedding model is ready — same graceful degradation as the
   *               recency path's augmentation)
   *   0.5 activation — ACT-R retrieval strength (access_count + recency of
   *               last access), computed ONLY over the union of the three
   *               lists above; reranks candidates, never nominates them.
   */
  private async searchNodesRanked(
    cteSql: string,
    cteParams: (string | number)[],
    query: string,
    normalizedProject: string | undefined,
    memoryType: string | undefined,
    limit: number,
  ): Promise<PaginatedKnowledgeGraph> {
    // List 1 — LIKE candidates from the shared CTE, recency-ordered (no cursor,
    // no LIMIT: the fused union IS the honest totalCount, and the corpus is
    // hundreds of entities — a full candidate list is microseconds here).
    const likeIds = (this.db.prepare(`
      ${cteSql}
      SELECT e.id FROM entities e JOIN matched_ids m ON m.id = e.id
      ORDER BY e.updated_at DESC, e.id DESC
    `).all(...cteParams) as { id: number }[]).map(r => r.id);

    // Degradation ledger (goal A: a lost candidate list changes result
    // MEMBERSHIP, so the caller must be able to tell a degraded run from a
    // healthy one — stderr alone is invisible over MCP). Populated by the
    // catch/skip sites below; attached to the result only when non-empty.
    const degraded: ('fts' | 'vector')[] = [];

    // List 2 — FTS/BM25 candidates, best score per entity. bm25() is
    // lower-is-better in SQLite FTS5, hence MIN + ASC. The superseded_at=''
    // join is the active-only filter (the index deliberately holds all rows —
    // see the v11 migration comment). try/catch: a MATCH failure (sanitizer
    // gap, malformed index) must degrade to no-FTS-list, not fail the search —
    // same best-effort contract as the vector augmentation.
    let ftsIds: number[] = [];
    try {
      // bm25() is an FTS5 AUXILIARY function: SQLite only allows it inside a
      // plain full-text query on the FTS table itself. Both a direct aggregate
      // (MIN(bm25(...)) + GROUP BY) AND a joined subquery fail with "unable to
      // use function bm25 in the requested context" — the second because the
      // query flattener folds the subquery back into the outer aggregate.
      // Empirically verified 2026-07-02 (both forms failed in the test suite).
      // The robust form: a MATERIALIZED CTE that is a PURE single-table
      // full-text query (MATCH + bm25 in the SELECT list, nothing else);
      // MATERIALIZED blocks the flattener, and all joins/filters/aggregation
      // operate on the CTE's already-plain rows.
      let ftsSql = `
        WITH scored AS MATERIALIZED (
          SELECT rowid AS obs_rowid, bm25(obs_fts) AS score
          FROM obs_fts WHERE obs_fts MATCH ?
        )
        SELECT o.entity_id AS id, MIN(s.score) AS best
        FROM scored s
        JOIN observations o ON o.id = s.obs_rowid AND o.superseded_at = ''
        JOIN entities e ON e.id = o.entity_id AND e.superseded_at = ''`;
      const ftsParams: (string | number)[] = [toFtsQuery(query)];
      if (memoryType) {
        ftsSql += ' WHERE o.memory_type = ?';
        ftsParams.push(memoryType);
      }
      if (normalizedProject) {
        ftsSql += memoryType ? ' AND' : ' WHERE';
        ftsSql += ' (e.project = ? OR e.project IS NULL)';
        ftsParams.push(normalizedProject);
      }
      ftsSql += ' GROUP BY o.entity_id ORDER BY best ASC LIMIT 200';
      ftsIds = (this.db.prepare(ftsSql).all(...ftsParams) as { id: number }[]).map(r => r.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Full error detail stays on stderr only — SQLite messages can echo SQL
      // fragments/paths; the caller gets the closed-enum flag, never err.message.
      console.error(`FTS candidate list failed (degrading to LIKE+vector): ${msg}`);
      degraded.push('fts');
    }

    // List 3 — vector KNN candidates mapped to entities, best-cosine-first.
    // Mirrors the recency path's augmentation block (same k policy, same
    // active/project/memoryType hydration filters, same never-throw contract);
    // differs in that KNN ORDER is preserved into an entity ranking:
    // walking knnRows best-first and keeping first-seen entity ids ranks each
    // entity by its single best-matching observation.
    let vecIds: number[] = [];
    const vecStatus = this.embeddingPipeline.state.status;
    if (this.vecTableExists && vecStatus === 'ready') {
      try {
        const queryEmbedding = await this.embeddingPipeline.embed(query);
        if (queryEmbedding) {
          const baseK = limit * 2;
          const knnK = Math.min(memoryType ? Math.max(baseK, 200) : baseK, 500);
          const knnRows = this.db.prepare(`
            SELECT observation_id, distance
            FROM vec_observations
            WHERE embedding MATCH ? AND k = ${knnK}
          `).all(
            Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength),
          ) as { observation_id: string; distance: number }[];

          if (knnRows.length > 0) {
            const obsIds = knnRows.map(r => parseInt(r.observation_id, 10));
            // Hydrate obs → entity with the same filters as the LIKE CTE.
            const obsToEntity = new Map<number, number>();
            for (let i = 0; i < obsIds.length; i += CHUNK_SIZE) {
              const chunk = obsIds.slice(i, i + CHUNK_SIZE);
              const placeholders = chunk.map(() => '?').join(',');
              let vecSql = `
                SELECT o.id AS obsId, e.id AS entId FROM observations o
                JOIN entities e ON o.entity_id = e.id AND e.superseded_at = ''
                WHERE o.id IN (${placeholders}) AND o.superseded_at = ''
              `;
              const vecParams: (string | number)[] = [...chunk];
              if (memoryType) {
                vecSql += ' AND o.memory_type = ?';
                vecParams.push(memoryType);
              }
              if (normalizedProject) {
                vecSql += ' AND (e.project = ? OR e.project IS NULL)';
                vecParams.push(normalizedProject);
              }
              const rows = this.db.prepare(vecSql).all(...vecParams) as { obsId: number; entId: number }[];
              for (const r of rows) obsToEntity.set(r.obsId, r.entId);
            }
            // knnRows is already distance-ordered; first-seen = best per entity.
            const seen = new Set<number>();
            for (const r of knnRows) {
              const entId = obsToEntity.get(parseInt(r.observation_id, 10));
              if (entId !== undefined && !seen.has(entId)) {
                seen.add(entId);
                vecIds.push(entId);
              }
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Vector candidate list failed (degrading to LIKE+FTS): ${msg}`);
        degraded.push('vector');
      }
    } else if (vecStatus !== 'unavailable') {
      // 'loading' (model still downloading/initializing), 'failed' (circuit
      // breaker tripped), or a missing vec table with vectors nominally on:
      // the semantic list SHOULD exist and doesn't — transient degradation the
      // caller deserves to see. 'unavailable' (MEMORY_VECTOR_SEARCH=off) is
      // deliberately NOT flagged: chosen configuration is not degradation, and
      // chronic flag noise would train callers to ignore the flag.
      degraded.push('vector');
    }

    // List 4 — ACT-R activation rerank over the candidate UNION (Phase B).
    // LOAD-BEARING CONSTRAINT: activation NEVER nominates — it is computed only
    // over entities already nominated by LIKE/FTS/vector. A global activation
    // list would let frequently-accessed-but-irrelevant entities flood every
    // query (spec §5.4). Weight 0.5 (half the relevance lists): retrieval
    // strength nudges among relevant candidates, it never overrides relevance.
    // Never-accessed entities (activationScore -Infinity) are EXCLUDED rather
    // than ranked last: appearing at the list's tail would still hand them RRF
    // points, and "no retrieval history" should contribute exactly nothing.
    const unionIds = [...new Set([...likeIds, ...ftsIds, ...vecIds])];
    let activationIds: number[] = [];
    if (unionIds.length > 0) {
      const nowMs = Date.now();
      const scored: { id: number; a: number }[] = [];
      for (let i = 0; i < unionIds.length; i += CHUNK_SIZE) {
        const chunk = unionIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = this.db.prepare(
          // superseded_at filter: an entity soft-deleted between candidate
          // collection and this lookup shouldn't occupy activation rank slots
          // (hydration would drop it anyway, but its slot would deflate the
          // RRF contribution of every entity ranked below it). Free predicate
          // on rows already fetched by rowid seek — no plan change.
          `SELECT id, access_count, last_accessed_at FROM entities WHERE id IN (${placeholders}) AND superseded_at = ''`
        ).all(...chunk) as { id: number; access_count: number; last_accessed_at: string }[];
        for (const r of rows) {
          const a = activationScore(r.access_count, r.last_accessed_at, nowMs);
          if (a > -Infinity) scored.push({ id: r.id, a });
        }
      }
      activationIds = scored
        .sort((x, y) => (y.a - x.a) || (y.id - x.id)) // deterministic tie-break, matches the fused sort
        .map(x => x.id);
    }

    // Fuse, rank (score DESC, id DESC for determinism on ties), take top-k.
    const fused = fuseRanks<number>([
      { weight: 1.0, ids: likeIds },
      { weight: 1.0, ids: ftsIds },
      { weight: 1.0, ids: vecIds },
      { weight: 0.5, ids: activationIds },
    ]);
    const ranked = [...fused.entries()]
      .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))
      .map(([id]) => id);
    const totalCount = ranked.length;
    const pageIds = ranked.slice(0, limit);

    if (pageIds.length === 0) {
      return {
        entities: [], relations: [], nextCursor: null, totalCount,
        ...(degraded.length > 0 ? { rankingDegraded: degraded } : {}),
      };
    }

    // Hydrate in fused order (SQL IN gives no ordering guarantee — reorder by map).
    // limit is clamped to <=100, safely under the 900-variable chunking threshold.
    const ph = pageIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT name, entity_type AS entityType, project, updated_at, created_at, id
      FROM entities WHERE id IN (${ph}) AND superseded_at = ''
    `).all(...pageIds) as { name: string; entityType: string; project: string | null; updated_at: string; created_at: string; id: number }[];
    const rowById = new Map(rows.map(r => [r.id, r]));
    const orderedRows = pageIds.flatMap(id => {
      const row = rowById.get(id);
      return row ? [row] : [];
    });
    const entities = this.buildEntities(orderedRows, undefined);

    // Touch last_accessed_at — targeted search expresses intent, same as the
    // recency path. (Relevance mode never has asOf; the guard rejected it.)
    if (entities.length > 0) {
      this.touchEntitiesByName(entities.map(e => normalizeEntityName(e.name)));
    }

    // Relations: both-endpoints-in-set, matching the paginated recency path's
    // semantics — a ranked page is a curated set, and half-dangling edges would
    // reference entities the caller can't see.
    const entityNames = new Set(entities.map(e => e.name));
    for (const entity of entities) {
      try {
        entityNames.add(normalizeEntityName(entity.name));
      } catch {
        // Name can't be normalized — display form is already in the set.
      }
    }
    const allRelations = this.getConnectedRelations([...entityNames], undefined);
    const relations = allRelations.filter(r => entityNames.has(r.from) && entityNames.has(r.to));

    return {
      entities, relations, nextCursor: null, totalCount,
      ...(degraded.length > 0 ? { rankingDegraded: degraded } : {}),
    };
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
   * Walks the relation graph outward from `seedEntity` up to maxHops, returning the
   * structurally-connected neighborhood: lightweight nodes (name/type/hopDistance/path,
   * NO observations) plus the active edges among them. Surfaces INDIRECT facts that
   * recency/semantic search misses — e.g. a sanction two hops from a loan applicant —
   * because the walk follows graph structure, not textual similarity.
   *
   * How it works: a non-recursive `edges` CTE materializes the direction-aware edge list
   * (out: from->to, in: to->from, both: either) over ACTIVE relations; the recursive `walk`
   * follows it from the seed. The `path` column (char(31)-separated normalized names) is
   * BOTH the cycle guard — a candidate already on the path is skipped, so cycles terminate —
   * and the shortest-path source. GROUP BY node with a single MIN(depth) collapses multi-path
   * arrivals to the nearest hop (SQLite assigns the bare `path` from that same min-depth row).
   * char(31) is a safe delimiter: normalizeEntityName strips the whole C0 control range
   * (\u0000-\u001f, which INCLUDES 0x1f = char(31)) plus whitespace/separators, so it can never
   * occur inside a stored normalized_name — see normalize-name.ts Step 3, where this exact
   * traversal invariant is the documented reason C0 stripping is not redundant with \s.
   *
   * Returns STRUCTURE ONLY (no observations) so deep/broad walks stay cheap on the caller's
   * context budget — fetch full content for the nodes that matter via openNodes.
   *
   * WORKLOAD NOTE (not a correctness bug; profile before optimizing): the cycle guard is
   * per-PATH, not global — `walk` materializes every distinct SIMPLE path to each node before
   * the outer `GROUP BY node` collapses them to MIN(depth). maxNodes caps the RETURNED rows in
   * JS, AFTER the CTE runs; it does NOT bound the CTE's work. So from a high-degree hub at large
   * maxHops with direction:'both' (which doubles every undirected edge into two directed edges),
   * intermediate simple-path count grows ~d·(d-1)^(h-1) and the synchronous better-sqlite3
   * .all() can block the single-threaded server. Safe at this server's scale (low avg degree),
   * and the maxHops ceiling (6) bounds h — but if a hubby corpus ever makes this hot, the fix is
   * a global visited-set / closure-table walk, decided by EXPLAIN QUERY PLAN + a degree-30
   * fixture, NOT a reflexive rewrite. Tracked as DEF-CG-01 in the causal-relations design doc.
   *
   * @param seedEntity - entity to traverse from (any surface form)
   * @param opts - maxHops (default 3), direction ('out'|'in'|'both', default 'both'),
   *               maxNodes (cap, default 50), relationTypes (case-insensitive type filter on
   *               the walked edges), asOf (point-in-time), projectId (scope reached nodes to
   *               that project + global; advisory, applied at hydration before the cap).
   */
  async getConnectedContext(seedEntity: string, opts: ConnectedContextOptions = {}): Promise<ConnectedContextResult> {
    const maxHops = opts.maxHops ?? 3;
    const maxNodes = opts.maxNodes ?? 50;
    const direction = opts.direction ?? 'both';

    // Normalize the seed to the stored identity form. A name that can't be normalized
    // (or that matches nothing) yields an empty neighborhood rather than throwing — read op.
    let seedNorm: string;
    try {
      seedNorm = normalizeEntityName(seedEntity);
    } catch {
      return { seed: seedEntity, nodes: [], relations: [], cycles: [], truncated: false };
    }

    // Direction-aware edge list. Each arm filters relations by the temporal window (active,
    // or active-as-of when opts.asOf is set) and, optionally, by relation_type. The type
    // filter is CASE-INSENSITIVE (UPPER both sides) so a 'works_for' edge matches a
    // 'WORKS_FOR' filter — callers shouldn't have to know the stored casing.
    const relFilter = this.temporalRelFilter(opts.asOf, '');
    let typeClause = '';
    let typeParams: string[] = [];
    if (opts.relationTypes && opts.relationTypes.length > 0) {
      typeClause = ` AND UPPER(relation_type) IN (${opts.relationTypes.map(() => '?').join(',')})`;
      typeParams = opts.relationTypes.map(t => t.toUpperCase());
    }
    const armWhere = `WHERE ${relFilter.clause}${typeClause}`;
    const armParams: (string | number)[] = [...relFilter.params, ...typeParams];
    const outArm = `SELECT from_entity AS src, to_entity AS dst FROM relations ${armWhere}`;
    const inArm = `SELECT to_entity AS src, from_entity AS dst FROM relations ${armWhere}`;
    const edgesSql =
      direction === 'out' ? outArm :
      direction === 'in' ? inArm :
      `${outArm} UNION ALL ${inArm}`;
    // Bind one set of arm params per arm present (out arm unless direction 'in'; in unless 'out').
    const edgeParams: (string | number)[] = [];
    if (direction !== 'in') edgeParams.push(...armParams);
    if (direction !== 'out') edgeParams.push(...armParams);

    // Recursive walk. Seed anchors at depth 0; each hop appends the neighbor to the path
    // unless it's already there (cycle guard — wrap path AND candidate in char(31) so the
    // seed at the path's head is matched). maxHops bounds depth.
    const walkRows = this.db.prepare(`
      WITH RECURSIVE
        edges(src, dst) AS (${edgesSql}),
        walk(node, depth, path) AS (
          SELECT ?, 0, ?
          UNION ALL
          SELECT e.dst, walk.depth + 1, walk.path || char(31) || e.dst
          FROM walk JOIN edges e ON e.src = walk.node
          WHERE walk.depth < ?
            AND instr(char(31) || walk.path || char(31), char(31) || e.dst || char(31)) = 0
        )
      SELECT node, MIN(depth) AS depth, path
      FROM walk
      GROUP BY node
    `).all(...edgeParams, seedNorm, seedNorm, maxHops) as { node: string; depth: number; path: string }[];

    // Reached nodes (exclude the seed at depth 0), nearest-hop first then name.
    const reached = walkRows
      .filter(r => r.depth >= 1)
      .sort((a, b) => a.depth - b.depth || a.node.localeCompare(b.node));

    // Translate normalized -> display name + entityType for the seed and every reached node,
    // scoped to the requested project when projectId is set (project = ? OR global). Only
    // ACTIVE entities surface — a relation can point at a soft-deleted identity, which is a
    // dead end for usable context.
    //
    // Hydrate + scope BEFORE applying maxNodes (not at the cap, not after): an out-of-project
    // or soft-deleted node must not consume a cap slot, or `truncated` would lie (report true
    // when nothing in-scope was actually truncated) and in-scope nodes that would have fit
    // could be dropped. So we resolve the full reached set first, then keep only nodes that
    // hydrated in-scope, then cap that filtered set. Project scoping is advisory (see CLAUDE.md
    // Known Limitations): the walk itself still traverses foreign nodes structurally, so an
    // in-scope node reachable only via a foreign intermediate is still returned, with the
    // foreign intermediate shown by its normalized name in `path`.
    const SEP = String.fromCharCode(31);
    const reachedNorms = new Set<string>([seedNorm]);
    for (const r of reached) reachedNorms.add(r.node);
    const entFilter = this.temporalEntFilter(opts.asOf, '');
    const projClause = opts.projectId ? ' AND (project = ? OR project IS NULL)' : '';
    const projParams: string[] = opts.projectId ? [opts.projectId] : [];
    const dispMap = new Map<string, { name: string; entityType: string }>();
    const normList = [...reachedNorms];
    for (let i = 0; i < normList.length; i += CHUNK_SIZE) {
      const chunk = normList.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT normalized_name, name, entity_type AS entityType FROM entities
         WHERE normalized_name IN (${placeholders}) AND ${entFilter.clause}${projClause}`
      ).all(...chunk, ...entFilter.params, ...projParams) as { normalized_name: string; name: string; entityType: string }[];
      for (const row of rows) dispMap.set(row.normalized_name, { name: row.name, entityType: row.entityType });
    }

    // The SEED is the anchor the caller named, NOT a reached node — project scoping applies to the
    // NEIGHBORHOOD, not the seed. When projectId is set and the seed belongs to a DIFFERENT project,
    // the project-filtered loop above won't have hydrated it. Resolve it here independently of the
    // project clause (temporal filter only) so: (a) `seed` reports the canonical display name, not
    // the raw caller string, and (b) the display-name inSet filter below keeps the seed's edges into
    // the scoped project instead of silently dropping them (the surface-variant edge-drop caught in
    // review). The guard skips this for the common in-project / no-projectId case (already hydrated).
    if (!dispMap.has(seedNorm)) {
      const seedRow = this.db.prepare(
        `SELECT name, entity_type AS entityType FROM entities WHERE normalized_name = ? AND ${entFilter.clause}`
      ).get(seedNorm, ...entFilter.params) as { name: string; entityType: string } | undefined;
      if (seedRow) dispMap.set(seedNorm, { name: seedRow.name, entityType: seedRow.entityType });
    }

    // Keep only reached nodes that resolved to an in-scope active entity, THEN cap. Filtering
    // before the cap is what makes `truncated` honest (see the hydration note above).
    const inScope = reached.filter(r => dispMap.has(r.node));
    const truncated = inScope.length > maxNodes;
    const capped = inScope.slice(0, maxNodes);

    // Build result nodes; skip reached identities with no active entity (dead ends).
    const nodes: ConnectedNode[] = [];
    for (const r of capped) {
      const disp = dispMap.get(r.node);
      if (!disp) continue;
      nodes.push({
        name: disp.name,
        entityType: disp.entityType,
        hopDistance: r.depth,
        path: r.path.split(SEP).filter(Boolean).map(p => dispMap.get(p)?.name ?? p),
      });
    }

    // Edges among the seed + reached nodes. Reuse the audited relation query (handles
    // normalized->display translation + dedup), then keep only edges whose BOTH endpoints
    // are in the returned set, so the relations describe exactly the returned subgraph.
    const seedDisp = dispMap.get(seedNorm)?.name ?? seedEntity;
    const inSet = new Set<string>([seedDisp, ...nodes.map(n => n.name)]);
    const relations = this.getConnectedRelations([...inSet], opts.asOf).filter(r => inSet.has(r.from) && inSet.has(r.to));

    // Mechanically detect directed cycles among the returned edges so circular logic is
    // flagged in the result rather than left for the caller to notice. The subgraph edge set
    // is bounded by maxNodes, so a plain recursive DFS is plenty.
    const cycles = this.detectDirectedCycles(relations);

    return { seed: seedDisp, nodes, relations, cycles, truncated };
  }

  /**
   * Detects directed cycles among a set of relations via DFS with recursion-stack (gray/black)
   * coloring: a back-edge to a node currently on the stack closes a cycle, which we reconstruct
   * from the stack. De-duplicated by node SET, so the same loop discovered from different entry
   * points isn't reported twice. Operates on the already-bounded subgraph edge set, so plain
   * recursion is safe at this scale.
   *
   * @param relations - directed edges (from -> to, display names)
   * @returns one array per distinct cycle: nodes round the loop with the entry node repeated at
   *          the end (e.g. ['A','B','C','A']); empty array if acyclic.
   */
  private detectDirectedCycles(relations: Relation[]): string[][] {
    const adj = new Map<string, string[]>();
    for (const r of relations) {
      if (!adj.has(r.from)) adj.set(r.from, []);
      adj.get(r.from)!.push(r.to);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const seen = new Set<string>();
    const visit = (node: string): void => {
      color.set(node, GRAY);
      stack.push(node);
      for (const next of adj.get(node) ?? []) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          // Back-edge: `next` is an ancestor on the current stack — cycle found.
          const idx = stack.indexOf(next);
          if (idx >= 0) {
            const loop = stack.slice(idx);
            // Collision-proof dedup key: JSON.stringify of the sorted node set. A delimiter-joined
            // string (even with a control char) can collide if a display name contains the delimiter,
            // and an invisible control byte in source is unreviewable. JSON quoting escapes any
            // character and the array structure is unambiguous, so distinct node sets never collide.
            const key = JSON.stringify([...loop].sort());
            if (!seen.has(key)) {
              seen.add(key);
              cycles.push([...loop, next]); // repeat entry node to close the loop visually
            }
          }
        } else if (c === WHITE) {
          visit(next);
        }
      }
      stack.pop();
      color.set(node, BLACK);
    };
    for (const node of adj.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    }
    return cycles;
  }

  /**
   * Retrieves observations RANKED by cosine similarity to `query`, reusing the same sqlite-vec
   * KNN path as dedup but ranking + returning instead of threshold-gating. Fills the "find the
   * most similar prior decision" gap (search_nodes orders by recency; get_connected_context by
   * structure). Over-fetches KNN candidates, filters to active obs on active entities with optional
   * project/memoryType scoping, ranks by similarity, applies the floor, caps at limit.
   *
   * Degrades to { precedents: [], modelReady, vectorSearchEnabled } when the vec table or model is
   * unavailable — it does NOT fall back to LIKE/recency, which would mislabel recency-ordered rows
   * as similarity precedents (a silent-failure footgun). The flags tell the caller why it's empty.
   *
   * @param query - situation/scenario text to find precedents for
   * @param projectId - optional project scope (project + global), pre-normalized by the caller
   * @param opts - memoryType filter, limit (default 5), minSimilarity floor (default 0.25)
   */
  async findPrecedents(query: string, projectId?: string, opts: FindPrecedentsOptions = {}): Promise<FindPrecedentsResult> {
    const limit = opts.limit ?? 5;
    const minSimilarity = opts.minSimilarity ?? 0.25;
    const modelReady = this.embeddingPipeline.state.status === 'ready';
    const vectorSearchEnabled = this.vecTableExists;

    // Similarity ranking is impossible without the model + vec table. Return empty + flags
    // rather than throwing or recency-falling-back.
    if (!vectorSearchEnabled || !modelReady) {
      return { precedents: [], modelReady, vectorSearchEnabled };
    }

    const embedding = await this.embeddingPipeline.embed(query);
    if (!embedding) return { precedents: [], modelReady, vectorSearchEnabled };

    // Over-fetch: KNN ranks over ALL observations, but we then filter by active/project/memoryType,
    // so fetch more candidates than `limit` to still have enough after filtering. k is a validated
    // integer interpolated into the query (sqlite-vec's MATCH ... k = N syntax here, mirroring the
    // dedup paths, does not bind k as a parameter).
    const k = Math.min(Math.max(limit * 5, 50), 200);
    const knnRows = this.db.prepare(`
      SELECT v.observation_id, v.distance FROM vec_observations v
      WHERE v.embedding MATCH ? AND k = ${k}
    `).all(
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    ) as { observation_id: string; distance: number }[];

    if (knnRows.length === 0) return { precedents: [], modelReady, vectorSearchEnabled };

    // L2 distance on unit-normalized vectors -> cosine similarity: 1 - dist²/2 (same as dedup).
    const simById = new Map<number, number>();
    for (const r of knnRows) {
      simById.set(parseInt(r.observation_id, 10), 1 - (r.distance * r.distance) / 2);
    }

    // Hydrate only ACTIVE observations on ACTIVE entities, applying project/memoryType filters.
    const ids = [...simById.keys()];
    const precedents: PrecedentMatch[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const filters: string[] = [];
      const params: (string | number)[] = [...chunk];
      if (projectId) { filters.push('(e.project = ? OR e.project IS NULL)'); params.push(projectId); }
      if (opts.memoryType) { filters.push('o.memory_type = ?'); params.push(opts.memoryType); }
      const rows = this.db.prepare(`
        SELECT o.id, o.content, o.importance, o.memory_type, o.context_layer, o.created_at, e.name AS entityName
        FROM observations o JOIN entities e ON o.entity_id = e.id
        WHERE o.id IN (${placeholders})
          AND o.superseded_at = '' AND o.tombstoned_at = ''
          AND e.superseded_at = '' AND e.tombstoned_at = ''
          ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
      `).all(...params) as Array<{
        id: number; content: string; importance: number; memory_type: string | null;
        context_layer: string | null; created_at: string; entityName: string;
      }>;
      for (const row of rows) {
        precedents.push({
          entityName: row.entityName,
          observationId: String(row.id),
          content: row.content,
          // RAW cosine here, not rounded — the minSimilarity floor and the ranking sort below
          // must gate/order on the TRUE similarity. Rounding is display-only and is applied at
          // the return boundary; rounding before the floor would let a 0.2496 cosine round up to
          // 0.250 and slip past a 0.25 floor (boundary leak). Filter/sort on truth, round for show.
          similarity: simById.get(row.id) ?? 0,
          importance: row.importance ?? 3.0,
          memoryType: row.memory_type,
          contextLayer: row.context_layer,
          createdAt: row.created_at,
        });
      }
    }

    return {
      // Gate on the floor + rank by raw cosine + cap + round-for-display, in that order — see the
      // rankAndFloorPrecedents JSDoc for why rounding must be last (Finding E boundary leak).
      precedents: rankAndFloorPrecedents(precedents, minSimilarity, limit),
      modelReady,
      vectorSearchEnabled,
    };
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
      SELECT content, created_at, superseded_at, tombstoned_at, source_instance
      FROM observations WHERE entity_id IN (${idPlaceholders})
      ORDER BY created_at ASC
    `).all(...allEntityIds) as { content: string; created_at: string; superseded_at: string; tombstoned_at: string; source_instance: string }[];

    // Map DB rows to TimelineObservation with computed status field.
    // Three states: active (superseded_at=''), tombstoned (tombstoned_at!='', content stripped
    // by eviction), or superseded (retired by a newer version).
    const observations: TimelineObservation[] = obsRows.map(o => ({
      content: o.content,
      createdAt: o.created_at,
      supersededAt: o.superseded_at,
      sourceInstance: o.source_instance ?? 'unknown',
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
  async getSummary(projectId?: string, excludeContextLayers?: boolean, limit?: number, memoryType?: string): Promise<Readonly<SummaryResult>> {
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

    // Optional filter: restrict to observations of a specific memory_type.
    // Enables queries like "show me decisions" or "show me procedures."
    const typeClause = memoryType !== undefined
      ? `AND o.memory_type = ?`
      : '';
    const typeParams = memoryType !== undefined ? [memoryType] : [];

    // -- 1. Top observations by importance DESC, then entity recency DESC --
    const topObs = this.db.prepare(`
      SELECT e.name AS entityName, o.content, o.importance, o.memory_type,
             o.source_instance, e.updated_at
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE o.superseded_at = ''
        AND e.superseded_at = ''
        ${layerClause}
        ${typeClause}
        ${projectClause}
      ORDER BY o.importance DESC, e.updated_at DESC
      LIMIT ?
    `).all(...typeParams, ...projectParams, obsLimit) as Array<{
      entityName: string; content: string; importance: number;
      memory_type: string | null; source_instance: string; updated_at: string;
    }>;

    // Map DB column names (snake_case) to interface field names (camelCase).
    const topObservations: SummaryObservation[] = topObs.map(row => ({
      entityName: row.entityName,
      content: row.content,
      importance: row.importance,
      memoryType: row.memory_type ?? null,
      sourceInstance: row.source_instance ?? 'unknown',
      updatedAt: row.updated_at ?? '',
    }));

    // -- 2. Recently updated entities (last 5) --
    // When memoryType is set, only include entities that have at least one
    // observation of the matching type, and only count those observations.
    const entityProjectClause = projectId !== undefined
      ? `AND (project = ? OR project IS NULL)`
      : '';
    const entityTypeFilter = memoryType !== undefined
      ? `AND memory_type = ?`
      : '';
    // When memoryType is set, also filter the entity list to those with matching observations.
    const entityTypeHaving = memoryType !== undefined
      ? `AND e.id IN (SELECT entity_id FROM observations WHERE superseded_at = '' AND memory_type = ?)`
      : '';
    const entityTypeParams = memoryType !== undefined ? [memoryType] : [];

    const recentRows = this.db.prepare(`
      SELECT name, entity_type, updated_at,
        (SELECT COUNT(*) FROM observations WHERE entity_id = e.id AND superseded_at = '' ${entityTypeFilter}) AS obs_count
      FROM entities e
      WHERE superseded_at = ''
        ${entityProjectClause}
        ${entityTypeHaving}
      ORDER BY updated_at DESC
      LIMIT 5
    `).all(...entityTypeParams, ...projectParams, ...entityTypeParams) as Array<{
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
  // L1 budget: ~4000 tokens ≈ 16000 chars. Session-start context — updated frequently.
  // History: 800 (v1.1.0) → 2000 (2026-04-14, tombstone cleanup) → 4000 (2026-04-16,
  // summary layer spec). The summary layer (§13) will split this into ~3000 featured
  // + ~1000 index, but until implemented, the full budget is used for featured text.
  // 4000 tokens is 2% of 200k context — safe for attention quality.
  // L0 has no budget enforcement by design: core identity/rules are always included
  // regardless of size (~100 tokens is a guideline, not a hard cap).
  private static readonly L1_CHAR_BUDGET = 16000;

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
      SELECT e.name AS entityName, o.content, o.importance, o.context_layer, o.memory_type,
             o.source_instance, e.updated_at
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
      source_instance: string;
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
          sourceInstance: row.source_instance ?? 'unknown',
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
          sourceInstance: row.source_instance ?? 'unknown',
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
          'UPDATE entities SET updated_at = ?, last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?'
        );
        for (const id of touchedEntityIds) {
          updateEntity.run(now, now, id);
        }
      }
    })();

    this.maybeRunEviction();
    return totalUpdated;
  }

  /**
   * Pre-write duplicate check. Embeds each candidate observation and queries
   * vec_observations for KNN matches on the same entity. Returns semantically
   * similar existing observations (cosine > 0.80) without writing anything.
   *
   * Uses a slightly lower threshold (0.80) than the post-write check in
   * addObservations (0.85) because this is advisory — better to surface a
   * borderline match and let the caller decide than to miss it.
   *
   * @param candidates - Array of { entityName, content } to check
   * @returns Per-candidate matches plus modelReady flag
   */
  async checkDuplicates(candidates: CheckDuplicateInput[]): Promise<CheckDuplicatesResponse> {
    // If the embedding model or vec table isn't ready, return empty results
    // with modelReady: false so the caller knows no check was performed.
    const modelReady = this.vecTableExists && this.embeddingPipeline.state.status === 'ready';
    if (!modelReady) {
      return {
        results: candidates.map(c => ({
          entityName: c.entityName,
          candidateContent: c.content,
          matches: [],
        })),
        modelReady: false,
        errorCount: 0,
      };
    }

    // Prepared statements used in the loop below
    // findEntity: resolves entity name → id via the normalized identity key
    const findEntity = this.db.prepare(
      `SELECT id FROM entities WHERE normalized_name = ? AND superseded_at = ''`
    );

    let errorCount = 0;
    const results = await Promise.all(candidates.map(async (candidate) => {
      const result = {
        entityName: candidate.entityName,
        candidateContent: candidate.content,
        matches: [] as DuplicateMatch[],
      };

      try {
        // Resolve entity name to ID — if entity doesn't exist, return empty matches
        // (not an error: the caller might be checking before creating the entity).
        const entityRow = findEntity.get(normalizeEntityName(candidate.entityName)) as { id: number } | undefined;
        if (!entityRow) return result;

        // Embed the candidate content for KNN search
        const embedding = await this.embeddingPipeline.embed(candidate.content);
        if (!embedding) return result;

        // KNN search for 50 nearest neighbors (larger than addObservations' k=20 because
        // we filter to same-entity afterward — with k=20, all top results might belong to
        // unrelated entities and the real same-entity match could be missed entirely).
        const knnRows = this.db.prepare(`
          SELECT v.observation_id, v.distance FROM vec_observations v
          WHERE v.embedding MATCH ? AND k = 50
        `).all(
          Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        ) as { observation_id: string; distance: number }[];

        // Cap at 5 matches per candidate to keep responses concise
        const MAX_MATCHES = 5;
        for (const knn of knnRows) {
          if (result.matches.length >= MAX_MATCHES) break;

          // Convert L2 distance on normalized vectors to cosine similarity.
          // For unit vectors: cos_sim = 1 - (L2_dist² / 2).
          const similarity = 1 - (knn.distance * knn.distance) / 2;
          // 0.80 threshold — slightly more permissive than the 0.85 post-write check
          // because this is advisory (better to show a borderline match than miss it).
          if (similarity <= 0.80) continue;

          // Verify this observation belongs to the same entity and is active
          const obsRow = this.db.prepare(`
            SELECT o.content, o.created_at FROM observations o
            WHERE o.id = ? AND o.entity_id = ? AND o.superseded_at = ''
          `).get(parseInt(knn.observation_id, 10), entityRow.id) as {
            content: string; created_at: string;
          } | undefined;

          if (obsRow) {
            result.matches.push({
              content: obsRow.content,
              similarity: Math.round(similarity * 1000) / 1000,
              createdAt: obsRow.created_at,
            });
          }
        }

        // Sort matches by similarity DESC (highest first)
        result.matches.sort((a, b) => b.similarity - a.similarity);
      } catch (err: unknown) {
        // Log with stack trace for diagnosability. Continue with empty matches
        // for this candidate — errorCount tracks how many candidates failed so
        // the caller knows empty matches may mean "error" not "no duplicates."
        const detail = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`checkDuplicates failed for '${candidate.entityName}': ${detail}`);
        errorCount++;
      }

      return result;
    }));

    return { results, modelReady: true, errorCount };
  }
}
