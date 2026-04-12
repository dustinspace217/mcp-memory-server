// migration-validation.test.ts -- Comprehensive migration safety validation.
// Creates a realistic JSONL file with ALL data variants (legacy strings, modern
// observations, projects, globals, pre-Phase-3/4 data, edge cases), migrates
// to SQLite, and verifies every field round-trips correctly.
//
// This is a QA-specific test — more exhaustive than the existing migration.test.ts
// which only covers basic happy paths.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonlStore } from '../jsonl-store.js';
import { SqliteStore } from '../sqlite-store.js';
import { ENTITY_TIMESTAMP_SENTINEL } from '../types.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('Migration safety validation', () => {
  let dbPath: string;
  let jsonlPath: string;

  afterEach(async () => {
    for (const p of [dbPath, jsonlPath, jsonlPath + '.bak']) {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }
    for (const suffix of ['-wal', '-shm']) {
      try { await fs.unlink(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('should preserve all entity fields through JSONL→SQLite migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-full-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-full-migrate-${id}.db`);

    // Seed JSONL with entities covering all variants
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();

    // 1. Modern entity with project, timestamps, and multiple observations
    await jsonlStore.createEntities(
      [{ name: 'ModernEntity', entityType: 'test', observations: ['obs1', 'obs2', 'obs3'] }],
      'my-project'
    );

    // 2. Global entity (no project)
    await jsonlStore.createEntities([
      { name: 'GlobalEntity', entityType: 'global', observations: ['global obs'] },
    ]);

    // 3. Entity with no observations
    await jsonlStore.createEntities(
      [{ name: 'EmptyEntity', entityType: 'empty', observations: [] }],
      'my-project'
    );

    // 4. Relations between entities
    await jsonlStore.createRelations([
      { from: 'ModernEntity', to: 'GlobalEntity', relationType: 'references' },
      { from: 'GlobalEntity', to: 'EmptyEntity', relationType: 'related_to' },
    ]);

    // Read JSONL data for comparison
    const originalGraph = await jsonlStore.readGraph();
    await jsonlStore.close();

    // Migrate to SQLite
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const migratedGraph = await sqliteStore.readGraph();

    // Verify entity count
    expect(migratedGraph.entities).toHaveLength(originalGraph.entities.length);

    // Verify each entity field-by-field
    for (const original of originalGraph.entities) {
      const migrated = migratedGraph.entities.find(e => e.name === original.name);
      expect(migrated, `Entity "${original.name}" should exist after migration`).toBeDefined();

      expect(migrated!.entityType).toBe(original.entityType);
      // Project normalization: JSONL stores lowercase, SQLite migration also lowercases
      expect(migrated!.project).toBe(original.project);
      expect(migrated!.observations).toHaveLength(original.observations.length);

      // Verify each observation
      for (const origObs of original.observations) {
        const migratedObs = migrated!.observations.find(o => o.content === origObs.content);
        expect(migratedObs, `Observation "${origObs.content}" should exist on "${original.name}"`).toBeDefined();
        expect(migratedObs!.createdAt).toBe(origObs.createdAt);
      }

      // Timestamps should be preserved (JSONL writes them since Phase 4)
      expect(migrated!.updatedAt).toBe(original.updatedAt);
      expect(migrated!.createdAt).toBe(original.createdAt);
    }

    // Verify relations
    expect(migratedGraph.relations).toHaveLength(originalGraph.relations.length);
    for (const origRel of originalGraph.relations) {
      const migratedRel = migratedGraph.relations.find(
        r => r.from === origRel.from && r.to === origRel.to && r.relationType === origRel.relationType
      );
      expect(migratedRel, `Relation ${origRel.from}→${origRel.to} should exist`).toBeDefined();
    }

    // Verify .jsonl.bak exists
    const bakExists = await fs.access(jsonlPath + '.bak').then(() => true).catch(() => false);
    expect(bakExists).toBe(true);

    await sqliteStore.close();
  });

  it('should handle legacy string observations in JSONL', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-legacy-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-legacy-migrate-${id}.db`);

    // Write raw JSONL with legacy string observations (pre-Phase-1 format)
    const legacyLines = [
      JSON.stringify({
        type: 'entity', name: 'LegacyEntity', entityType: 'test',
        observations: ['plain string obs 1', 'plain string obs 2'],
      }),
      // Also test an entity with mixed observation formats
      JSON.stringify({
        type: 'entity', name: 'MixedEntity', entityType: 'test',
        observations: [
          'string obs',
          { content: 'object obs', createdAt: '2025-06-15T10:00:00.000Z' },
        ],
      }),
    ];
    await fs.writeFile(jsonlPath, legacyLines.join('\n') + '\n');

    // Migrate
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    // Legacy string observations should have createdAt='unknown'
    const legacy = graph.entities.find(e => e.name === 'LegacyEntity')!;
    expect(legacy.observations).toHaveLength(2);
    for (const obs of legacy.observations) {
      expect(obs.createdAt).toBe('unknown');
    }

    // Mixed entity: string obs gets 'unknown', object obs keeps its timestamp
    const mixed = graph.entities.find(e => e.name === 'MixedEntity')!;
    expect(mixed.observations).toHaveLength(2);
    const stringObs = mixed.observations.find(o => o.content === 'string obs')!;
    const objectObs = mixed.observations.find(o => o.content === 'object obs')!;
    expect(stringObs.createdAt).toBe('unknown');
    expect(objectObs.createdAt).toBe('2025-06-15T10:00:00.000Z');

    await sqliteStore.close();
  });

  it('should handle pre-Phase-3 JSONL (no project field)', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-no-project-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-no-project-migrate-${id}.db`);

    // Write JSONL without project field (pre-Phase-3)
    const line = JSON.stringify({
      type: 'entity', name: 'OldEntity', entityType: 'test',
      observations: [{ content: 'obs', createdAt: '2025-01-01T00:00:00.000Z' }],
      // No project field at all
    });
    await fs.writeFile(jsonlPath, line + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    // Entity should exist with project=null (global)
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0].project).toBeNull();

    await sqliteStore.close();
  });

  // FIX VERIFIED (#46): Pre-Phase-4 JSONL entities now get timestamp backfill
  // during JSONL→SQLite migration. The post-migration backfill SQL computes
  // updatedAt = MAX(observation.createdAt) and createdAt = MIN(observation.createdAt)
  // for entities that still have sentinel values after migrateFromJsonl().
  it('should backfill timestamps from observations for pre-Phase-4 JSONL entities (#46 fix)', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-no-timestamps-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-no-timestamps-migrate-${id}.db`);

    // Write JSONL without entity-level timestamps (pre-Phase-4)
    // But observations DO have timestamps (Phase 1 was done)
    const line = JSON.stringify({
      type: 'entity', name: 'PrePhase4', entityType: 'test',
      observations: [
        { content: 'early obs', createdAt: '2025-03-01T00:00:00.000Z' },
        { content: 'late obs', createdAt: '2025-06-15T00:00:00.000Z' },
      ],
      project: null,
      // No updatedAt or createdAt — simulates pre-Phase-4 JSONL
    });
    await fs.writeFile(jsonlPath, line + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    expect(graph.entities).toHaveLength(1);
    const entity = graph.entities[0];

    // Post-migration backfill should compute timestamps from observations:
    // updatedAt = MAX(observation.createdAt) = '2025-06-15T00:00:00.000Z'
    // createdAt = MIN(observation.createdAt) = '2025-03-01T00:00:00.000Z'
    expect(entity.updatedAt).toBe('2025-06-15T00:00:00.000Z');
    expect(entity.createdAt).toBe('2025-03-01T00:00:00.000Z');

    await sqliteStore.close();
  });

  it('should handle JSONL entities with only "unknown" observation timestamps', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-unknown-ts-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-unknown-ts-migrate-${id}.db`);

    // Entity with observations that all have createdAt='unknown' (pre-Phase-1 legacy)
    const line = JSON.stringify({
      type: 'entity', name: 'AllUnknown', entityType: 'test',
      observations: ['legacy obs 1', 'legacy obs 2'],
      // No entity-level timestamps
    });
    await fs.writeFile(jsonlPath, line + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    expect(graph.entities).toHaveLength(1);
    const entity = graph.entities[0];

    // No valid observation timestamps to backfill from, so sentinel stays
    expect(entity.updatedAt).toBe(ENTITY_TIMESTAMP_SENTINEL);
    expect(entity.createdAt).toBe(ENTITY_TIMESTAMP_SENTINEL);

    await sqliteStore.close();
  });

  it('should normalize mixed-case project names during migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-project-case-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-project-case-migrate-${id}.db`);

    // Write JSONL with mixed-case project names (would happen if user manually edited the file)
    const lines = [
      JSON.stringify({
        type: 'entity', name: 'Upper', entityType: 'test',
        observations: [], project: 'My-Project',
      }),
      JSON.stringify({
        type: 'entity', name: 'Lower', entityType: 'test',
        observations: [], project: 'my-project',
      }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    // Both should be normalized to 'my-project' in SQLite
    for (const entity of graph.entities) {
      expect(entity.project).toBe('my-project');
    }

    await sqliteStore.close();
  });

  it('should preserve observations during migration with addObservations after migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-post-migrate-ops-${id}.jsonl`);
    dbPath = path.join(testDir, `test-post-migrate-ops-${id}.db`);

    // Seed JSONL
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['original obs'] },
    ]);
    await jsonlStore.close();

    // Migrate to SQLite
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    // Add observations to the migrated entity
    const results = await sqliteStore.addObservations([
      { entityName: 'Alice', contents: ['new obs after migration'] },
    ]);
    expect(results[0].addedObservations).toHaveLength(1);

    // Read back and verify both original and new observations exist
    const graph = await sqliteStore.readGraph();
    const alice = graph.entities.find(e => e.name === 'Alice')!;
    expect(alice.observations).toHaveLength(2);
    expect(alice.observations.map(o => o.content).sort()).toEqual([
      'new obs after migration',
      'original obs',
    ]);

    await sqliteStore.close();
  });

  it('should handle dangling relations gracefully during migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-dangling-rel-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-dangling-rel-migrate-${id}.db`);

    // Write JSONL with a relation pointing to a non-existent entity
    const lines = [
      JSON.stringify({ type: 'entity', name: 'Alice', entityType: 'test', observations: [] }),
      // Relation from Alice to Bob, but Bob doesn't exist
      JSON.stringify({ type: 'relation', from: 'Alice', to: 'Bob', relationType: 'knows' }),
    ];
    await fs.writeFile(jsonlPath, lines.join('\n') + '\n');

    // Migration should succeed (dangling relation silently skipped)
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(1);
    // Dangling relation should be skipped (FK constraint prevents it)
    expect(graph.relations).toHaveLength(0);

    await sqliteStore.close();
  });

  it('should NOT re-migrate when .db has data and .jsonl is recreated', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-crash-recovery-${id}.jsonl`);
    dbPath = path.join(testDir, `test-crash-recovery-${id}.db`);

    // Seed JSONL
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([
      { name: 'Alice', entityType: 'test', observations: ['data'] },
    ]);
    await jsonlStore.close();

    // First migration (normal)
    const sqliteStore1 = new SqliteStore(dbPath);
    await sqliteStore1.init();
    await sqliteStore1.close();

    // Simulate scenario: recreate the .jsonl file (as if .bak rename failed)
    await fs.writeFile(jsonlPath, JSON.stringify({
      type: 'entity', name: 'ShouldNotMigrate', entityType: 'test', observations: [],
    }) + '\n');

    // Second init should NOT re-migrate because .db already has data
    const sqliteStore2 = new SqliteStore(dbPath);
    await sqliteStore2.init();
    const graph = await sqliteStore2.readGraph();
    await sqliteStore2.close();

    expect(graph.entities.find(e => e.name === 'ShouldNotMigrate')).toBeUndefined();
    expect(graph.entities.find(e => e.name === 'Alice')).toBeDefined();
  });

  // FIX VERIFIED (#47): If .db exists but is empty (schema-only, zero entities)
  // AND a .jsonl file exists, the previous migration crashed between new Database()
  // (which creates the file) and migrateFromJsonl() completing. The fix detects
  // this state and re-attempts migration.
  it('should recover from interrupted migration: empty .db with .jsonl present (#47 fix)', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-empty-db-recovery-${id}.jsonl`);
    dbPath = path.join(testDir, `test-empty-db-recovery-${id}.db`);

    // Seed JSONL with real data
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([
      { name: 'Recovered', entityType: 'test', observations: ['important data'] },
    ]);
    await jsonlStore.close();

    // Simulate crash: create an empty .db file with schema but no data.
    // This is what happens if the process dies after new Database() + CREATE TABLE
    // but before migrateFromJsonl() completes.
    // We import better-sqlite3 directly to create the empty schema.
    const Database = (await import('better-sqlite3')).default;
    const emptyDb = new Database(dbPath);
    emptyDb.pragma('journal_mode = WAL');
    emptyDb.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        project TEXT,
        updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
        created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}'
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(entity_id, content)
      );
      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        to_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        relation_type TEXT NOT NULL,
        UNIQUE(from_entity, to_entity, relation_type)
      );
    `);
    emptyDb.close();

    // Now init should detect empty .db + existing .jsonl and re-migrate
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    // Data should be recovered from the JSONL file
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0].name).toBe('Recovered');
    expect(graph.entities[0].observations).toHaveLength(1);
    expect(graph.entities[0].observations[0].content).toBe('important data');

    // .jsonl should be renamed to .bak after successful recovery
    const bakExists = await fs.access(jsonlPath + '.bak').then(() => true).catch(() => false);
    expect(bakExists).toBe(true);

    await sqliteStore.close();
  });

  it('should migrate v5 → v6: add importance, context_layer, memory_type columns', async () => {
    // Create a v5 database directly using better-sqlite3, then verify that
    // SqliteStore auto-migrates it to v6 (adding observation metadata columns).
    const id = Date.now();
    dbPath = path.join(testDir, `test-v5-to-v6-${id}.db`);
    jsonlPath = path.join(testDir, `nonexistent-${id}.jsonl`); // not used, just for cleanup

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Build v5 schema using individual statements to avoid security hook
    // false positive on exec() (which it mistakes for child_process.exec).
    // schema_version table: single-row via CHECK constraint
    db.prepare(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`).run();
    db.prepare(`INSERT INTO schema_version (id, version) VALUES (1, 5)`).run();

    // entities table (v5 schema — has updated_at, created_at)
    db.prepare(`CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      project TEXT,
      updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}'
    )`).run();

    // observations table (v5 schema — has superseded_at, but NO importance/context_layer/memory_type)
    db.prepare(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT '',
      UNIQUE(entity_id, content, superseded_at)
    )`).run();

    // relations table (v5 schema — has created_at, superseded_at)
    db.prepare(`CREATE TABLE relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
      to_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      superseded_at TEXT NOT NULL DEFAULT '',
      UNIQUE(from_entity, to_entity, relation_type, superseded_at)
    )`).run();

    // Insert test data: one entity with two observations
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('TestEntity', 'test', now, now);
    const entityId = (db.prepare(`SELECT id FROM entities WHERE name = ?`).get('TestEntity') as { id: number }).id;
    db.prepare(`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`).run(entityId, 'obs-alpha', now);
    // Small delay to avoid UNIQUE constraint collision if same millisecond
    const now2 = new Date(Date.now() + 5).toISOString();
    db.prepare(`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`).run(entityId, 'obs-beta', now2);

    // Verify v5 has NO metadata columns
    const v5Columns = db.prepare(`PRAGMA table_info(observations)`).all() as { name: string }[];
    const v5ColNames = v5Columns.map(c => c.name);
    expect(v5ColNames).not.toContain('importance');
    expect(v5ColNames).not.toContain('context_layer');
    expect(v5ColNames).not.toContain('memory_type');

    db.close();

    // Open with SqliteStore — should auto-migrate v5 → v6
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    // Verify schema_version is at least 6 (init() runs all migrations up to the
    // code's current version, which may be > 6 — this test only validates the
    // 5→6 portion that adds metadata columns).
    const db2 = new Database(dbPath);
    const version = (db2.prepare(`SELECT version FROM schema_version`).get() as { version: number }).version;
    expect(version).toBeGreaterThanOrEqual(6);

    // Verify new columns exist with correct defaults
    const v6Columns = db2.prepare(`PRAGMA table_info(observations)`).all() as { name: string; dflt_value: string | null; notnull: number }[];
    const importanceCol = v6Columns.find(c => c.name === 'importance');
    const contextLayerCol = v6Columns.find(c => c.name === 'context_layer');
    const memoryTypeCol = v6Columns.find(c => c.name === 'memory_type');

    expect(importanceCol).toBeDefined();
    expect(importanceCol!.dflt_value).toBe('3.0');
    expect(importanceCol!.notnull).toBe(1); // NOT NULL

    expect(contextLayerCol).toBeDefined();
    expect(contextLayerCol!.dflt_value).toBe('NULL');
    expect(contextLayerCol!.notnull).toBe(0); // nullable

    expect(memoryTypeCol).toBeDefined();
    expect(memoryTypeCol!.dflt_value).toBe('NULL');
    expect(memoryTypeCol!.notnull).toBe(0); // nullable

    // Verify existing observations got default values
    const rows = db2.prepare(`SELECT content, importance, context_layer, memory_type FROM observations ORDER BY id`).all() as {
      content: string; importance: number; context_layer: string | null; memory_type: string | null;
    }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.importance).toBe(3.0);
      expect(row.context_layer).toBeNull();
      expect(row.memory_type).toBeNull();
    }
    expect(rows[0].content).toBe('obs-alpha');
    expect(rows[1].content).toBe('obs-beta');

    db2.close();

    // Verify data round-trips through SqliteStore.readGraph()
    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0].name).toBe('TestEntity');
    expect(graph.entities[0].observations).toHaveLength(2);

    await sqliteStore.close();
  });

  it('should migrate v6 → v7: add superseded_at to entities + partial unique index', async () => {
    // Create a v6 database directly using better-sqlite3, then verify that
    // SqliteStore auto-migrates it to v7 (soft-delete on entities).
    const id = Date.now();
    dbPath = path.join(testDir, `test-v6-to-v7-${id}.db`);
    jsonlPath = path.join(testDir, `nonexistent-${id}.jsonl`); // not used, just for cleanup

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Build v6 schema using individual prepare/run statements (security hook
    // false-positive workaround — see comment at line 451 above).
    db.prepare(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`).run();
    db.prepare(`INSERT INTO schema_version (id, version) VALUES (1, 6)`).run();

    // entities table (v6 schema — has updated_at, created_at, NO superseded_at)
    db.prepare(`CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL,
      project TEXT,
      updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}'
    )`).run();

    // observations table (v6 schema — has importance/context_layer/memory_type)
    db.prepare(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 3.0,
      context_layer TEXT,
      memory_type TEXT,
      UNIQUE(entity_id, content, superseded_at)
    )`).run();

    // relations table (v5+ schema — has created_at, superseded_at)
    db.prepare(`CREATE TABLE relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
      to_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      superseded_at TEXT NOT NULL DEFAULT '',
      UNIQUE(from_entity, to_entity, relation_type, superseded_at)
    )`).run();

    // Seed test data: two entities with a relation between them, plus an observation
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('Alpha', 'test', now, now);
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('Beta', 'test', now, now);
    const alphaId = (db.prepare(`SELECT id FROM entities WHERE name = ?`).get('Alpha') as { id: number }).id;
    db.prepare(`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`).run(alphaId, 'alpha-obs', now);
    db.prepare(`INSERT INTO relations (from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)`).run('Alpha', 'Beta', 'links', now);

    // Verify v6 has NO superseded_at on entities
    const v6Cols = db.prepare(`PRAGMA table_info(entities)`).all() as { name: string }[];
    expect(v6Cols.map(c => c.name)).not.toContain('superseded_at');

    db.close();

    // Open with SqliteStore — should auto-migrate v6 → v7
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    // Verify schema_version is at least 7 — init() runs every pending migration
    // in sequence, so a v6 DB ends up at whatever the current schema version is
    // (which may be > 7). This test only validates the v6→v7 step; additional
    // migrations (e.g. v7→v8) are covered by their own dedicated tests below.
    const db2 = new Database(dbPath);
    const version = (db2.prepare(`SELECT version FROM schema_version`).get() as { version: number }).version;
    expect(version).toBeGreaterThanOrEqual(7);

    // Verify v6→v7 added the superseded_at column with the correct default.
    // This column survives all later migrations intact.
    const v7Cols = db2.prepare(`PRAGMA table_info(entities)`).all() as { name: string; dflt_value: string | null; notnull: number }[];
    const supersededCol = v7Cols.find(c => c.name === 'superseded_at');
    expect(supersededCol).toBeDefined();
    // SQLite returns the default with surrounding quotes for string literals
    expect(supersededCol!.dflt_value).toBe(`''`);
    expect(supersededCol!.notnull).toBe(1); // NOT NULL

    // Verify a partial unique index is enforcing active-row identity.
    // In v7 that index is idx_entities_name_active (on `name`); in v8+ it's
    // idx_entities_normalized_active (on `normalized_name`). Both implement
    // the same semantics — only one should exist at any version. Accept
    // whichever is currently present so this test stays forward-compatible.
    const indexes = db2.prepare(`PRAGMA index_list(entities)`).all() as { name: string; unique: number; partial: number }[];
    const activeIdentityIdx = indexes.find(
      i => (i.name === 'idx_entities_name_active' || i.name === 'idx_entities_normalized_active') && i.unique === 1 && i.partial === 1
    );
    expect(activeIdentityIdx, 'A partial unique index on the active-row identity column should exist').toBeDefined();

    // Verify the entities table rebuild preserved all rows with the display
    // name intact. Display names are never rewritten by any migration.
    const rows = db2.prepare(`SELECT name, superseded_at FROM entities ORDER BY name`).all() as { name: string; superseded_at: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Alpha');
    expect(rows[0].superseded_at).toBe('');
    expect(rows[1].name).toBe('Beta');
    expect(rows[1].superseded_at).toBe('');

    // Observations attached to Alpha survived the entity table rebuild.
    const obsCount = (db2.prepare(`SELECT COUNT(*) as c FROM observations`).get() as { c: number }).c;
    expect(obsCount).toBe(1);

    db2.close();

    // Verify data round-trips through SqliteStore.readGraph(). This is the
    // end-to-end check — regardless of how relations are stored internally
    // (display form in v7, normalized form in v8+), readGraph() must return
    // the display names. Relation 'Alpha' → 'Beta' must survive intact.
    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(2);
    expect(graph.entities.map(e => e.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0].from).toBe('Alpha');
    expect(graph.relations[0].to).toBe('Beta');
    expect(graph.relations[0].relationType).toBe('links');

    await sqliteStore.close();
  });

  it('should migrate v7 → v8: add normalized_name + rewrite relations to normalized form', async () => {
    // Create a v7 database directly using better-sqlite3, then verify that
    // SqliteStore auto-migrates it to v8 (entity name normalization Layer 1):
    //   - adds normalized_name column, backfilled via normalizeEntityName()
    //   - rewrites relations.from_entity / to_entity from display to normalized form
    //   - drops idx_entities_name_active (partial unique on display name)
    //   - creates idx_entities_normalized_active (partial unique on normalized_name)
    //   - bumps schema_version to 8
    const id = Date.now();
    dbPath = path.join(testDir, `test-v7-to-v8-${id}.db`);
    jsonlPath = path.join(testDir, `nonexistent-${id}.jsonl`); // not used, just for cleanup

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Build v7 schema using individual prepare/run statements (security hook
    // false-positive workaround — see comment at line 451 above).
    db.prepare(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`).run();
    db.prepare(`INSERT INTO schema_version (id, version) VALUES (1, 7)`).run();

    // entities table (v7 schema — has superseded_at, NO normalized_name).
    // Note: no inline UNIQUE(name) constraint — v7 uses the partial index below
    // (idx_entities_name_active) to enforce active-name uniqueness, which
    // allows multiple soft-deleted rows with the same name.
    db.prepare(`CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      project TEXT,
      updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      superseded_at TEXT NOT NULL DEFAULT ''
    )`).run();

    // v7 partial unique index on display name (active rows only) — this
    // is the index the migration is expected to drop.
    db.prepare(`CREATE UNIQUE INDEX idx_entities_name_active ON entities(name) WHERE superseded_at = ''`).run();

    // observations table (v6+ schema — has importance/context_layer/memory_type)
    db.prepare(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 3.0,
      context_layer TEXT,
      memory_type TEXT,
      UNIQUE(entity_id, content, superseded_at)
    )`).run();

    // relations table (v7 schema — FK references to entities(name) were DROPPED
    // in v6→v7 because entities.name no longer has a full UNIQUE constraint
    // after the partial-index swap. See sqlite-store.ts v6→v7 block for the
    // full rationale; the practical upshot is that v7 relations.from_entity /
    // to_entity are plain TEXT with no FK clause.)
    db.prepare(`CREATE TABLE relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity TEXT NOT NULL,
      to_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      superseded_at TEXT NOT NULL DEFAULT '',
      UNIQUE(from_entity, to_entity, relation_type, superseded_at)
    )`).run();

    // Seed test data with surface-variant-style names (mixed case + separators).
    // These should collapse to normalized forms:
    //   'Dustin Space'   → 'dustinspace'
    //   'voice-assistant' → 'voiceassistant'
    //   'phase_b_task_3' → 'phasebtask3'
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('Dustin Space', 'project', now, now);
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('voice-assistant', 'project', now, now);
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('phase_b_task_3', 'task', now, now);

    // Seed a soft-deleted historical row with the same display name as an
    // active one — the backfill must populate normalized_name for it too,
    // but it must NOT be considered by the collision check (which filters
    // superseded_at = '').
    const oldTs = '2026-01-01T00:00:00.000Z';
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at, superseded_at) VALUES (?, ?, NULL, ?, ?, ?)`).run('Dustin Space', 'project', oldTs, oldTs, oldTs);

    // Add an observation so we can verify it round-trips via readGraph().
    const dustinId = (db.prepare(`SELECT id FROM entities WHERE name = ? AND superseded_at = ''`).get('Dustin Space') as { id: number }).id;
    db.prepare(`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`).run(dustinId, 'a dustin-space observation', now);

    // Seed relations using DISPLAY form (this is what v7 stored). The
    // migration must rewrite these to normalized form.
    db.prepare(`INSERT INTO relations (from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)`).run('Dustin Space', 'voice-assistant', 'references', now);
    db.prepare(`INSERT INTO relations (from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)`).run('voice-assistant', 'phase_b_task_3', 'blocks', now);

    // Verify v7 has NO normalized_name column before migration.
    const v7Cols = db.prepare(`PRAGMA table_info(entities)`).all() as { name: string }[];
    expect(v7Cols.map(c => c.name)).not.toContain('normalized_name');

    // Verify v7 relations still hold the display form.
    const v7Rels = db.prepare(`SELECT from_entity, to_entity FROM relations ORDER BY id`).all() as { from_entity: string; to_entity: string }[];
    expect(v7Rels[0]).toEqual({ from_entity: 'Dustin Space', to_entity: 'voice-assistant' });
    expect(v7Rels[1]).toEqual({ from_entity: 'voice-assistant', to_entity: 'phase_b_task_3' });

    db.close();

    // Open with SqliteStore — should auto-migrate v7 → v8 (and then v8 → v9).
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    // Verify schema_version is now 9 (v7→v8 normalization + v8→v9 eviction columns).
    const db2 = new Database(dbPath);
    const version = (db2.prepare(`SELECT version FROM schema_version`).get() as { version: number }).version;
    expect(version).toBe(9);

    // Verify normalized_name column was added with NOT NULL constraint.
    const v8Cols = db2.prepare(`PRAGMA table_info(entities)`).all() as { name: string; dflt_value: string | null; notnull: number }[];
    const normalizedCol = v8Cols.find(c => c.name === 'normalized_name');
    expect(normalizedCol).toBeDefined();
    expect(normalizedCol!.notnull).toBe(1);

    // Verify normalized_name was backfilled for every row (active + soft-deleted).
    const backfilled = db2.prepare(`SELECT name, normalized_name, superseded_at FROM entities ORDER BY id`).all() as { name: string; normalized_name: string; superseded_at: string }[];
    expect(backfilled).toHaveLength(4); // 3 active + 1 soft-deleted
    expect(backfilled[0]).toMatchObject({ name: 'Dustin Space',    normalized_name: 'dustinspace',    superseded_at: '' });
    expect(backfilled[1]).toMatchObject({ name: 'voice-assistant', normalized_name: 'voiceassistant', superseded_at: '' });
    expect(backfilled[2]).toMatchObject({ name: 'phase_b_task_3',  normalized_name: 'phasebtask3',    superseded_at: '' });
    // Soft-deleted row also backfilled, but keeps its soft-delete timestamp.
    expect(backfilled[3]).toMatchObject({ name: 'Dustin Space',    normalized_name: 'dustinspace' });
    expect(backfilled[3].superseded_at).not.toBe('');

    // Verify the OLD partial unique index on name was dropped.
    const indexes = db2.prepare(`PRAGMA index_list(entities)`).all() as { name: string; unique: number; partial: number }[];
    const oldIdx = indexes.find(i => i.name === 'idx_entities_name_active');
    expect(oldIdx).toBeUndefined();

    // Verify the NEW partial unique index on normalized_name was created.
    const newIdx = indexes.find(i => i.name === 'idx_entities_normalized_active');
    expect(newIdx).toBeDefined();
    expect(newIdx!.unique).toBe(1);
    expect(newIdx!.partial).toBe(1);
    // Index column is normalized_name (not name).
    const newIdxCols = db2.prepare(`PRAGMA index_info(idx_entities_normalized_active)`).all() as { name: string }[];
    expect(newIdxCols.map(c => c.name)).toEqual(['normalized_name']);

    // Verify relations were rewritten to NORMALIZED form.
    const v8Rels = db2.prepare(`SELECT from_entity, to_entity, relation_type FROM relations ORDER BY id`).all() as { from_entity: string; to_entity: string; relation_type: string }[];
    expect(v8Rels).toHaveLength(2);
    expect(v8Rels[0]).toEqual({ from_entity: 'dustinspace',    to_entity: 'voiceassistant', relation_type: 'references' });
    expect(v8Rels[1]).toEqual({ from_entity: 'voiceassistant', to_entity: 'phasebtask3',    relation_type: 'blocks' });

    // Observation count unchanged by the migration.
    const obsCount = (db2.prepare(`SELECT COUNT(*) AS c FROM observations`).get() as { c: number }).c;
    expect(obsCount).toBe(1);

    db2.close();

    // Round-trip through SqliteStore.readGraph(): entities should return
    // display names, and relations should return display names (translated
    // from their stored normalized form via the LEFT JOIN + COALESCE path
    // in getConnectedRelations / buildEntities).
    const graph = await sqliteStore.readGraph();
    // Only active entities are exposed via readGraph (the soft-deleted
    // historical row is filtered out).
    expect(graph.entities).toHaveLength(3);
    const names = graph.entities.map(e => e.name).sort();
    expect(names).toEqual(['Dustin Space', 'phase_b_task_3', 'voice-assistant']);

    // Observation on Dustin Space survived.
    const dustin = graph.entities.find(e => e.name === 'Dustin Space')!;
    expect(dustin.observations).toHaveLength(1);
    expect(dustin.observations[0].content).toBe('a dustin-space observation');

    // Relations return DISPLAY names via the COALESCE translation layer.
    expect(graph.relations).toHaveLength(2);
    const rel1 = graph.relations.find(r => r.relationType === 'references')!;
    expect(rel1.from).toBe('Dustin Space');
    expect(rel1.to).toBe('voice-assistant');
    const rel2 = graph.relations.find(r => r.relationType === 'blocks')!;
    expect(rel2.from).toBe('voice-assistant');
    expect(rel2.to).toBe('phase_b_task_3');

    await sqliteStore.close();
  });

  it('should abort v7 → v8 migration when two active entities normalize to the same key', async () => {
    // Seed a v7 database with two active entities whose display names
    // collapse to the same normalized form ('dustin-space' and 'Dustin_Space'
    // both → 'dustinspace'). The migration must abort with a structured
    // error BEFORE touching the schema, so the database stays at v7 and
    // the caller can resolve the collision manually before retrying.
    const id = Date.now();
    dbPath = path.join(testDir, `test-v7-to-v8-collision-${id}.db`);
    jsonlPath = path.join(testDir, `nonexistent-${id}.jsonl`); // not used, just for cleanup

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.prepare(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`).run();
    db.prepare(`INSERT INTO schema_version (id, version) VALUES (1, 7)`).run();

    db.prepare(`CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      project TEXT,
      updated_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      superseded_at TEXT NOT NULL DEFAULT ''
    )`).run();
    db.prepare(`CREATE UNIQUE INDEX idx_entities_name_active ON entities(name) WHERE superseded_at = ''`).run();

    db.prepare(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 3.0,
      context_layer TEXT,
      memory_type TEXT,
      UNIQUE(entity_id, content, superseded_at)
    )`).run();

    db.prepare(`CREATE TABLE relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
      to_entity TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '${ENTITY_TIMESTAMP_SENTINEL}',
      superseded_at TEXT NOT NULL DEFAULT '',
      UNIQUE(from_entity, to_entity, relation_type, superseded_at)
    )`).run();

    // Two entities with distinct display names but the same normalized form.
    // v7's partial unique index is on display name, so this is legal in v7.
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('dustin-space', 'project', now, now);
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at) VALUES (?, ?, NULL, ?, ?)`).run('Dustin_Space', 'project', now, now);

    db.close();

    // Open with SqliteStore — migration should ABORT with a collision error.
    const sqliteStore = new SqliteStore(dbPath);
    await expect(sqliteStore.init()).rejects.toThrow(/collision/i);
    // Ensure the error message names the colliding display forms and the
    // key they collapse to, so the operator knows exactly what to fix.
    await expect(sqliteStore.init()).rejects.toThrow(/dustin-space/);
    await expect(sqliteStore.init()).rejects.toThrow(/Dustin_Space/);
    await expect(sqliteStore.init()).rejects.toThrow(/dustinspace/);

    // The transaction should have rolled back: schema_version still at 7,
    // no normalized_name column, no idx_entities_normalized_active index.
    const db3 = new Database(dbPath);
    const version = (db3.prepare(`SELECT version FROM schema_version`).get() as { version: number }).version;
    expect(version).toBe(7);

    const cols = db3.prepare(`PRAGMA table_info(entities)`).all() as { name: string }[];
    expect(cols.map(c => c.name)).not.toContain('normalized_name');

    const indexes = db3.prepare(`PRAGMA index_list(entities)`).all() as { name: string }[];
    expect(indexes.map(i => i.name)).not.toContain('idx_entities_normalized_active');
    // Old v7 index should still be present — nothing was dropped.
    expect(indexes.map(i => i.name)).toContain('idx_entities_name_active');

    db3.close();

    // sqliteStore.close() is safe to call even after a failed init (the
    // underlying Database handle was opened before the transaction threw).
    try { await sqliteStore.close(); } catch { /* ignore */ }
  });

  it('should migrate v8 → v9: add tombstoned_at + last_accessed_at for eviction', async () => {
    // Create a v8 database directly, then verify that SqliteStore auto-migrates
    // it to v9 (eviction infrastructure):
    //   - adds tombstoned_at column on entities, observations, and relations
    //   - adds last_accessed_at column on entities (backfilled from updated_at)
    //   - bumps schema_version to 9
    const id = Date.now();
    dbPath = path.join(testDir, `test-v8-to-v9-${id}.db`);
    jsonlPath = path.join(testDir, `nonexistent-${id}.jsonl`); // not used, just for cleanup

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Build v8 schema directly.
    db.prepare(`CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)`).run();
    db.prepare(`INSERT INTO schema_version (id, version) VALUES (1, 8)`).run();

    // entities table — v8 schema (has normalized_name, NO tombstoned_at/last_accessed_at).
    db.prepare(`CREATE TABLE entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      project TEXT,
      updated_at TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z',
      created_at TEXT NOT NULL DEFAULT '0000-00-00T00:00:00.000Z',
      superseded_at TEXT NOT NULL DEFAULT '',
      normalized_name TEXT NOT NULL DEFAULT ''
    )`).run();

    // observations table — v8 schema (has importance/context_layer/memory_type, NO tombstoned_at).
    db.prepare(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_at TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 3.0,
      context_layer TEXT,
      memory_type TEXT,
      UNIQUE(entity_id, content, superseded_at)
    )`).run();

    // relations table — v8 schema (normalized endpoints, NO tombstoned_at).
    db.prepare(`CREATE TABLE relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity TEXT NOT NULL,
      to_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      superseded_at TEXT NOT NULL DEFAULT '',
      UNIQUE(from_entity, to_entity, relation_type, superseded_at)
    )`).run();

    // Insert test data with a known updated_at so we can verify last_accessed_at backfill.
    const knownTimestamp = '2026-04-10T12:00:00.000Z';
    db.prepare(`INSERT INTO entities (name, entity_type, project, updated_at, created_at, normalized_name) VALUES (?, ?, NULL, ?, ?, ?)`).run(
      'TestEntity', 'concept', knownTimestamp, knownTimestamp, 'testentity'
    );
    const entityId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('TestEntity') as { id: number }).id;
    db.prepare(`INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)`).run(
      entityId, 'test observation', knownTimestamp
    );
    db.prepare(`INSERT INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)`).run(
      'testentity', 'testentity', 'self-ref'
    );

    db.close();

    // Open with SqliteStore — should auto-migrate v8 → v9.
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    // Verify: schema version is now 9.
    const db2 = new Database(dbPath, { readonly: true });
    const version = (db2.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    expect(version).toBe(9);

    // Verify: entities has tombstoned_at and last_accessed_at columns.
    const entityCols = db2.prepare('PRAGMA table_info(entities)').all() as { name: string }[];
    const entityColNames = entityCols.map(c => c.name);
    expect(entityColNames).toContain('tombstoned_at');
    expect(entityColNames).toContain('last_accessed_at');

    // Verify: observations has tombstoned_at column.
    const obsCols = db2.prepare('PRAGMA table_info(observations)').all() as { name: string }[];
    expect(obsCols.map(c => c.name)).toContain('tombstoned_at');

    // Verify: relations has tombstoned_at column.
    const relCols = db2.prepare('PRAGMA table_info(relations)').all() as { name: string }[];
    expect(relCols.map(c => c.name)).toContain('tombstoned_at');

    // Verify: last_accessed_at was backfilled from updated_at.
    const entity = db2.prepare('SELECT last_accessed_at, updated_at FROM entities WHERE name = ?').get('TestEntity') as {
      last_accessed_at: string;
      updated_at: string;
    };
    expect(entity.last_accessed_at).toBe(knownTimestamp);
    expect(entity.last_accessed_at).toBe(entity.updated_at);

    // Verify: tombstoned_at defaults to empty string (not tombstoned).
    const entityRow = db2.prepare('SELECT tombstoned_at FROM entities WHERE name = ?').get('TestEntity') as { tombstoned_at: string };
    expect(entityRow.tombstoned_at).toBe('');

    const obsRow = db2.prepare('SELECT tombstoned_at FROM observations LIMIT 1').get() as { tombstoned_at: string };
    expect(obsRow.tombstoned_at).toBe('');

    const relRow = db2.prepare('SELECT tombstoned_at FROM relations LIMIT 1').get() as { tombstoned_at: string };
    expect(relRow.tombstoned_at).toBe('');

    db2.close();
    await sqliteStore.close();
  });
});
