// lock-mode.test.ts — pins the IMMEDIATE transaction mode of the read-first write
// paths (issue #101; review TA-1 of the 2026-11-23 batch).
//
// Each case: a worker thread holds the database write lock for HOLD_MS, and the
// main thread calls one store method meanwhile. With IMMEDIATE the call waits for
// the lock (busy_timeout 5000 ms > HOLD_MS) and succeeds; with the old DEFERRED
// mode its read-first body would start as a reader and fail on the upgrade to a
// writer. Pool 1 (vectors off): no model is loaded, each case uses its own file.

import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { SqliteStore } from '../sqlite-store.js';

const HOLD_MS = 800;
const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'lock-holder-worker.mjs');

// Receives a db path; starts the lock-holder worker and resolves once it holds
// the write lock. Returns the worker and a promise for the worker's commit time
// (ms epoch), so the caller can prove contention: its call must START before that
// commit and END after it (review XFA-1: elapsed time measured from message
// delivery was flaky and could not prove the call actually waited).
async function holdWriteLock(dbPath: string): Promise<{ worker: Worker; committed: Promise<number> }> {
  const worker = new Worker(workerPath, { workerData: { dbPath, holdMs: HOLD_MS } });
  let resolveCommitted!: (t: number) => void;
  let rejectCommitted!: (e: Error) => void;
  const committed = new Promise<number>((res, rej) => { resolveCommitted = res; rejectCommitted = rej; });
  await new Promise<void>((resolve, reject) => {
    worker.on('message', (m: string | { committedAt: number }) => {
      if (m === 'locked') resolve();
      else if (typeof m === 'object') resolveCommitted(m.committedAt);
    });
    worker.on('error', (e: Error) => { reject(e); rejectCommitted(e); });
  });
  return { worker, committed };
}

// The six read-first write paths switched to IMMEDIATE. Each seeds what it needs
// on a fresh store, then runs the call made while the lock is held.
const CASES: { name: string; seed: (s: SqliteStore) => Promise<void>; call: (s: SqliteStore) => Promise<unknown> }[] = [
  {
    name: 'createRelations',
    seed: async s => { await s.createEntities([{ name: 'A', entityType: 't', observations: [] }, { name: 'B', entityType: 't', observations: [] }]); },
    call: s => s.createRelations([{ from: 'A', to: 'B', relationType: 'relates_to' }]),
  },
  {
    name: 'addObservations',
    seed: async s => { await s.createEntities([{ name: 'A', entityType: 't', observations: [] }]); },
    call: s => s.addObservations([{ entityName: 'A', contents: ['added under a held lock'] }]),
  },
  {
    name: 'deleteEntities',
    seed: async s => { await s.createEntities([{ name: 'A', entityType: 't', observations: ['x'] }]); },
    call: s => s.deleteEntities(['A']),
  },
  {
    name: 'deleteObservations',
    seed: async s => { await s.createEntities([{ name: 'A', entityType: 't', observations: ['o1'] }]); },
    call: s => s.deleteObservations([{ entityName: 'A', contents: ['o1'] }]),
  },
  {
    name: 'supersedeObservations',
    seed: async s => { await s.createEntities([{ name: 'A', entityType: 't', observations: ['old'] }]); },
    call: s => s.supersedeObservations([{ entityName: 'A', oldContent: 'old', newContent: 'new' }]),
  },
  {
    name: 'setObservationMetadata',
    seed: async s => { await s.createEntities([{ name: 'A', entityType: 't', observations: ['o1'] }]); },
    call: s => s.setObservationMetadata([{ entityName: 'A', content: 'o1', importance: 4 }]),
  },
];

describe('read-first write paths wait for a held write lock (IMMEDIATE, #101)', () => {
  for (const c of CASES) {
    it(`${c.name} waits for another connection's write lock instead of failing`, async () => {
      const dbPath = path.join(tmpdir(), `test-lock-mode-${c.name}-${Date.now()}.db`);
      const store = new SqliteStore(dbPath);
      try {
        await store.init();
        await c.seed(store);
        const { worker, committed } = await holdWriteLock(dbPath);
        try {
          const started = Date.now();
          await c.call(store);                  // DEFERRED would throw SQLITE_BUSY here
          const ended = Date.now();
          const committedAt = await committed;
          // Proof of contention: the call began while the worker still held the
          // lock and returned only after the worker committed.
          expect(started).toBeLessThan(committedAt);
          expect(ended).toBeGreaterThanOrEqual(committedAt);
        } finally {
          await worker.terminate();
        }
      } finally {
        store.shutdown();
        await store.close();
        for (const suffix of ['', '-wal', '-shm']) {
          try { await fs.unlink(dbPath + suffix); } catch { /* ok */ }
        }
      }
    }, 20_000);
  }
});
