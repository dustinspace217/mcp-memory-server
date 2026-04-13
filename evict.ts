/**
 * evict.ts — Four-tier degradation and size-pressure eviction module.
 *
 * Implements §12 of the v1.1 design spec: a four-tier degradation chain
 * (Active → Superseded → Tombstoned → Hard-deleted) with time-allowed,
 * pressure-triggered eviction. Time grants eligibility; size pressure triggers
 * actual movement.
 *
 * CRITICAL DESIGN CONSTRAINT — the observer effect:
 *   This module uses raw SQL through the better-sqlite3 Database handle
 *   directly. It does NOT route through any GraphStore method (readGraph,
 *   searchNodes, openNodes, etc.) because those methods update
 *   last_accessed_at as a side effect. The eviction sweep is a CONSUMER
 *   of last_accessed_at, never a PRODUCER. Routing through GraphStore would
 *   make every entity "recently accessed" during eviction, defeating the
 *   LRU shield entirely.
 *
 * Tiers:
 *   1. Hard-delete tombstoned rows (tombstoned_at > 1 year, last_accessed_at > 6 months)
 *   2. Tombstone superseded rows (superseded_at > 1 year, last_accessed_at > 6 months)
 *   Never: hard-delete active data on size pressure alone.
 *
 * LRU shield: entities accessed within 6 months are protected at every tier.
 * Size cap: configurable via MEMORY_SIZE_CAP_BYTES (default 1 GB).
 */

import type DatabaseConstructor from 'better-sqlite3';
// Type alias for the database instance returned by better-sqlite3's constructor.
// better-sqlite3's default export is the constructor function; the instance type
// is accessed as DatabaseConstructor.Database.
type Database = DatabaseConstructor.Database;
import { statSync } from 'fs';

// ── Configuration ──────────────────────────────────────────────────────

/** Default size cap: 1 GB. Override with MEMORY_SIZE_CAP_BYTES env var. */
const DEFAULT_SIZE_CAP = 1_000_000_000;

/** Trigger eviction when DB size exceeds this fraction of the cap. */
const TRIGGER_RATIO = 0.9;

/** Minimum age (in ms) before a superseded item becomes eligible for tombstoning. */
const TOMBSTONE_ELIGIBILITY_MS = 365.25 * 24 * 60 * 60 * 1000; // ~1 year

/** Minimum age (in ms) before a tombstoned item becomes eligible for hard-delete. */
const HARD_DELETE_ELIGIBILITY_MS = 365.25 * 24 * 60 * 60 * 1000; // ~1 year from tombstone

/** LRU shield window (in ms): entities accessed within this window are protected. */
const LRU_SHIELD_MS = 182.5 * 24 * 60 * 60 * 1000; // ~6 months

/** Maximum rows processed per eviction batch to avoid blocking the main loop. */
const BATCH_SIZE = 500;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Checks whether the database size has crossed the eviction trigger threshold
 * and runs the eviction sweep if needed. Safe to call frequently (returns
 * immediately if below threshold).
 *
 * @param db - The better-sqlite3 Database connection (raw, NOT through GraphStore)
 * @param dbPath - Filesystem path to the database file (for stat)
 * @returns Object with stats about what happened: { triggered, hardDeleted, tombstoned, dbSize }
 */
export function checkAndEvict(db: Database, dbPath: string): EvictionResult {
  const cap = getCapBytes();
  let dbSize: number;
  try {
    dbSize = statSync(dbPath).size;
  } catch (err) {
    // Can't stat the file — skip eviction entirely. Log so the operator
    // knows eviction isn't running, rather than silently doing nothing. (#74)
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Eviction: cannot stat ${dbPath}: ${msg} — skipping eviction check`);
    return { triggered: false, hardDeleted: 0, tombstoned: 0, dbSize: 0 };
  }

  if (dbSize <= cap * TRIGGER_RATIO) {
    return { triggered: false, hardDeleted: 0, tombstoned: 0, dbSize };
  }

  // Eviction triggered — run the sweep.
  let hardDeleted = 0;
  let tombstoned = 0;

  // Tier 1: hard-delete tombstoned rows.
  hardDeleted += hardDeleteTombstoned(db);

  // Tier 2: tombstone superseded rows.
  tombstoned += tombstoneSuperseded(db);

  // WAL checkpoint: in WAL mode, DELETEs don't shrink the main DB file until a
  // checkpoint merges the WAL back. Without this, statSync on the next eviction
  // check would still see the pre-eviction file size, and the graduated eviction
  // design would be non-functional (every sweep would exhaust all eligible rows
  // because the file never appears to shrink). TRUNCATE mode does a full checkpoint
  // AND truncates the WAL file to zero, giving an accurate size on the next check.
  // (Issue #75.)
  if (hardDeleted > 0 || tombstoned > 0) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      // Checkpoint failure is non-fatal — the DB is still consistent, just the
      // file size won't reflect the deletions until the next automatic checkpoint.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Eviction: WAL checkpoint failed (non-fatal): ${msg}`);
    }
  }

  return { triggered: true, hardDeleted, tombstoned, dbSize: getCurrentSize(dbPath) };
}

/** Result of an eviction check. */
export interface EvictionResult {
  /** Whether eviction was triggered (size exceeded threshold). */
  triggered: boolean;
  /** Number of rows hard-deleted in this sweep. */
  hardDeleted: number;
  /** Number of entities tombstoned (content stripped) in this sweep. */
  tombstoned: number;
  /** Database file size at check time. */
  dbSize: number;
}

/**
 * Returns the configured size cap in bytes.
 * Reads MEMORY_SIZE_CAP_BYTES env var; falls back to DEFAULT_SIZE_CAP.
 */
export function getCapBytes(): number {
  const env = process.env.MEMORY_SIZE_CAP_BYTES;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SIZE_CAP;
}

// ── Tier 1: Hard-delete tombstoned rows ────────────────────────────────

/**
 * Hard-deletes entities (and their observations + relations) that have been
 * tombstoned for at least HARD_DELETE_ELIGIBILITY_MS and whose last_accessed_at
 * is older than LRU_SHIELD_MS.
 *
 * Processes all eligible rows in batches of BATCH_SIZE to avoid long-running
 * transactions. The caller (checkAndEvict) runs a WAL checkpoint after both
 * tiers complete so that the reclaimed space is visible to statSync on the
 * next eviction check. (Issue #75: the previous while-loop checked file size
 * per batch, but in WAL mode the file never shrank mid-sweep, so the loop
 * always exhausted all eligible rows anyway.)
 *
 * Returns the total number of entity rows deleted.
 */
function hardDeleteTombstoned(db: Database): number {
  const now = Date.now();
  // Eligibility: tombstoned_at must be older than 1 year AND last_accessed_at
  // must be older than 6 months. Both are ISO 8601 strings — lexicographic
  // comparison works because ISO dates sort correctly as strings.
  const tombstoneThreshold = new Date(now - HARD_DELETE_ELIGIBILITY_MS).toISOString();
  const accessThreshold = new Date(now - LRU_SHIELD_MS).toISOString();

  let totalDeleted = 0;

  // Loop in batches until out of eligible rows.
  for (;;) {
    // Find eligible entities: tombstoned long enough + not recently accessed.
    // Raw SQL — never through GraphStore. Oldest tombstones first (most stale).
    const eligible = db.prepare(`
      SELECT id FROM entities
      WHERE tombstoned_at != '' AND tombstoned_at < ?
        AND (last_accessed_at = '' OR last_accessed_at < ?)
      ORDER BY tombstoned_at ASC
      LIMIT ?
    `).all(tombstoneThreshold, accessThreshold, BATCH_SIZE) as { id: number }[];

    if (eligible.length === 0) break; // No more eligible rows.

    const ids = eligible.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    // Delete in a single transaction: vec cleanup → observations → relations → entities.
    // ON DELETE CASCADE would handle observations, but relations use
    // normalized_name not entity.id, so we clean up explicitly.
    db.transaction(() => {
      // Collect observation IDs BEFORE deleting observations — we need them to
      // clean up vec_observations, and the parent rows will be gone after DELETE.
      // (Issue #71: the original code deleted observations first, then had comments
      // about orphan cleanup but never implemented it.)
      const obsIds = db.prepare(
        `SELECT id FROM observations WHERE entity_id IN (${placeholders})`
      ).all(...ids) as { id: number }[];
      if (obsIds.length > 0) {
        const obsPlaceholders = obsIds.map(() => '?').join(',');
        const obsIdStrings = obsIds.map(o => String(o.id));
        // vec_observations may not exist (MEMORY_VECTOR_SEARCH=off). Try/catch
        // so eviction still works without the vec extension — matches Tier 2 pattern.
        try {
          db.prepare(
            `DELETE FROM vec_observations WHERE observation_id IN (${obsPlaceholders})`
          ).run(...obsIdStrings);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Eviction Tier 1: vec_observations cleanup failed (non-fatal): ${msg}`);
        }
      }

      // Delete observations belonging to these entities.
      db.prepare(`DELETE FROM observations WHERE entity_id IN (${placeholders})`).run(...ids);

      // Delete relations where either endpoint is one of these entities.
      // Relations store normalized_name, so look up the names.
      //
      // CRITICAL SAFETY: Only delete relations that are already retired
      // (superseded_at or tombstoned_at set). Without this filter, if an entity
      // was soft-deleted and re-created under the same normalized_name, eviction
      // of the old incarnation would destroy the NEW entity's active relations.
      // deleteEntities() supersedes relations when soft-deleting an entity, so
      // the old incarnation's relations will have superseded_at != '' by the time
      // Tier 1 runs. (See issue #70.)
      const names = db.prepare(
        `SELECT normalized_name FROM entities WHERE id IN (${placeholders})`
      ).all(...ids) as { normalized_name: string }[];
      if (names.length > 0) {
        const namePlaceholders = names.map(() => '?').join(',');
        const nameValues = names.map(n => n.normalized_name);
        db.prepare(
          `DELETE FROM relations
           WHERE (from_entity IN (${namePlaceholders}) OR to_entity IN (${namePlaceholders}))
             AND (superseded_at != '' OR tombstoned_at != '')`
        ).run(...nameValues, ...nameValues);
      }

      // Finally delete the entity rows themselves.
      db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
    })();

    totalDeleted += ids.length;
  }

  return totalDeleted;
}

// ── Tier 2: Tombstone superseded entities ──────────────────────────────

/**
 * Tombstones entities (strips observation content, preserves skeleton) that
 * have been superseded for at least TOMBSTONE_ELIGIBILITY_MS and whose
 * last_accessed_at is older than LRU_SHIELD_MS.
 *
 * "Tombstoning" means:
 *   - Set entities.tombstoned_at to current timestamp
 *   - Set observations.tombstoned_at to current timestamp
 *   - Set observations.content to '' (content stripped, skeleton preserved)
 *   - Set relations.tombstoned_at to current timestamp
 *   - Delete corresponding vec_observations rows (embeddings no longer useful)
 *
 * Processes all eligible rows in batches. The caller runs a WAL checkpoint
 * after both tiers complete. (See hardDeleteTombstoned JSDoc for #75 rationale.)
 *
 * Returns the total number of entities tombstoned.
 */
function tombstoneSuperseded(db: Database): number {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Eligibility: superseded_at must be older than 1 year AND last_accessed_at
  // must be older than 6 months.
  const supersedeThreshold = new Date(now - TOMBSTONE_ELIGIBILITY_MS).toISOString();
  const accessThreshold = new Date(now - LRU_SHIELD_MS).toISOString();

  let totalTombstoned = 0;

  for (;;) {
    // Find eligible superseded (but not yet tombstoned) entities.
    const eligible = db.prepare(`
      SELECT id FROM entities
      WHERE superseded_at != '' AND superseded_at < ?
        AND tombstoned_at = ''
        AND (last_accessed_at = '' OR last_accessed_at < ?)
      ORDER BY superseded_at ASC
      LIMIT ?
    `).all(supersedeThreshold, accessThreshold, BATCH_SIZE) as { id: number }[];

    if (eligible.length === 0) break;

    const ids = eligible.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    db.transaction(() => {
      // Mark entity as tombstoned.
      db.prepare(
        `UPDATE entities SET tombstoned_at = ? WHERE id IN (${placeholders})`
      ).run(nowIso, ...ids);

      // Strip observation content and mark as tombstoned.
      // The skeleton (id, entity_id, created_at, superseded_at) is preserved
      // so timeline queries can still answer "X existed at time T."
      db.prepare(
        `UPDATE observations SET content = '', tombstoned_at = ? WHERE entity_id IN (${placeholders})`
      ).run(nowIso, ...ids);

      // Mark relations as tombstoned — but ONLY relations that are already
      // superseded (superseded_at != '') and not yet tombstoned. Without this
      // filter, if an entity was soft-deleted and re-created under the same
      // normalized_name, this would tombstone the NEW entity's active relations.
      // deleteEntities() sets superseded_at on relations when soft-deleting, so
      // the old incarnation's relations are distinguishable. (See issue #70.)
      const names = db.prepare(
        `SELECT normalized_name FROM entities WHERE id IN (${placeholders})`
      ).all(...ids) as { normalized_name: string }[];
      if (names.length > 0) {
        const namePlaceholders = names.map(() => '?').join(',');
        const nameValues = names.map(n => n.normalized_name);
        db.prepare(
          `UPDATE relations SET tombstoned_at = ?
           WHERE (from_entity IN (${namePlaceholders}) OR to_entity IN (${namePlaceholders}))
             AND superseded_at != '' AND tombstoned_at = ''`
        ).run(nowIso, ...nameValues, ...nameValues);
      }

      // Remove vec_observations for tombstoned observations (embeddings of '' are useless).
      // vec_observations.observation_id is TEXT matching observations.id cast to string.
      // NOTE: Unlike Tier 1, we SELECT obs IDs AFTER stripping content (line ~298) because
      // Tier 2 UPDATEs observations (preserving rows) rather than DELETing them. The IDs
      // survive the UPDATE, so the ordering is safe. Tier 1 must collect IDs BEFORE its
      // DELETE because the rows are destroyed. (See issue #71 for the Tier 1 fix.)
      const obsIds = db.prepare(
        `SELECT id FROM observations WHERE entity_id IN (${placeholders})`
      ).all(...ids) as { id: number }[];
      if (obsIds.length > 0) {
        const obsPlaceholders = obsIds.map(() => '?').join(',');
        const obsIdStrings = obsIds.map(o => String(o.id));
        // vec_observations may not exist (MEMORY_VECTOR_SEARCH=off). Try/catch
        // so eviction still works in environments without the vec extension.
        try {
          db.prepare(
            `DELETE FROM vec_observations WHERE observation_id IN (${obsPlaceholders})`
          ).run(...obsIdStrings);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Eviction Tier 2: vec_observations cleanup failed (non-fatal): ${msg}`);
        }
      }
    })();

    totalTombstoned += ids.length;
  }

  return totalTombstoned;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Gets the current database file size. Returns 0 if the file can't be stat'd.
 *
 * Used by checkAndEvict for (a) the initial trigger check (is the DB over 90%
 * of the cap?) and (b) reporting the post-eviction size. Returning 0 on error
 * means the trigger check never fires (0 <= threshold), which is correct — if
 * we can't read the file, don't try to evict. (#74)
 */
function getCurrentSize(dbPath: string): number {
  try {
    return statSync(dbPath).size;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Eviction: cannot stat ${dbPath}: ${msg} — treating size as 0`);
    return 0;
  }
}
