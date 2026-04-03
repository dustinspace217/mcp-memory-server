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

  // BUG FOUND: Pre-Phase-4 JSONL entities don't get timestamp backfill during
  // JSONL→SQLite migration. The Phase 4 backfill only runs on existing pre-Phase-4
  // SQLite databases, not during JSONL migration (because CREATE TABLE already
  // includes the columns, so the hasUpdatedAt check passes and backfill is skipped).
  // See QA plan for proposed fix.
  it('should handle pre-Phase-4 JSONL (no updatedAt/createdAt on entities) — documents current behavior', async () => {
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
      // No updatedAt or createdAt
    });
    await fs.writeFile(jsonlPath, line + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    const graph = await sqliteStore.readGraph();

    expect(graph.entities).toHaveLength(1);
    const entity = graph.entities[0];

    // KNOWN BUG: updatedAt and createdAt remain as sentinel instead of being
    // backfilled from observation timestamps during JSONL→SQLite migration.
    // The Phase 4 backfill (UPDATE entities SET updated_at = ...) only runs when
    // upgrading an existing pre-Phase-4 SQLite database, NOT during JSONL migration,
    // because the table is created with the columns already present.
    //
    // IDEAL behavior: updatedAt = '2025-06-15T00:00:00.000Z' (MAX observation)
    //                 createdAt = '2025-03-01T00:00:00.000Z' (MIN observation)
    // ACTUAL behavior: both remain as sentinel
    expect(entity.updatedAt).toBe(ENTITY_TIMESTAMP_SENTINEL);
    expect(entity.createdAt).toBe(ENTITY_TIMESTAMP_SENTINEL);

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

  it('should handle crash-recovery: .db exists but .jsonl not renamed', async () => {
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

    // Simulate crash recovery: recreate the .jsonl file (as if .bak rename failed)
    await fs.writeFile(jsonlPath, JSON.stringify({
      type: 'entity', name: 'ShouldNotMigrate', entityType: 'test', observations: [],
    }) + '\n');

    // Second init should NOT re-migrate because .db already exists
    const sqliteStore2 = new SqliteStore(dbPath);
    await sqliteStore2.init();
    const graph = await sqliteStore2.readGraph();
    await sqliteStore2.close();

    expect(graph.entities.find(e => e.name === 'ShouldNotMigrate')).toBeUndefined();
    expect(graph.entities.find(e => e.name === 'Alice')).toBeDefined();
  });
});
