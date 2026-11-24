// lock-holder-worker.mjs — worker thread for lock-mode.test.ts (issue #101).
//
// Takes the SQLite write lock on its own connection, writes one row, tells the
// main thread it holds the lock, waits holdMs WITHOUT yielding (Atomics.wait
// blocks only this worker thread), then commits. While it holds the lock the
// main thread calls a store method:
//   - an IMMEDIATE transaction asks for the write lock at BEGIN, waits in the
//     busy handler, and proceeds once this worker commits;
//   - a DEFERRED transaction whose body reads first starts as a reader and then
//     fails when it tries to upgrade to a writer (SQLITE_BUSY / BUSY_SNAPSHOT).
// A worker thread (not a child process) keeps the hand-off cheap; it must be a
// separate thread because the main thread is blocked inside SQLite meanwhile.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath, holdMs } = workerData;
const db = new Database(dbPath);
try {
  db.exec('CREATE TABLE IF NOT EXISTS _lock_probe (x INTEGER)');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO _lock_probe (x) VALUES (1)').run();
  parentPort.postMessage('locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  db.exec('COMMIT');
  // The commit time, so the test can prove its call was already waiting when
  // the lock was released (call started before this, ended after it).
  parentPort.postMessage({ committedAt: Date.now() });
} finally {
  if (db.inTransaction) db.exec('ROLLBACK');
  db.close();
}
