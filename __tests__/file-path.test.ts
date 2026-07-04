import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureMemoryFilePath, defaultMemoryPath, normalizeProjectId } from '../index.js';

describe('ensureMemoryFilePath', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const oldMemoryPath = path.join(testDir, '..', 'memory.json');
  const jsonlMemoryPath = path.join(testDir, '..', 'memory.jsonl');

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MEMORY_FILE_PATH;
    delete process.env.MEMORY_FILE_PATH;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.MEMORY_FILE_PATH = originalEnv;
    } else {
      delete process.env.MEMORY_FILE_PATH;
    }
    try { await fs.unlink(oldMemoryPath); } catch { /* ignore */ }
    try { await fs.unlink(jsonlMemoryPath); } catch { /* ignore */ }
  });

  describe('with MEMORY_FILE_PATH environment variable', () => {
    // v1.6.0 retired the JSONL backend. A .jsonl path with NO file behind it has
    // nothing to migrate, so it's now a hard error rather than a live-JSONL config.
    it('should throw the retirement error for a .jsonl path with no file to migrate', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/does-not-exist-memory.jsonl';
      await expect(ensureMemoryFilePath()).rejects.toThrow(/retired in v1\.6\.0/);
    });

    // A .jsonl path that DOES exist is honored as a one-time upgrade: the config
    // points at the sibling .db, and SqliteStore.init() migrates the .jsonl into it.
    it('should redirect an existing .jsonl to the sibling .db (SQLite migration path)', async () => {
      const existingJsonl = path.join(testDir, `retire-existing-${Date.now()}.jsonl`);
      await fs.writeFile(existingJsonl, JSON.stringify({ type: 'entity', name: 'X', entityType: 't', observations: [] }) + '\n');
      try {
        process.env.MEMORY_FILE_PATH = existingJsonl;
        const config = await ensureMemoryFilePath();
        expect(config).toEqual({ path: existingJsonl.replace(/\.jsonl$/, '.db'), storeType: 'sqlite' });
      } finally {
        await fs.unlink(existingJsonl).catch(() => {});
      }
    });

    it('should return SQLite config for .db extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/custom-memory.db';
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: '/tmp/custom-memory.db', storeType: 'sqlite' });
    });

    it('should return SQLite config for .sqlite extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/custom-memory.sqlite';
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: '/tmp/custom-memory.sqlite', storeType: 'sqlite' });
    });

    it('should resolve relative paths against script directory', async () => {
      process.env.MEMORY_FILE_PATH = 'custom-memory.db';
      const config = await ensureMemoryFilePath();
      expect(path.isAbsolute(config.path)).toBe(true);
      expect(config.path).toContain('custom-memory.db');
      expect(config.storeType).toBe('sqlite');
    });

    it('should throw on unrecognized file extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/memory.txt';
      await expect(ensureMemoryFilePath()).rejects.toThrow('Unsupported file extension');
    });
  });

  describe('without MEMORY_FILE_PATH environment variable', () => {
    it('should default to SQLite (.db)', async () => {
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: defaultMemoryPath, storeType: 'sqlite' });
    });
  });

  describe('defaultMemoryPath', () => {
    it('should end with memory.db', () => {
      expect(defaultMemoryPath).toMatch(/memory\.db$/);
    });

    it('should be an absolute path', () => {
      expect(path.isAbsolute(defaultMemoryPath)).toBe(true);
    });
  });

  // The legacy memory.json -> memory.jsonl rename is the FIRST hop of the upgrade
  // chain (json -> jsonl -> db). Post-v1.6.0 the rename still runs, then the
  // now-existing .jsonl redirects to the sibling .db for SQLite to migrate.
  describe('legacy .json to .jsonl to .db upgrade chain', () => {
    afterEach(async () => {
      try { await fs.unlink(path.join(testDir, '..', 'memory.db')); } catch { /* ignore */ }
    });

    it('should rename memory.json to memory.jsonl and hand back the sibling .db config', async () => {
      process.env.MEMORY_FILE_PATH = path.join(testDir, '..', 'memory.jsonl');
      await fs.writeFile(oldMemoryPath, '{"test":"data"}');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = await ensureMemoryFilePath();

      // The renamed .jsonl now exists, so the config points at the sibling .db.
      expect(config.storeType).toBe('sqlite');
      expect(config.path).toMatch(/memory\.db$/);
      const newExists = await fs.access(jsonlMemoryPath).then(() => true).catch(() => false);
      const oldExists = await fs.access(oldMemoryPath).then(() => true).catch(() => false);
      expect(newExists).toBe(true);
      expect(oldExists).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('DETECTED'));
      consoleErrorSpy.mockRestore();
    });

    it('should preserve content during the json to jsonl rename', async () => {
      process.env.MEMORY_FILE_PATH = path.join(testDir, '..', 'memory.jsonl');
      const testContent = '{"entities": [{"name": "test"}]}';
      await fs.writeFile(oldMemoryPath, testContent);

      await ensureMemoryFilePath();
      const migratedContent = await fs.readFile(jsonlMemoryPath, 'utf-8');
      expect(migratedContent).toBe(testContent);
    });
  });
});

// normalizeProjectId is now exported from index.ts and is the single
// place where project IDs are cleaned up. Stores trust this was called.
describe('normalizeProjectId', () => {
  it('should lowercase and trim whitespace', () => {
    expect(normalizeProjectId('  My-Project  ')).toBe('my-project');
  });

  it('should NFC-normalize Unicode', () => {
    // NFD "cafe\u0301" and NFC "caf\u00e9" should both become "café"
    expect(normalizeProjectId('cafe\u0301')).toBe('caf\u00e9');
  });

  it('should return undefined for empty string', () => {
    expect(normalizeProjectId('')).toBeUndefined();
  });

  it('should return undefined for whitespace-only string', () => {
    expect(normalizeProjectId('   ')).toBeUndefined();
  });

  it('should return undefined for undefined input', () => {
    expect(normalizeProjectId(undefined)).toBeUndefined();
  });

  it('should return undefined when called with no arguments', () => {
    expect(normalizeProjectId()).toBeUndefined();
  });
});
