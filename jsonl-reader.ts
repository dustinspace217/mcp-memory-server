// jsonl-reader.ts -- minimal JSONL parser kept ONLY as the SQLite upgrade path.
//
// The JSONL *backend* was retired in v1.6.0 (see CLAUDE.md "Version History" and
// docs/superpowers/plans/2026-07-04-jsonl-retirement.md). What survives here is
// the read half of the old JsonlStore.loadGraph: enough to slurp an existing
// .jsonl file into a KnowledgeGraph so SqliteStore.init() can migrate it into
// SQLite once and rename the source to .jsonl.bak. This is DELIBERATELY not a
// GraphStore — it has no writes, no queries, no lifecycle. It exists so that a
// deployment still holding a .jsonl file has a data-preserving path forward
// (workspace rule: data-preserving before data-destructive), not so JSONL keeps
// being a backend anyone can serve from.

import { promises as fs } from 'fs';
import path from 'path';
import {
  ENTITY_TIMESTAMP_SENTINEL,
  type Observation,
  type KnowledgeGraph,
} from './types.js';

/**
 * Handles the legacy memory.json -> memory.jsonl rename, the FIRST hop of the
 * upgrade chain (memory.json -> memory.jsonl -> memory.db). Only fires when the
 * target is the default memory.jsonl path alongside the compiled script — a user
 * who explicitly points MEMORY_FILE_PATH at some other .jsonl name is not on the
 * ancient-default path and gets no rename. Preserved verbatim from the retired
 * JsonlStore so nobody sitting on a pre-JSONL memory.json loses it during the
 * SQLite cutover.
 *
 * @param scriptDir - Directory containing the compiled script (dist/)
 * @param jsonlPath - Target .jsonl path the caller resolved from the env var
 */
export async function migrateJsonToJsonl(scriptDir: string, jsonlPath: string): Promise<void> {
  const oldJsonPath = path.join(scriptDir, 'memory.json');
  const targetIsDefault = jsonlPath === path.join(scriptDir, 'memory.jsonl');

  if (!targetIsDefault) return;

  try {
    await fs.access(oldJsonPath);
    try {
      await fs.access(jsonlPath);
      // Both exist -- use the new one, no migration
    } catch (innerErr: unknown) {
      // Only migrate if the target truly doesn't exist (ENOENT).
      // Permission errors or I/O failures should surface, not be silently swallowed.
      if (innerErr instanceof Error && 'code' in innerErr && (innerErr as any).code !== 'ENOENT') {
        console.error('WARNING: Could not check .jsonl target during migration:', innerErr);
        return;
      }
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldJsonPath, jsonlPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
    }
  } catch (outerErr: unknown) {
    // Only swallow ENOENT (old file doesn't exist -- nothing to migrate).
    // Log any other error (EACCES, EIO, etc.) so the user knows migration was blocked.
    if (outerErr instanceof Error && 'code' in outerErr && (outerErr as any).code !== 'ENOENT') {
      console.error('WARNING: Could not check legacy .json file during migration:', outerErr);
    }
  }
}

/**
 * Converts a legacy string observation into an Observation object,
 * or validates that an existing object has the required shape.
 *
 * String observations get createdAt: 'unknown' since we don't know when they were
 * created. Object observations are validated for required fields -- malformed data
 * throws so the per-line loop below can skip just that entry.
 *
 * Kept as a named export (not folded into the loop) because the migration tests
 * assert its normalization directly, and index.ts re-exports it for external
 * consumers that used to import it from the old jsonl-store.
 *
 * @param obs - Raw observation from JSONL: string (legacy) or object
 * @returns A valid Observation with content and createdAt fields
 * @throws Error if obs is not a string and doesn't have a valid content field
 */
export function normalizeObservation(obs: unknown): Observation {
  if (typeof obs === 'string') {
    return { content: obs, createdAt: 'unknown', importance: 3.0, contextLayer: null, memoryType: null, sourceInstance: 'unknown' };
  }
  if (typeof obs === 'object' && obs !== null && 'content' in obs && typeof (obs as any).content === 'string') {
    // Cast to access optional fields — legacy JSONL data won't have the v1.1 metadata fields
    const o = obs as { content: string; createdAt?: unknown; importance?: unknown; contextLayer?: unknown; memoryType?: unknown; sourceInstance?: unknown; summary?: unknown };
    return {
      content: o.content,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : 'unknown',
      importance: typeof o.importance === 'number' ? o.importance : 3.0,
      contextLayer: typeof o.contextLayer === 'string' ? o.contextLayer : null,
      memoryType: typeof o.memoryType === 'string' ? o.memoryType : null,
      sourceInstance: typeof o.sourceInstance === 'string' ? o.sourceInstance : 'unknown',
      // v16 L1-index hint: carried through migration so a file-resident summary
      // survives the JSONL→SQLite cutover (migrateFromJsonl reads this field).
      ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
    };
  }
  throw new Error(`Invalid observation format: ${JSON.stringify(obs)}`);
}

/**
 * Reads a .jsonl file and parses it into a KnowledgeGraph for one-time migration
 * into SQLite. This is the loadGraph body from the retired JsonlStore, unchanged
 * in behavior: per-line error isolation (a malformed line is logged to stderr and
 * skipped rather than killing the whole load) plus the backward-compat
 * deserialization the old loader carried — missing `project` becomes null,
 * missing temporal fields on relations get defaults, valid-time fields are
 * optional, and legacy string observations are widened by normalizeObservation.
 *
 * @param filePath - Absolute path to the .jsonl file to read
 * @returns The parsed graph, or an empty graph if the file doesn't exist (ENOENT)
 */
export async function readJsonlGraph(filePath: string): Promise<KnowledgeGraph> {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const lines = data.split('\n').filter(line => line.trim() !== '');
    const graph: KnowledgeGraph = { entities: [], relations: [] };
    for (const line of lines) {
      // Two-level error handling: parse errors (invalid JSON) are distinct from
      // processing errors (valid JSON but invalid entity/observation data).
      let item: any;
      try {
        item = JSON.parse(line);
      } catch {
        console.error(`Skipping malformed JSONL line (invalid JSON): ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
        continue;
      }
      try {
        if (item.type === 'entity') {
          // Validate required fields exist and are strings before pushing
          if (typeof item.name !== 'string' || typeof item.entityType !== 'string') {
            console.error(`Skipping entity with missing/invalid fields: ${JSON.stringify(item).substring(0, 100)}`);
            continue;
          }
          // Warn if project is present but not a string (e.g., "project": 42).
          // Unlike invalid name/entityType which skip the entity entirely,
          // a non-string project silently becomes null (global). Log so the
          // user knows their project annotation was discarded.
          if (item.project != null && typeof item.project !== 'string') {
            console.error(`Warning: entity "${item.name}" has non-string project value (${typeof item.project}), treating as global`);
          }
          graph.entities.push({
            name: item.name,
            entityType: item.entityType,
            observations: (item.observations || []).map(normalizeObservation),
            project: typeof item.project === 'string' ? item.project : null,
            // Fall back to sentinel for legacy JSONL files that predate Phase 4 timestamps
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : ENTITY_TIMESTAMP_SENTINEL,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : ENTITY_TIMESTAMP_SENTINEL,
          });
        } else if (item.type === 'relation') {
          // Validate required fields exist and are strings before pushing
          if (typeof item.from !== 'string' || typeof item.to !== 'string' || typeof item.relationType !== 'string') {
            console.error(`Skipping relation with missing/invalid fields: ${JSON.stringify(item).substring(0, 100)}`);
            continue;
          }
          graph.relations.push({
            from: item.from,
            to: item.to,
            relationType: item.relationType,
            // Temporal defaults for backward compat with JSONL files that predate the type split.
            // JSONL files may or may not have these fields serialized.
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : ENTITY_TIMESTAMP_SENTINEL,
            supersededAt: typeof item.supersededAt === 'string' ? item.supersededAt : '',
            // Valid time (v14): optional — absent in files predating it.
            ...(typeof item.validFrom === 'string' && item.validFrom ? { validFrom: item.validFrom } : {}),
            ...(typeof item.validUntil === 'string' && item.validUntil ? { validUntil: item.validUntil } : {}),
          });
        }
      } catch (processError) {
        // normalizeObservation or other processing error -- entity is valid JSON
        // but has invalid data (e.g., observation is a number instead of string/object)
        console.error(`Skipping entry with invalid data (${item.name || item.from || 'unknown'}): ${processError}`);
      }
    }
    return graph;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as any).code === 'ENOENT') {
      return { entities: [], relations: [] };
    }
    throw error;
  }
}
