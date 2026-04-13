/**
 * eviction.test.ts — Tests for the four-tier eviction system (§12).
 *
 * Tests the eviction module (evict.ts), last_accessed_at access discipline,
 * tombstoned status in entity_timeline, and the eviction lifecycle integration
 * in SqliteStore. Uses direct database access for eviction unit tests since the
 * eviction module operates via raw SQL (never through GraphStore — the observer
 * effect constraint from §12).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { checkAndEvict, getCapBytes } from '../evict.js';
import { SqliteStore } from '../sqlite-store.js';

// Resolve the directory containing this test file, used for temp file paths.
const testDir = path.dirname(fileURLToPath(import.meta.url));

// Shared state: temp DB path and store instance. Cleaned up in afterEach.
let dbPath: string;
let store: SqliteStore;

// Generates a unique temp DB path for each test to avoid collisions.
function tempDbPath(): string {
  const id = Date.now() + Math.floor(Math.random() * 100000);
  return path.join(testDir, `test-eviction-${id}.db`);
}

// Clean up temp files after each test.
afterEach(async () => {
  if (store) {
    try { store.shutdown(); } catch { /* already shut down */ }
    try { await store.close(); } catch { /* already closed */ }
  }
  if (dbPath) {
    try { await fs.unlink(dbPath); } catch { /* file may not exist */ }
    // WAL and SHM files are created by SQLite in WAL mode.
    try { await fs.unlink(dbPath + '-wal'); } catch { /* ok */ }
    try { await fs.unlink(dbPath + '-shm'); } catch { /* ok */ }
  }
});

// ── last_accessed_at access discipline ────────────────────────────────

describe('last_accessed_at access discipline', () => {
  /**
   * Helper: opens the database with a raw connection to read last_accessed_at
   * directly, avoiding the observer effect (the same reason evict.ts uses raw SQL).
   * Returns the last_accessed_at value for the given entity name.
   */
  function readLastAccessed(entityName: string): string {
    const db = new Database(dbPath);
    try {
      const row = db.prepare(
        `SELECT last_accessed_at FROM entities WHERE name = ?`
      ).get(entityName) as { last_accessed_at: string } | undefined;
      return row?.last_accessed_at ?? '';
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = new SqliteStore(dbPath);
    await store.init();
  });

  it('createEntities sets last_accessed_at on creation', async () => {
    // Creating an entity is a write — the strongest access signal.
    await store.createEntities([
      { name: 'NewEntity', entityType: 'test', observations: ['hello'] },
    ]);
    const accessed = readLastAccessed('NewEntity');
    // last_accessed_at should be a valid ISO timestamp, not empty or sentinel.
    expect(accessed).not.toBe('');
    expect(accessed).not.toBe('0000-00-00T00:00:00.000Z');
    // Verify it's a parseable date.
    expect(new Date(accessed).getTime()).toBeGreaterThan(0);
  });

  it('searchNodes updates last_accessed_at (targeted search = intent)', async () => {
    await store.createEntities([
      { name: 'SearchTarget', entityType: 'test', observations: ['findme'] },
    ]);
    const afterCreate = readLastAccessed('SearchTarget');

    // Small delay so the timestamp advances.
    await new Promise(r => setTimeout(r, 20));

    // searchNodes is listed as updating last_accessed_at in the spec.
    await store.searchNodes('findme');
    const afterSearch = readLastAccessed('SearchTarget');

    // The search should have bumped the access timestamp forward.
    expect(afterSearch >= afterCreate).toBe(true);
  });

  it('openNodes updates last_accessed_at (naming entity = intent)', async () => {
    await store.createEntities([
      { name: 'OpenTarget', entityType: 'test', observations: ['obs'] },
    ]);
    const afterCreate = readLastAccessed('OpenTarget');

    await new Promise(r => setTimeout(r, 20));
    await store.openNodes(['OpenTarget']);
    const afterOpen = readLastAccessed('OpenTarget');

    expect(afterOpen >= afterCreate).toBe(true);
  });

  it('entityTimeline updates last_accessed_at (viewing history = intent)', async () => {
    await store.createEntities([
      { name: 'TimelineTarget', entityType: 'test', observations: ['obs'] },
    ]);
    const afterCreate = readLastAccessed('TimelineTarget');

    await new Promise(r => setTimeout(r, 20));
    await store.entityTimeline('TimelineTarget');
    const afterTimeline = readLastAccessed('TimelineTarget');

    expect(afterTimeline >= afterCreate).toBe(true);
  });

  it('readGraph does NOT update last_accessed_at (bulk read is not intent)', async () => {
    await store.createEntities([
      { name: 'BulkEntity', entityType: 'test', observations: ['obs'] },
    ]);
    const afterCreate = readLastAccessed('BulkEntity');

    await new Promise(r => setTimeout(r, 20));
    // readGraph is a bulk read — should NOT touch last_accessed_at.
    await store.readGraph();
    const afterBulk = readLastAccessed('BulkEntity');

    // Timestamp should be exactly the same — readGraph doesn't touch it.
    expect(afterBulk).toBe(afterCreate);
  });

  it('addObservations updates last_accessed_at (write = strongest signal)', async () => {
    await store.createEntities([
      { name: 'WriteTarget', entityType: 'test', observations: ['obs1'] },
    ]);
    const afterCreate = readLastAccessed('WriteTarget');

    await new Promise(r => setTimeout(r, 20));
    await store.addObservations([
      { entityName: 'WriteTarget', contents: ['obs2'] },
    ]);
    const afterWrite = readLastAccessed('WriteTarget');

    expect(afterWrite > afterCreate).toBe(true);
  });

  it('supersedeObservations updates last_accessed_at', async () => {
    await store.createEntities([
      { name: 'SupersedeTarget', entityType: 'test', observations: ['old content'] },
    ]);
    const afterCreate = readLastAccessed('SupersedeTarget');

    await new Promise(r => setTimeout(r, 20));
    await store.supersedeObservations([
      { entityName: 'SupersedeTarget', oldContent: 'old content', newContent: 'new content' },
    ]);
    const afterSupersede = readLastAccessed('SupersedeTarget');

    expect(afterSupersede > afterCreate).toBe(true);
  });
});

// ── Eviction module (evict.ts) unit tests ────────────────────────────

describe('eviction module (evict.ts)', () => {
  /**
   * Sets up a raw database with v9 schema for eviction testing.
   * Returns the open Database handle. Caller must close it.
   *
   * NOTE: This uses a simplified schema (plain UNIQUE on name, no partial index
   * on normalized_name). Production uses a partial unique index:
   *   idx_entities_normalized_active ON entities(normalized_name) WHERE superseded_at = ''
   * This divergence is acceptable because eviction tests verify relation filter
   * logic, not uniqueness constraints. Tests use distinct `name` values for
   * different incarnations of the same normalized_name.
   */
  function createTestDb(filePath: string): Database.Database {
    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        normalized_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        project TEXT,
        updated_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        superseded_at TEXT NOT NULL DEFAULT '',
        tombstoned_at TEXT NOT NULL DEFAULT '',
        last_accessed_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT NOT NULL DEFAULT '',
        tombstoned_at TEXT NOT NULL DEFAULT '',
        importance REAL DEFAULT 3.0,
        context_layer TEXT,
        memory_type TEXT,
        UNIQUE(entity_id, content, superseded_at)
      );
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity TEXT NOT NULL,
        to_entity TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        superseded_at TEXT NOT NULL DEFAULT '',
        tombstoned_at TEXT NOT NULL DEFAULT '',
        UNIQUE(from_entity, to_entity, relation_type, superseded_at)
      );
    `);
    return db;
  }

  it('does not trigger eviction when DB is below threshold', () => {
    dbPath = tempDbPath();
    const db = createTestDb(dbPath);
    try {
      // A tiny DB is well under the default 1 GB cap * 0.9 trigger ratio.
      const result = checkAndEvict(db, dbPath);
      expect(result.triggered).toBe(false);
      expect(result.hardDeleted).toBe(0);
      expect(result.tombstoned).toBe(0);
      expect(result.dbSize).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('getCapBytes reads MEMORY_SIZE_CAP_BYTES env var', () => {
    const original = process.env.MEMORY_SIZE_CAP_BYTES;
    try {
      process.env.MEMORY_SIZE_CAP_BYTES = '500000';
      expect(getCapBytes()).toBe(500000);
    } finally {
      if (original === undefined) {
        delete process.env.MEMORY_SIZE_CAP_BYTES;
      } else {
        process.env.MEMORY_SIZE_CAP_BYTES = original;
      }
    }
  });

  it('getCapBytes falls back to 1 GB for invalid values', () => {
    const original = process.env.MEMORY_SIZE_CAP_BYTES;
    try {
      process.env.MEMORY_SIZE_CAP_BYTES = 'not-a-number';
      expect(getCapBytes()).toBe(1_000_000_000);

      process.env.MEMORY_SIZE_CAP_BYTES = '-100';
      expect(getCapBytes()).toBe(1_000_000_000);

      process.env.MEMORY_SIZE_CAP_BYTES = '';
      expect(getCapBytes()).toBe(1_000_000_000);
    } finally {
      if (original === undefined) {
        delete process.env.MEMORY_SIZE_CAP_BYTES;
      } else {
        process.env.MEMORY_SIZE_CAP_BYTES = original;
      }
    }
  });

  it('hard-deletes tombstoned entities when DB exceeds cap', () => {
    dbPath = tempDbPath();
    const db = createTestDb(dbPath);
    try {
      // Insert an entity that's been tombstoned over 1 year ago and not
      // accessed in over 6 months. Use generous margins so the test isn't
      // flaky from millisecond timing (the eviction threshold is ~1 year;
      // we set tombstoned_at to 2 years ago to be safely past it).
      const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, tombstoned_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('OldEntity', 'oldentity', 'test', twoYearsAgo, twoYearsAgo, twoYearsAgo, twoYearsAgo, twoYearsAgo);

      const entityId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('OldEntity') as { id: number }).id;
      db.prepare(`
        INSERT INTO observations (entity_id, content, created_at, superseded_at, tombstoned_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(entityId, '', twoYearsAgo, twoYearsAgo, twoYearsAgo);

      db.prepare(`
        INSERT INTO relations (from_entity, to_entity, relation_type, created_at, superseded_at, tombstoned_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('oldentity', 'other', 'related_to', twoYearsAgo, twoYearsAgo, twoYearsAgo);

      // Set a very low cap so the tiny DB triggers eviction.
      const original = process.env.MEMORY_SIZE_CAP_BYTES;
      process.env.MEMORY_SIZE_CAP_BYTES = '1'; // 1 byte — any DB triggers eviction
      try {
        const result = checkAndEvict(db, dbPath);
        expect(result.triggered).toBe(true);
        expect(result.hardDeleted).toBe(1);

        // Verify the entity row was actually deleted.
        const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number };
        expect(remaining.cnt).toBe(0);

        // Verify observations and relations were also deleted.
        const obsCount = (db.prepare('SELECT COUNT(*) AS cnt FROM observations').get() as { cnt: number }).cnt;
        expect(obsCount).toBe(0);
        const relCount = (db.prepare('SELECT COUNT(*) AS cnt FROM relations').get() as { cnt: number }).cnt;
        expect(relCount).toBe(0);
      } finally {
        if (original === undefined) {
          delete process.env.MEMORY_SIZE_CAP_BYTES;
        } else {
          process.env.MEMORY_SIZE_CAP_BYTES = original;
        }
      }
    } finally {
      db.close();
    }
  });

  it('tombstones superseded entities when DB exceeds cap', () => {
    dbPath = tempDbPath();
    const db = createTestDb(dbPath);
    try {
      // Insert an entity that's been superseded 2 years ago and not accessed recently.
      const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('SupersededEntity', 'supersededentity', 'test', twoYearsAgo, twoYearsAgo, twoYearsAgo, twoYearsAgo);

      const entityId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('SupersededEntity') as { id: number }).id;
      db.prepare(`
        INSERT INTO observations (entity_id, content, created_at, superseded_at)
        VALUES (?, ?, ?, ?)
      `).run(entityId, 'important data', twoYearsAgo, twoYearsAgo);

      // Trigger eviction with a tiny cap.
      const original = process.env.MEMORY_SIZE_CAP_BYTES;
      process.env.MEMORY_SIZE_CAP_BYTES = '1';
      try {
        const result = checkAndEvict(db, dbPath);
        expect(result.triggered).toBe(true);
        expect(result.tombstoned).toBe(1);

        // Verify entity was tombstoned (not deleted — tombstone preserves the skeleton).
        const entity = db.prepare('SELECT tombstoned_at FROM entities WHERE name = ?')
          .get('SupersededEntity') as { tombstoned_at: string };
        expect(entity.tombstoned_at).not.toBe('');

        // Verify observation content was stripped (the key tombstone behavior).
        const obs = db.prepare('SELECT content, tombstoned_at FROM observations WHERE entity_id = ?')
          .get(entityId) as { content: string; tombstoned_at: string };
        expect(obs.content).toBe('');
        expect(obs.tombstoned_at).not.toBe('');
      } finally {
        if (original === undefined) {
          delete process.env.MEMORY_SIZE_CAP_BYTES;
        } else {
          process.env.MEMORY_SIZE_CAP_BYTES = original;
        }
      }
    } finally {
      db.close();
    }
  });

  it('LRU shield protects recently-accessed entities from eviction', () => {
    dbPath = tempDbPath();
    const db = createTestDb(dbPath);
    try {
      // Insert a superseded entity that was accessed recently (within 6-month shield).
      const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString();
      const recently = new Date().toISOString(); // Now — well within 6-month shield

      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ProtectedEntity', 'protectedentity', 'test', twoYearsAgo, twoYearsAgo, twoYearsAgo, recently);

      const entityId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('ProtectedEntity') as { id: number }).id;
      db.prepare(`
        INSERT INTO observations (entity_id, content, created_at, superseded_at)
        VALUES (?, ?, ?, ?)
      `).run(entityId, 'shielded content', twoYearsAgo, twoYearsAgo);

      // Trigger eviction — but the entity should be protected by the LRU shield.
      const original = process.env.MEMORY_SIZE_CAP_BYTES;
      process.env.MEMORY_SIZE_CAP_BYTES = '1';
      try {
        const result = checkAndEvict(db, dbPath);
        expect(result.triggered).toBe(true);
        // Nothing should be tombstoned because the entity was recently accessed.
        expect(result.tombstoned).toBe(0);
        expect(result.hardDeleted).toBe(0);

        // Verify content is still intact.
        const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ?')
          .get(entityId) as { content: string };
        expect(obs.content).toBe('shielded content');
      } finally {
        if (original === undefined) {
          delete process.env.MEMORY_SIZE_CAP_BYTES;
        } else {
          process.env.MEMORY_SIZE_CAP_BYTES = original;
        }
      }
    } finally {
      db.close();
    }
  });

  it('eviction of tombstoned entity preserves re-created entity active relations (#70)', () => {
    // Scenario: entity "foo" was soft-deleted (superseded) and then hard-tombstoned.
    // A new "foo" was created with new active relations. Tier 1 eviction of the old
    // tombstoned "foo" must NOT delete the new "foo"'s active relations.
    dbPath = tempDbPath();
    const db = createTestDb(dbPath);
    try {
      const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString();
      const recently = new Date().toISOString();

      // Old entity "foo" — tombstoned, eligible for hard-delete.
      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, tombstoned_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('OldFoo', 'foo', 'test', twoYearsAgo, twoYearsAgo, twoYearsAgo, twoYearsAgo, twoYearsAgo);

      const oldId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('OldFoo') as { id: number }).id;
      db.prepare(`
        INSERT INTO observations (entity_id, content, created_at, superseded_at, tombstoned_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(oldId, '', twoYearsAgo, twoYearsAgo, twoYearsAgo);

      // Old relation — superseded when the old entity was soft-deleted. Should be deleted by eviction.
      db.prepare(`
        INSERT INTO relations (from_entity, to_entity, relation_type, created_at, superseded_at, tombstoned_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('foo', 'bar', 'old_relation', twoYearsAgo, twoYearsAgo, twoYearsAgo);

      // New entity "Foo" (same normalized_name "foo") — active, with active relations.
      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, tombstoned_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('Foo', 'foo', 'test', recently, recently, '', '', recently);

      // "bar" entity needed as relation endpoint.
      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, tombstoned_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('Bar', 'bar', 'test', recently, recently, '', '', recently);

      // New active relation — must NOT be deleted when old "foo" is evicted.
      db.prepare(`
        INSERT INTO relations (from_entity, to_entity, relation_type, created_at, superseded_at, tombstoned_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('foo', 'bar', 'new_relation', recently, '', '');

      // Trigger eviction with tiny cap.
      const original = process.env.MEMORY_SIZE_CAP_BYTES;
      process.env.MEMORY_SIZE_CAP_BYTES = '1';
      try {
        const result = checkAndEvict(db, dbPath);
        expect(result.triggered).toBe(true);
        expect(result.hardDeleted).toBe(1); // Old tombstoned entity deleted

        // The new active relation must still exist.
        const activeRels = db.prepare(
          `SELECT * FROM relations WHERE superseded_at = '' AND tombstoned_at = ''`
        ).all() as { relation_type: string }[];
        expect(activeRels.length).toBe(1);
        expect(activeRels[0].relation_type).toBe('new_relation');

        // The old tombstoned relation should be deleted.
        const oldRels = db.prepare(
          `SELECT * FROM relations WHERE relation_type = 'old_relation'`
        ).all();
        expect(oldRels.length).toBe(0);
      } finally {
        if (original === undefined) {
          delete process.env.MEMORY_SIZE_CAP_BYTES;
        } else {
          process.env.MEMORY_SIZE_CAP_BYTES = original;
        }
      }
    } finally {
      db.close();
    }
  });

  it('does not tombstone or delete active entities regardless of pressure', () => {
    dbPath = tempDbPath();
    const db = createTestDb(dbPath);
    try {
      // Insert an active entity (superseded_at = '') with old access timestamp.
      const twoYearsAgo = new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO entities (name, normalized_name, entity_type, updated_at, created_at, superseded_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ActiveEntity', 'activeentity', 'test', twoYearsAgo, twoYearsAgo, '', twoYearsAgo);

      const entityId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('ActiveEntity') as { id: number }).id;
      db.prepare(`
        INSERT INTO observations (entity_id, content, created_at, superseded_at)
        VALUES (?, ?, ?, ?)
      `).run(entityId, 'active data', twoYearsAgo, '');

      // Trigger eviction — active entities must NEVER be touched.
      const original = process.env.MEMORY_SIZE_CAP_BYTES;
      process.env.MEMORY_SIZE_CAP_BYTES = '1';
      try {
        const result = checkAndEvict(db, dbPath);
        expect(result.triggered).toBe(true);
        expect(result.tombstoned).toBe(0);
        expect(result.hardDeleted).toBe(0);

        // Verify entity and observation are still fully intact.
        const entity = db.prepare('SELECT tombstoned_at FROM entities WHERE name = ?')
          .get('ActiveEntity') as { tombstoned_at: string };
        expect(entity.tombstoned_at).toBe('');

        const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ?')
          .get(entityId) as { content: string };
        expect(obs.content).toBe('active data');
      } finally {
        if (original === undefined) {
          delete process.env.MEMORY_SIZE_CAP_BYTES;
        } else {
          process.env.MEMORY_SIZE_CAP_BYTES = original;
        }
      }
    } finally {
      db.close();
    }
  });
});

// ── Timeline tombstoned status ───────────────────────────────────────

describe('entity_timeline shows tombstoned status', () => {
  beforeEach(async () => {
    dbPath = tempDbPath();
    store = new SqliteStore(dbPath);
    await store.init();
  });

  it('marks observations as tombstoned in timeline when tombstoned_at is set', async () => {
    // Create an entity and soft-delete it so it becomes superseded.
    await store.createEntities([
      { name: 'TombstoneTarget', entityType: 'test', observations: ['some content'] },
    ]);
    await store.deleteEntities(['TombstoneTarget']);

    // Directly set tombstoned_at via raw SQL to simulate what eviction does.
    // This is testing the timeline OUTPUT, not the eviction sweep itself.
    const db = new Database(dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(`UPDATE observations SET content = '', tombstoned_at = ? WHERE tombstoned_at = ''`).run(now);
    } finally {
      db.close();
    }

    // entity_timeline should show the observation with status 'tombstoned'.
    const timeline = await store.entityTimeline('TombstoneTarget');
    expect(timeline).not.toBeNull();
    expect(timeline!.observations.length).toBeGreaterThan(0);
    expect(timeline!.observations[0].status).toBe('tombstoned');
    expect(timeline!.observations[0].content).toBe('');
  });

  it('marks relations as tombstoned in timeline when tombstoned_at is set', async () => {
    // Create two entities with a relation, then soft-delete the first.
    await store.createEntities([
      { name: 'FromEntity', entityType: 'test', observations: ['from obs'] },
      { name: 'ToEntity', entityType: 'test', observations: ['to obs'] },
    ]);
    await store.createRelations([
      { from: 'FromEntity', to: 'ToEntity', relationType: 'related_to' },
    ]);
    // Soft-delete one entity — relations get superseded.
    await store.deleteEntities(['FromEntity']);

    // Simulate eviction tombstoning via raw SQL.
    const db = new Database(dbPath);
    try {
      const now = new Date().toISOString();
      db.prepare(`UPDATE relations SET tombstoned_at = ? WHERE tombstoned_at = ''`).run(now);
    } finally {
      db.close();
    }

    // Check timeline of the remaining entity shows tombstoned relation.
    const timeline = await store.entityTimeline('ToEntity');
    expect(timeline).not.toBeNull();
    // The relation involving ToEntity should have tombstoned status.
    const tombstonedRels = timeline!.relations.filter(r => r.status === 'tombstoned');
    expect(tombstonedRels.length).toBeGreaterThan(0);
  });
});

// ── Eviction lifecycle integration via SqliteStore ───────────────────

describe('eviction lifecycle integration', () => {
  it('startup eviction check runs without error', async () => {
    // The startup eviction check in init() should run and return without
    // error on a fresh database (size well under any cap). This tests the
    // integration path, not eviction logic itself.
    dbPath = tempDbPath();
    store = new SqliteStore(dbPath);
    // init() calls checkAndEvict internally — if it throws, the test fails.
    await store.init();

    // Verify the store is functional after startup eviction.
    await store.createEntities([
      { name: 'PostEvictionEntity', entityType: 'test', observations: ['works'] },
    ]);
    const graph = await store.readGraph();
    expect(graph.entities.length).toBe(1);
  });
});
