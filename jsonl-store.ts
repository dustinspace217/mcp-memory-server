// jsonl-store.ts -- JSONL flat-file storage backend for the knowledge graph.
// Reads/writes newline-delimited JSON. Each line has a "type" discriminator
// field ("entity" or "relation") used for parsing -- stripped on load.

import { promises as fs } from 'fs';
import path from 'path';
import {
  createObservation,
  ENTITY_TIMESTAMP_SENTINEL,
  type Observation,
  type Entity,
  type Relation,
  type RelationInput,
  type InvalidateRelationInput,
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
  type SkippedEntity,
  type CreateEntitiesResult,
  type PaginationParams,
  type PaginatedKnowledgeGraph,
  type SupersedeInput,
  type SetObservationMetadataInput,
  type ContextLayersResult,
  type ContextLayerObservation,
  type SummaryResult,
  type SummaryObservation,
  type SummaryEntity,
  type EntityTimelineResult,
  InvalidCursorError,
} from './types.js';
import {
  type CursorPayload,
  encodeCursor,
  decodeCursor,
  clampLimit,
  readGraphFingerprint,
  searchNodesFingerprint,
} from './cursor.js';

/**
 * Handles the legacy memory.json -> memory.jsonl migration.
 * Only runs when the target is the default memory.jsonl path alongside the script.
 * Exported so ensureMemoryFilePath() in index.ts can call it during JSONL path resolution.
 *
 * @param scriptDir - Directory containing the compiled script (dist/)
 * @param jsonlPath - Target .jsonl path to migrate to
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
 * String observations get createdAt: 'unknown' since we don't know when they were created.
 * Object observations are validated for required fields -- malformed data throws.
 *
 * @param obs - Raw observation from JSONL: string (legacy) or object
 * @returns A valid Observation with content and createdAt fields
 * @throws Error if obs is not a string and doesn't have a valid content field
 */
export function normalizeObservation(obs: unknown): Observation {
  if (typeof obs === 'string') {
    return { content: obs, createdAt: 'unknown', importance: 3.0, contextLayer: null, memoryType: null };
  }
  if (typeof obs === 'object' && obs !== null && 'content' in obs && typeof (obs as any).content === 'string') {
    // Cast to access optional fields — legacy JSONL data won't have the v1.1 metadata fields
    const o = obs as { content: string; createdAt?: unknown; importance?: unknown; contextLayer?: unknown; memoryType?: unknown };
    return {
      content: o.content,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : 'unknown',
      importance: typeof o.importance === 'number' ? o.importance : 3.0,
      contextLayer: typeof o.contextLayer === 'string' ? o.contextLayer : null,
      memoryType: typeof o.memoryType === 'string' ? o.memoryType : null,
    };
  }
  throw new Error(`Invalid observation format: ${JSON.stringify(obs)}`);
}

/**
 * JSONL-backed knowledge graph store. Loads the entire graph from a JSONL file
 * on every read, modifies in memory, and writes back atomically (temp file + rename).
 *
 * Implements GraphStore so it can be swapped with SqliteStore transparently.
 *
 * @deprecated JSONL backend is deprecated and will be removed in v2.0.
 * Migrate to SQLite by setting MEMORY_FILE_PATH to a .db file (e.g., memory.db).
 * SQLite supports vector search, observation supersede, and temporal relations.
 */
export class JsonlStore implements GraphStore {
  /** @param memoryFilePath - Absolute path to the .jsonl file. Created on first write
   *  if it doesn't exist. The entire graph is loaded from this file on every read
   *  and written back atomically on every write. */
  constructor(private memoryFilePath: string) {
    console.error(
      'WARNING: JSONL backend is deprecated and will be removed in v2.0. ' +
      'Migrate to SQLite by setting MEMORY_FILE_PATH to a .db file (e.g., memory.db).'
    );
  }

  /** No-op for JSONL -- no setup required. */
  async init(): Promise<void> {}

  /** No-op for JSONL -- no connection to close. */
  async close(): Promise<void> {}

  /** No-op for JSONL -- no background tasks to stop. */
  shutdown(): void {}

  /**
   * Reads the JSONL file and parses it into a KnowledgeGraph.
   * Each line is JSON with a "type" field for routing -- stripped from returned objects.
   * Malformed lines are logged to stderr and skipped.
   *
   * @returns The full graph, or an empty graph if the file doesn't exist.
   */
  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");
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
          if (item.type === "entity") {
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
          } else if (item.type === "relation") {
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
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  /**
   * Serializes the graph to JSONL with atomic write (temp file + rename).
   * Entities are written first, then relations.
   */
  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => JSON.stringify({
        type: "entity", name: e.name, entityType: e.entityType,
        observations: e.observations, project: e.project,
        updatedAt: e.updatedAt, createdAt: e.createdAt
      })),
      ...graph.relations.map(r => JSON.stringify({
        type: "relation", from: r.from, to: r.to, relationType: r.relationType,
        createdAt: r.createdAt, supersededAt: r.supersededAt
      })),
    ];
    const tmpPath = this.memoryFilePath + '.tmp';
    // try-catch ensures .tmp is cleaned up on ANY failure (writeFile or rename),
    // not just rename failure. Fixes #49: disk-full writeFile left .tmp behind.
    try {
      await fs.writeFile(tmpPath, lines.join("\n") + "\n");
      await fs.rename(tmpPath, this.memoryFilePath);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  }

  /**
   * Sorts entities by updatedAt DESC (name ASC as tiebreaker), applies cursor-based
   * pagination, and returns the paginated result with nextCursor and totalCount.
   * The full relation-filtering logic is handled by the caller.
   *
   * @param allEntities - Pre-filtered entity array (project/search filtering already applied)
   * @param allRelations - All relations in the graph (caller will filter)
   * @param fingerprint - Query fingerprint for cursor validation
   * @param pagination - Optional cursor and limit
   * @returns PaginatedKnowledgeGraph with sorted, paginated entities
   */
  private paginateEntities(
    allEntities: Entity[],
    allRelations: Relation[],
    fingerprint: string,
    pagination?: PaginationParams,
  ): PaginatedKnowledgeGraph {
    // totalCount reflects the full filtered set (before pagination slices it)
    const totalCount = allEntities.length;

    // Sort by updatedAt DESC (most recently updated first),
    // then by name ASC for deterministic tiebreaking when timestamps match
    const sorted = [...allEntities].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt > b.updatedAt ? -1 : 1;  // DESC
      }
      return a.name < b.name ? -1 : 1;  // ASC tiebreaker
    });

    // When pagination is not requested, return all sorted entities.
    // This matches SQLite behavior (which omits LIMIT when pagination is undefined)
    // and preserves backward compatibility for direct API callers.
    if (!pagination) {
      return { entities: sorted, relations: allRelations, nextCursor: null, totalCount };
    }

    // Clamp the limit to [1, MAX_PAGE_SIZE], defaulting to DEFAULT_PAGE_SIZE
    const limit = clampLimit(pagination.limit);

    // Find the cursor position if a cursor was provided.
    // startIndex is where the current page begins in the sorted array.
    let startIndex = 0;
    if (pagination.cursor) {
      // decodeCursor validates structure and fingerprint match — throws on any problem
      const cursor = decodeCursor(pagination.cursor, fingerprint);
      // Find the entity matching the cursor — the next page starts AFTER this entity.
      // Cursor stores the updatedAt and name of the last entity from the previous page.
      const cursorIndex = sorted.findIndex(e =>
        e.updatedAt === cursor.u && e.name === (cursor.n ?? '')
      );
      if (cursorIndex === -1) {
        // Cursor entity was deleted or mutated — documented edge case of keyset pagination
        throw new InvalidCursorError('Cursor position not found — entity may have been modified or deleted');
      }
      startIndex = cursorIndex + 1;
    }

    // Slice the page plus one extra to detect if there's a next page
    const pageWithExtra = sorted.slice(startIndex, startIndex + limit + 1);
    // If we got more than `limit` entities, there's at least one more page
    const hasMore = pageWithExtra.length > limit;
    // Trim to exactly `limit` entities for the current page
    const pageEntities = hasMore ? pageWithExtra.slice(0, limit) : pageWithExtra;

    // Build next cursor from the last entity on this page (if there are more pages)
    let nextCursor: string | null = null;
    if (hasMore && pageEntities.length > 0) {
      const last = pageEntities[pageEntities.length - 1];
      nextCursor = encodeCursor({
        u: last.updatedAt,
        i: 0,  // JSONL has no integer id — uses name as tiebreaker instead
        n: last.name,
        q: fingerprint,
      });
    }

    // Filter relations to the current page. When all filtered entities fit on one page
    // (no cursor offset and no overflow), pass through the caller's pre-filtered relations
    // unchanged — this preserves OR-logic relation inclusion for unpaginated searchNodes.
    // Only narrow to AND-logic (both endpoints on page) when pagination actually slices
    // the entity set, since showing a relation to an off-page entity would be confusing.
    let filteredRelations: Relation[];
    if (startIndex === 0 && !hasMore) {
      // Full result set fits on this page — use caller's relation filtering as-is
      filteredRelations = allRelations;
    } else {
      // Pagination sliced the entity set — only show relations where both endpoints are visible
      const pageEntityNames = new Set(pageEntities.map(e => e.name));
      filteredRelations = allRelations.filter(r =>
        pageEntityNames.has(r.from) && pageEntityNames.has(r.to)
      );
    }

    return { entities: pageEntities, relations: filteredRelations, nextCursor, totalCount };
  }

  /**
   * Creates new entities, optionally scoped to a project.
   * Skips name-duplicates (both existing and within-batch) and reports which
   * entities were skipped along with the project that owns the existing entity.
   * Observations can be strings (auto-timestamped) or Observation objects.
   * Duplicate observations within a single entity are deduplicated by content.
   *
   * @param entities - Array of EntityInput to create
   * @param projectId - Optional project name; normalized to lowercase/trimmed. Omit for global.
   * @returns CreateEntitiesResult with created entities and skipped duplicates
   */
  async createEntities(entities: EntityInput[], projectId?: string): Promise<CreateEntitiesResult> {
    const graph = await this.loadGraph();
    // projectId arrives pre-normalized from normalizeProjectId() in index.ts.
    // Convert undefined (global scope) to null for the entity project field.
    const normalizedProject = projectId ?? null;

    // Capture a single timestamp for all entities created in this batch
    const now = new Date().toISOString();
    const normalized: Entity[] = entities.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: [...new Map(
        e.observations.map(obs => {
          const o = typeof obs === 'string' ? createObservation(obs) : obs;
          return [o.content, o] as const;
        })
      ).values()],
      project: normalizedProject,
      updatedAt: now,
      createdAt: now,
    }));

    // Map of entity name → owning project, used for both dedup and skip reporting
    const existingEntityMap = new Map(graph.entities.map(e => [e.name, e.project]));
    const created: Entity[] = [];
    const skipped: SkippedEntity[] = [];

    for (const e of normalized) {
      if (existingEntityMap.has(e.name)) {
        skipped.push({ name: e.name, existingProject: existingEntityMap.get(e.name)! });
      } else {
        existingEntityMap.set(e.name, e.project);
        created.push(e);
      }
    }
    graph.entities.push(...created);
    await this.saveGraph(graph);
    return { created, skipped };
  }

  /**
   * Creates new relations. Deduplicates by composite key [from, to, relationType].
   * Does NOT validate that endpoint entities exist (JSONL limitation).
   * Accepts RelationInput (3-field) and returns Relation (5-field with temporal defaults).
   *
   * @param relations - Array of { from, to, relationType } inputs
   * @returns Only the relations that were actually created, with temporal defaults
   */
  async createRelations(relations: RelationInput[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const existingKeys = new Set(graph.relations.map(r => JSON.stringify([r.from, r.to, r.relationType])));
    const newRelations: Relation[] = [];
    for (const r of relations) {
      const key = JSON.stringify([r.from, r.to, r.relationType]);
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        // Build full Relation with temporal defaults (JSONL doesn't store these fields)
        const fullRelation: Relation = {
          from: r.from,
          to: r.to,
          relationType: r.relationType,
          createdAt: ENTITY_TIMESTAMP_SENTINEL,
          supersededAt: '',
        };
        newRelations.push(fullRelation);
      }
    }
    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  /**
   * Adds observations to existing entities. Deduplicates by content string.
   * Throws if any entityName is not found (before saving -- no partial writes).
   */
  async addObservations(observations: AddObservationInput[]): Promise<AddObservationResult[]> {
    const graph = await this.loadGraph();
    const results = observations.map(o => {
      const entity = graph.entities.find(e => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      // Capture a single timestamp for all observations in this entity's batch
      // so observation.createdAt and entity.updatedAt are consistent
      const now = new Date().toISOString();
      const existingContents = new Set(entity.observations.map(obs => obs.content));
      const newObservations: Observation[] = [];
      for (let i = 0; i < o.contents.length; i++) {
        const content = o.contents[i];
        if (!existingContents.has(content)) {
          existingContents.add(content);
          // Read metadata from parallel arrays, falling back to defaults when
          // the array is omitted or shorter than contents
          newObservations.push({
            content,
            createdAt: now,
            importance: o.importances?.[i] ?? 3.0,
            contextLayer: o.contextLayers?.[i] ?? null,
            memoryType: o.memoryTypes?.[i] ?? null,
          });
        }
      }
      entity.observations.push(...newObservations);
      // Bump updatedAt — entity content has changed
      if (newObservations.length > 0) {
        entity.updatedAt = now;
      }
      return { entityName: o.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  /**
   * Delete entities is not supported in the JSONL backend.
   *
   * SQLite implements deleteEntities as soft-delete (sets superseded_at on the
   * entity row + cascades to its observations and relations) so that as_of
   * queries can still recover the entity at past timestamps. JSONL has no
   * superseded_at column and no temporal model, so it can only offer hard-delete.
   * Allowing JSONL to silently fall back to hard-delete would create a contract
   * divergence: callers would lose history they expected to be preserved.
   *
   * @throws Error always -- JSONL backend does not support deleteEntities;
   *         migrate to SQLite to use soft-delete semantics.
   */
  async deleteEntities(_entityNames: string[]): Promise<void> {
    throw new Error('delete_entities not supported in JSONL backend: migrate to SQLite for soft-delete semantics');
  }

  /**
   * Deletes observations by content string from the named entities.
   * Silently ignores non-existent entities (idempotent).
   */
  async deleteObservations(deletions: DeleteObservationInput[]): Promise<void> {
    const graph = await this.loadGraph();
    deletions.forEach(d => {
      const entity = graph.entities.find(e => e.name === d.entityName);
      if (entity) {
        const toDelete = new Set(d.contents);
        entity.observations = entity.observations.filter(o => !toDelete.has(o.content));
        // Bump updatedAt unconditionally — deletion is idempotent, so even if
        // no observations matched, the caller expressed intent to modify this entity
        entity.updatedAt = new Date().toISOString();
      }
    });
    await this.saveGraph(graph);
  }

  /**
   * Deletes relations by exact match on all three fields (from, to, relationType).
   * Silently ignores non-existent relations (idempotent).
   *
   * @param relations - Array of { from, to, relationType } identifying relations to delete
   */
  async deleteRelations(relations: RelationInput[]): Promise<void> {
    const graph = await this.loadGraph();
    const keysToDelete = new Set(relations.map(r => JSON.stringify([r.from, r.to, r.relationType])));
    graph.relations = graph.relations.filter(r => !keysToDelete.has(JSON.stringify([r.from, r.to, r.relationType])));
    await this.saveGraph(graph);
  }

  /**
   * Supersede observations is not supported in the JSONL backend.
   * This feature requires SQLite for transactional atomicity and the
   * superseded_at column. Users should migrate to SQLite to use this feature.
   *
   * @throws Error always -- JSONL backend does not support supersede
   */
  async supersedeObservations(_supersessions: SupersedeInput[]): Promise<void> {
    throw new Error('supersede_observations not supported in JSONL backend: migrate to SQLite');
  }

  /**
   * Invalidate relations is not supported in the JSONL backend.
   * This feature requires SQLite for the superseded_at column on relations.
   *
   * @throws Error always -- JSONL backend does not support invalidate_relations
   */
  async invalidateRelations(_relations: InvalidateRelationInput[]): Promise<number> {
    throw new Error('invalidate_relations not supported in JSONL backend: migrate to SQLite');
  }

  /**
   * Entity timeline is not supported in the JSONL backend.
   * This feature requires SQLite for querying superseded observations and relations.
   *
   * @throws Error always -- JSONL backend does not support entity_timeline
   */
  async entityTimeline(_entityName: string, _projectId?: string): Promise<EntityTimelineResult | null> {
    throw new Error('entity_timeline not supported in JSONL backend: migrate to SQLite');
  }

  /**
   * Set observation metadata is not supported in the JSONL backend.
   * This feature requires SQLite's observation metadata columns (importance,
   * context_layer, memory_type) added in schema v6.
   *
   * @throws Error always -- JSONL backend does not support set_observation_metadata
   */
  async setObservationMetadata(_updates: SetObservationMetadataInput[]): Promise<number> {
    throw new Error('set_observation_metadata not supported in JSONL backend: migrate to SQLite');
  }

  /**
   * Returns a concise summary snapshot by scanning the in-memory graph.
   * Three sections: top observations by importance, recently updated entities,
   * and aggregate stats.
   *
   * @param projectId - Optional project scope. Includes project + global entities.
   * @param excludeContextLayers - When true, excludes L0/L1 observations.
   * @param limit - Max top observations to return (default 20, max 100).
   * @returns SummaryResult with topObservations, recentEntities, and stats
   */
  async getSummary(projectId?: string, excludeContextLayers?: boolean, limit?: number): Promise<Readonly<SummaryResult>> {
    const graph = await this.loadGraph();
    const obsLimit = Math.min(Math.max(limit ?? 20, 1), 100);

    // Filter entities by project scope (include project + global).
    const entities = graph.entities.filter(e =>
      projectId === undefined || e.project === null || e.project === projectId
    );

    // -- 1. Collect all matching observations --
    const allObs: SummaryObservation[] = [];
    for (const entity of entities) {
      for (const obs of entity.observations) {
        // Skip L0/L1 observations when excludeContextLayers is set.
        if (excludeContextLayers && obs.contextLayer !== null) continue;

        allObs.push({
          entityName: entity.name,
          content: obs.content,
          importance: obs.importance,
          memoryType: obs.memoryType,
          updatedAt: entity.updatedAt,
        });
      }
    }

    // Sort by importance DESC, then entity recency DESC.
    allObs.sort((a, b) => b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
    const topObservations = allObs.slice(0, obsLimit);

    // -- 2. Recently updated entities (last 5) --
    const sortedEntities = [...entities].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const recentEntities: SummaryEntity[] = sortedEntities.slice(0, 5).map(e => ({
      name: e.name,
      entityType: e.entityType,
      observationCount: e.observations.length,
      updatedAt: e.updatedAt,
    }));

    // -- 3. Aggregate stats --
    const totalRelations = graph.relations.length;
    const allProjectEntities = graph.entities.filter(e => e.project !== null);
    const projectSet = new Set(allProjectEntities.map(e => e.project));

    return {
      topObservations,
      recentEntities,
      stats: {
        totalEntities: graph.entities.length,
        totalObservations: graph.entities.reduce((sum, e) => sum + e.observations.length, 0),
        totalRelations,
        projectCount: projectSet.size,
      },
    };
  }

  // -- Token budget constants for context layers (from spec §7) --
  private static readonly L0_CHAR_BUDGET = 400;
  private static readonly L1_CHAR_BUDGET = 3200;

  /**
   * Returns L0 and L1 observations from the in-memory graph. Filters by project
   * (including global entities) and applies soft token budgets. Works by scanning
   * all entities and their observations — no index needed since the graph is in memory.
   *
   * @param projectId - Optional project scope. When set, includes project + global.
   * @param layers - Which layers to return. Defaults to ['L0', 'L1'].
   * @returns ContextLayersResult with L0 and L1 arrays plus tokenEstimate
   */
  async getContextLayers(projectId?: string, layers?: string[]): Promise<Readonly<ContextLayersResult>> {
    const graph = await this.loadGraph();
    const requestedLayers = new Set(layers ?? ['L0', 'L1']);

    // Collect matching observations from all project-matching entities.
    const rawL0: ContextLayerObservation[] = [];
    const rawL1: ContextLayerObservation[] = [];

    for (const entity of graph.entities) {
      // Project filter: include if entity matches project OR is global.
      if (projectId !== undefined && entity.project !== null && entity.project !== projectId) {
        continue;
      }

      for (const obs of entity.observations) {
        if (obs.contextLayer === 'L0' && requestedLayers.has('L0')) {
          rawL0.push({
            entityName: entity.name,
            content: obs.content,
            importance: obs.importance,
            memoryType: obs.memoryType,
          });
        } else if (obs.contextLayer === 'L1' && requestedLayers.has('L1')) {
          rawL1.push({
            entityName: entity.name,
            content: obs.content,
            importance: obs.importance,
            memoryType: obs.memoryType,
            updatedAt: entity.updatedAt,
          });
        }
      }
    }

    // Sort by importance DESC within each layer.
    rawL0.sort((a, b) => b.importance - a.importance);
    rawL1.sort((a, b) => b.importance - a.importance);

    // Apply L1 char budget (L0 always included per spec).
    const L0 = rawL0;
    const L1: ContextLayerObservation[] = [];
    let l1Chars = 0;

    for (const obs of rawL1) {
      const charCost = obs.entityName.length + obs.content.length;
      if (l1Chars + charCost > JsonlStore.L1_CHAR_BUDGET && L1.length > 0) {
        continue;
      }
      l1Chars += charCost;
      L1.push(obs);
    }

    const l0Chars = L0.reduce((sum, o) => sum + o.entityName.length + o.content.length, 0);
    const tokenEstimate = Math.ceil((l0Chars + l1Chars) / 4);

    return { L0, L1, tokenEstimate };
  }

  /**
   * Returns the knowledge graph, optionally filtered by project, with cursor-based pagination.
   * Entities are sorted by most recently updated first.
   * When projectId is provided, returns entities belonging to that project
   * plus global entities (project === null). Relations are included only
   * when both endpoints are in the filtered entity set.
   * When projectId is omitted and no pagination is requested, returns the entire unfiltered graph
   * (fast path — no sorting, for backward compat with existing tests).
   *
   * @param projectId - Optional project name to filter by; normalized to lowercase/trimmed
   * @param pagination - Optional cursor and limit for paginated results
   * @returns PaginatedKnowledgeGraph with entities, relations, nextCursor, and totalCount
   */
  async readGraph(projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<PaginatedKnowledgeGraph> {
    if (asOf !== undefined) {
      throw new Error('as_of queries not supported in JSONL backend: migrate to SQLite');
    }
    const graph = await this.loadGraph();
    // Fingerprint encodes the query parameters so cursors can't be reused across different queries
    const fingerprint = readGraphFingerprint(projectId, asOf);

    if (!projectId && !pagination) {
      // Fast path: no filtering, no pagination — return everything unsorted
      // (important for backward compat since existing tests don't expect sorted results)
      return { ...graph, nextCursor: null, totalCount: graph.entities.length };
    }

    // Start with all entities; narrow down if project-scoped
    let filteredEntities = graph.entities;
    let filteredRelations = graph.relations;

    if (projectId) {
      // projectId arrives pre-normalized from normalizeProjectId() in index.ts
      filteredEntities = graph.entities.filter(e =>
        e.project === projectId || e.project === null
      );
      const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
      filteredRelations = graph.relations.filter(r =>
        filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
      );
    }

    return this.paginateEntities(filteredEntities, filteredRelations, fingerprint, pagination);
  }

  /**
   * Searches for entities matching the query. Results are paginated by most recently updated first.
   * Case-insensitive substring match against name, entityType, or observation content.
   * Optionally filters by project (matching entities must belong to the project or be global).
   *
   * @param query - Case-insensitive substring to search for
   * @param projectId - Optional project name; only returns entities in this project or global
   * @param pagination - Optional cursor and limit for paginated results
   * @returns PaginatedKnowledgeGraph with matching entities, relations, nextCursor, and totalCount
   */
  async searchNodes(query: string, projectId?: string, pagination?: PaginationParams, asOf?: string): Promise<PaginatedKnowledgeGraph> {
    if (asOf !== undefined) {
      throw new Error('as_of queries not supported in JSONL backend: migrate to SQLite');
    }
    const graph = await this.loadGraph();
    const lowerQuery = query.toLowerCase();
    // projectId arrives pre-normalized from normalizeProjectId() in index.ts
    const normalizedProject = projectId;
    // Fingerprint includes both projectId and query so cursors can't cross-pollinate
    const fingerprint = searchNodesFingerprint(projectId, query, asOf);

    // First filter: match by name, type, or observation content
    let filteredEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(lowerQuery) ||
      e.entityType.toLowerCase().includes(lowerQuery) ||
      e.observations.some(o => o.content.toLowerCase().includes(lowerQuery))
    );

    // Second filter: restrict to project + globals if a projectId was given
    if (normalizedProject) {
      filteredEntities = filteredEntities.filter(e =>
        e.project === normalizedProject || e.project === null
      );
    }

    // Build the full relation set before pagination slices the entities.
    // When project-filtered, use AND logic (both endpoints must be in the result set)
    // to avoid leaking cross-project relations. Without a project filter, use OR
    // logic (at least one endpoint matches) for backward compatibility.
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = normalizedProject
      ? graph.relations.filter(r => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to))
      : graph.relations.filter(r => filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to));

    return this.paginateEntities(filteredEntities, filteredRelations, fingerprint, pagination);
  }

  /**
   * Retrieves specific entities by exact name match. Optionally filters by project
   * (only returns entities in the specified project or global).
   * Returns matching entities plus relations where both endpoints are in the result set.
   *
   * @param names - Array of entity name strings to retrieve
   * @param projectId - Optional project name; only returns entities in this project or global
   * @returns KnowledgeGraph with matching entities and connected relations
   */
  async openNodes(names: string[], projectId?: string, asOf?: string): Promise<KnowledgeGraph> {
    if (asOf !== undefined) {
      throw new Error('as_of queries not supported in JSONL backend: migrate to SQLite');
    }
    const graph = await this.loadGraph();
    const nameSet = new Set(names);
    // projectId arrives pre-normalized from normalizeProjectId() in index.ts
    const normalizedProject = projectId;

    // First filter: match by name
    let filteredEntities = graph.entities.filter(e => nameSet.has(e.name));

    // Second filter: restrict to project + globals if a projectId was given
    if (normalizedProject) {
      filteredEntities = filteredEntities.filter(e =>
        e.project === normalizedProject || e.project === null
      );
    }

    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    // When project-filtered, use AND logic (both endpoints must be in the result set)
    // to avoid leaking cross-project relations. Without a project filter, use OR
    // logic (at least one endpoint matches) for backward compatibility.
    const filteredRelations = graph.relations.filter(r =>
      normalizedProject
        ? filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
        : filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );
    return { entities: filteredEntities, relations: filteredRelations };
  }

  /**
   * Lists all distinct project names that have at least one entity.
   * Global entities (project === null) are excluded from the list.
   *
   * @returns Sorted array of project name strings
   */
  async listProjects(): Promise<string[]> {
    const graph = await this.loadGraph();
    const projects = new Set<string>();
    for (const e of graph.entities) {
      if (e.project !== null) projects.add(e.project);
    }
    return [...projects].sort();
  }
}
