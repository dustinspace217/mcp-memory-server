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
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
  type SkippedEntity,
  type CreateEntitiesResult,
} from './types.js';

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
    return { content: obs, createdAt: 'unknown' };
  }
  if (typeof obs === 'object' && obs !== null && 'content' in obs && typeof (obs as any).content === 'string') {
    const o = obs as { content: string; createdAt?: unknown };
    return {
      content: o.content,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : 'unknown',
    };
  }
  throw new Error(`Invalid observation format: ${JSON.stringify(obs)}`);
}

/**
 * JSONL-backed knowledge graph store. Loads the entire graph from a JSONL file
 * on every read, modifies in memory, and writes back atomically (temp file + rename).
 *
 * Implements GraphStore so it can be swapped with SqliteStore transparently.
 */
export class JsonlStore implements GraphStore {
  constructor(private memoryFilePath: string) {}

  /** No-op for JSONL -- no setup required. */
  async init(): Promise<void> {}

  /** No-op for JSONL -- no connection to close. */
  async close(): Promise<void> {}

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
              relationType: item.relationType
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
        type: "relation", from: r.from, to: r.to, relationType: r.relationType
      })),
    ];
    const tmpPath = this.memoryFilePath + '.tmp';
    await fs.writeFile(tmpPath, lines.join("\n") + "\n");
    try {
      await fs.rename(tmpPath, this.memoryFilePath);
    } catch (renameError) {
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw renameError;
    }
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
    // Normalize the project ID: trim whitespace, lowercase, or null for global
    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC') || null;

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
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const existingKeys = new Set(graph.relations.map(r => JSON.stringify([r.from, r.to, r.relationType])));
    const newRelations: Relation[] = [];
    for (const r of relations) {
      const key = JSON.stringify([r.from, r.to, r.relationType]);
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        newRelations.push(r);
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
      const existingContents = new Set(entity.observations.map(obs => obs.content));
      const newObservations: Observation[] = [];
      for (const content of o.contents) {
        if (!existingContents.has(content)) {
          existingContents.add(content);
          newObservations.push(createObservation(content));
        }
      }
      entity.observations.push(...newObservations);
      // Bump updatedAt — entity content has changed
      if (newObservations.length > 0) {
        entity.updatedAt = new Date().toISOString();
      }
      return { entityName: o.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  /**
   * Deletes entities by name and cascade-deletes their relations.
   * Silently ignores names that don't match (idempotent).
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    const namesToDelete = new Set(entityNames);
    graph.entities = graph.entities.filter(e => !namesToDelete.has(e.name));
    graph.relations = graph.relations.filter(r => !namesToDelete.has(r.from) && !namesToDelete.has(r.to));
    await this.saveGraph(graph);
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
   * Deletes relations by exact match on all three fields.
   * Silently ignores non-existent relations (idempotent).
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    const keysToDelete = new Set(relations.map(r => JSON.stringify([r.from, r.to, r.relationType])));
    graph.relations = graph.relations.filter(r => !keysToDelete.has(JSON.stringify([r.from, r.to, r.relationType])));
    await this.saveGraph(graph);
  }

  /**
   * Returns the knowledge graph, optionally filtered by project.
   * When projectId is provided, returns entities belonging to that project
   * plus global entities (project === null). Relations are included only
   * when both endpoints are in the filtered entity set.
   * When projectId is omitted, returns the entire unfiltered graph.
   *
   * @param projectId - Optional project name to filter by; normalized to lowercase/trimmed
   * @returns KnowledgeGraph with entities and relations
   */
  async readGraph(projectId?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    if (!projectId) return graph;

    const normalizedProject = projectId.trim().toLowerCase().normalize('NFC');
    const filteredEntities = graph.entities.filter(e =>
      e.project === normalizedProject || e.project === null
    );
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );
    return { entities: filteredEntities, relations: filteredRelations };
  }

  /**
   * Searches for entities matching the query (case-insensitive substring match
   * against name, entityType, or observation content). Optionally filters by project
   * (matching entities must belong to the project or be global).
   * Returns matching entities plus relations where both endpoints are in the result set.
   *
   * @param query - Case-insensitive substring to search for
   * @param projectId - Optional project name; only returns entities in this project or global
   * @returns KnowledgeGraph with matching entities and connected relations
   */
  async searchNodes(query: string, projectId?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const lowerQuery = query.toLowerCase();
    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

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
   * Retrieves specific entities by exact name match. Optionally filters by project
   * (only returns entities in the specified project or global).
   * Returns matching entities plus relations where both endpoints are in the result set.
   *
   * @param names - Array of entity name strings to retrieve
   * @param projectId - Optional project name; only returns entities in this project or global
   * @returns KnowledgeGraph with matching entities and connected relations
   */
  async openNodes(names: string[], projectId?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const nameSet = new Set(names);
    const normalizedProject = projectId?.trim().toLowerCase().normalize('NFC');

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
