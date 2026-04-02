import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureMemoryFilePath, defaultMemoryPath } from '../jsonl-store.js';

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
    it('should return JSONL config for .jsonl extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/custom-memory.jsonl';
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: '/tmp/custom-memory.jsonl', storeType: 'jsonl' });
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
      process.env.MEMORY_FILE_PATH = 'custom-memory.jsonl';
      const config = await ensureMemoryFilePath();
      expect(path.isAbsolute(config.path)).toBe(true);
      expect(config.path).toContain('custom-memory.jsonl');
      expect(config.storeType).toBe('jsonl');
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

  describe('legacy .json to .jsonl migration', () => {
    it('should migrate memory.json to memory.jsonl when using default JSONL path', async () => {
      process.env.MEMORY_FILE_PATH = path.join(testDir, '..', 'memory.jsonl');
      await fs.writeFile(oldMemoryPath, '{"test":"data"}');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = await ensureMemoryFilePath();

      expect(config.storeType).toBe('jsonl');
      const newExists = await fs.access(jsonlMemoryPath).then(() => true).catch(() => false);
      const oldExists = await fs.access(oldMemoryPath).then(() => true).catch(() => false);
      expect(newExists).toBe(true);
      expect(oldExists).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('DETECTED'));
      consoleErrorSpy.mockRestore();
    });

    it('should preserve content during migration', async () => {
      process.env.MEMORY_FILE_PATH = path.join(testDir, '..', 'memory.jsonl');
      const testContent = '{"entities": [{"name": "test"}]}';
      await fs.writeFile(oldMemoryPath, testContent);

      await ensureMemoryFilePath();
      const migratedContent = await fs.readFile(jsonlMemoryPath, 'utf-8');
      expect(migratedContent).toBe(testContent);
    });
  });
});
