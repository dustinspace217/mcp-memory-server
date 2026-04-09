// migration.test.ts -- Tests for JSONL to SQLite auto-migration.
// Migration happens inside SqliteStore.init() when the .db file doesn't exist
// but a .jsonl file is found at the same path (with extension swapped).

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonlStore } from '../jsonl-store.js';
import { SqliteStore } from '../sqlite-store.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('JSONL to SQLite migration', () => {
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

  it('should auto-migrate entities, observations, and relations from JSONL', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Seed a JSONL file with data
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
      { name: 'Bob', entityType: 'person', observations: ['likes coding'] },
    ]);
    await jsonlStore.createRelations([
      { from: 'Alice', to: 'Bob', relationType: 'knows' },
    ]);
    await jsonlStore.close();

    // Open a SqliteStore at the same base path -- should trigger migration
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(2);
    expect(graph.entities.find(e => e.name === 'Alice')?.observations[0].content).toBe('works at Acme');
    expect(graph.relations).toHaveLength(1);
    // Migrated relations get sentinel createdAt (legacy data) and '' supersededAt (active)
    expect(graph.relations[0]).toEqual(
      expect.objectContaining({ from: 'Alice', to: 'Bob', relationType: 'knows' })
    );

    await sqliteStore.close();
  });

  it('should rename .jsonl to .jsonl.bak after migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([{ name: 'Test', entityType: 'test', observations: [] }]);
    await jsonlStore.close();

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    await sqliteStore.close();

    const bakExists = await fs.access(jsonlPath + '.bak').then(() => true).catch(() => false);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);
    expect(jsonlExists).toBe(false);
  });

  it('should skip migration when .db already exists', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Seed JSONL and create DB via first migration
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([{ name: 'Original', entityType: 'test', observations: [] }]);
    await jsonlStore.close();

    const sqliteStore1 = new SqliteStore(dbPath);
    await sqliteStore1.init();
    await sqliteStore1.close();

    // Re-create a JSONL file (simulating leftover data)
    const jsonlStore2 = new JsonlStore(jsonlPath);
    await jsonlStore2.init();
    await jsonlStore2.createEntities([{ name: 'ShouldNotAppear', entityType: 'test', observations: [] }]);
    await jsonlStore2.close();

    // Second init should NOT re-migrate
    const sqliteStore2 = new SqliteStore(dbPath);
    await sqliteStore2.init();
    const graph = await sqliteStore2.readGraph();
    await sqliteStore2.close();

    expect(graph.entities.find(e => e.name === 'ShouldNotAppear')).toBeUndefined();
  });

  it('should handle legacy string observations during migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Write a JSONL file with legacy string observations (not objects)
    const legacyLine = JSON.stringify({
      type: 'entity', name: 'Legacy', entityType: 'test',
      observations: ['old string observation'],
    });
    await fs.writeFile(jsonlPath, legacyLine + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0].observations[0].content).toBe('old string observation');
    expect(graph.entities[0].observations[0].createdAt).toBe('unknown');

    await sqliteStore.close();
  });

  it('should tolerate duplicate entities in corrupted JSONL', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Two entities with the same name (corrupted data)
    const line1 = JSON.stringify({ type: 'entity', name: 'Dupe', entityType: 'a', observations: [] });
    const line2 = JSON.stringify({ type: 'entity', name: 'Dupe', entityType: 'b', observations: [] });
    await fs.writeFile(jsonlPath, line1 + '\n' + line2 + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(1);

    await sqliteStore.close();
  });
});
