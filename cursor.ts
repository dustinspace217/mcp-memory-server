// cursor.ts -- Shared cursor utilities for keyset pagination.
// Both SqliteStore and JsonlStore import from here to avoid duplication.
// Cursors are opaque base64-encoded JSON strings that encode a position
// in a sorted result set plus a query fingerprint for cross-query safety.

import { InvalidCursorError } from './types.js';

/** Default number of entities per page when limit is not specified. */
export const DEFAULT_PAGE_SIZE = 40;

/** Maximum allowed page size to prevent excessive responses. */
export const MAX_PAGE_SIZE = 100;

/**
 * Internal cursor payload -- encoded as base64 JSON in the opaque cursor string.
 * u: updatedAt of last entity on page (sort key)
 * i: SQLite entity id (tiebreaker for stable ordering); always 0 for JSONL
 * n: entity name (tiebreaker for JSONL backend -- unused by SQLite but preserved for compat)
 * q: query fingerprint (prevents using a cursor from one query on a different query)
 */
export interface CursorPayload {
  u: string;   // updatedAt timestamp of the last entity on the page
  i: number;   // SQLite entity id for tiebreaking (0 for JSONL)
  n?: string;  // entity name -- used by JSONL, included by SQLite for compat
  q: string;   // query fingerprint -- must match for cursor reuse
}

/**
 * Encodes a cursor payload as a base64 JSON string.
 * The cursor is opaque to callers -- they pass it back verbatim on the next request.
 *
 * @param payload - Internal cursor data with sort position and query fingerprint
 * @returns Base64-encoded string that the caller treats as an opaque token
 */
export function encodeCursor(payload: CursorPayload): string {
  // Buffer.from().toString('base64') is Node's standard base64 encoding
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Decodes and validates a base64 cursor string.
 * Checks structural validity (required fields and types) and query fingerprint match.
 * Throws InvalidCursorError on any problem -- never silently falls back to page 1.
 *
 * Validation rules:
 * - u: must be a string (updatedAt timestamp)
 * - i: must be a finite positive integer (SQLite entity id) or 0 (JSONL placeholder)
 * - n: if present, must be a string (entity name for JSONL tiebreaking)
 * - q: must be a string matching the expected fingerprint
 *
 * @param cursor - Base64-encoded cursor string from the client
 * @param expectedFingerprint - The query fingerprint for the current request
 * @returns Validated CursorPayload with sort position info
 * @throws InvalidCursorError if cursor is malformed or doesn't match the current query
 */
export function decodeCursor(cursor: string, expectedFingerprint: string): CursorPayload {
  try {
    // Decode base64 -> UTF-8 -> JSON parse
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    // Validate required fields have correct types
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'number' || typeof parsed.q !== 'string') {
      throw new InvalidCursorError('Cursor has invalid structure');
    }
    // Validate i is a non-negative finite integer (0 is valid for JSONL, positive for SQLite)
    // Rejects: Infinity, -Infinity, NaN, -1, 3.14, etc.
    if (!Number.isFinite(parsed.i) || !Number.isInteger(parsed.i) || parsed.i < 0) {
      throw new InvalidCursorError('Cursor has invalid structure');
    }
    // Validate n is a string if present (rejects n: 42, n: true, etc.)
    if (parsed.n !== undefined && typeof parsed.n !== 'string') {
      throw new InvalidCursorError('Cursor has invalid structure');
    }
    // Ensure the cursor was created for this exact query (prevents cross-query reuse)
    if (parsed.q !== expectedFingerprint) {
      throw new InvalidCursorError('Cursor does not match current query');
    }
    return parsed;
  } catch (err) {
    // Re-throw our own error type; wrap everything else as malformed
    if (err instanceof InvalidCursorError) throw err;
    throw new InvalidCursorError('Cursor is malformed');
  }
}

/**
 * Clamps a user-provided limit to the valid range [1, MAX_PAGE_SIZE],
 * defaulting to DEFAULT_PAGE_SIZE when not provided.
 *
 * @param limit - User-provided limit, may be undefined
 * @returns Clamped page size between 1 and MAX_PAGE_SIZE
 */
export function clampLimit(limit?: number): number {
  // Handle undefined, NaN, Infinity, and other non-finite values
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  // Math.max/min ensures the value stays within [1, MAX_PAGE_SIZE]
  return Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
}

/**
 * Builds a query fingerprint for readGraph.
 * Uses null byte (\0) as separator because it cannot appear in
 * Zod-validated string inputs or MCP JSON transport, preventing
 * collision when projectId contains the separator character.
 *
 * @param projectId - The project scope, or undefined/empty for global
 * @returns Fingerprint string for cursor validation
 */
export function readGraphFingerprint(projectId?: string, asOf?: string): string {
  return `readGraph\0${projectId ?? ''}\0${asOf ?? ''}`;
}

/**
 * Builds a query fingerprint for searchNodes.
 * Uses null byte (\0) as separator because it cannot appear in
 * Zod-validated string inputs or MCP JSON transport, preventing
 * collision when projectId or query contains the separator character.
 *
 * Example of the bug this fixes: with ':' separator,
 * projectId="a:b" + query="c" would collide with projectId="a" + query="b:c"
 * because both produce "searchNodes:a:b:c". With '\0', they produce
 * distinct strings because '\0' never appears in user input.
 *
 * @param projectId - The project scope, or undefined/empty for global
 * @param query - The search query string
 * @returns Fingerprint string for cursor validation
 */
export function searchNodesFingerprint(projectId?: string, query?: string, asOf?: string): string {
  return `searchNodes\0${projectId ?? ''}\0${query ?? ''}\0${asOf ?? ''}`;
}
