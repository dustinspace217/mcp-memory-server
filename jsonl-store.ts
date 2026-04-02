// jsonl-store.ts -- JSONL flat-file storage backend for the knowledge graph.
// Reads/writes newline-delimited JSON. Each line has a "type" discriminator
// field ("entity" or "relation") used for parsing -- stripped on load.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createObservation,
  type Observation,
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type GraphStore,
  type EntityInput,
  type AddObservationInput,
  type DeleteObservationInput,
  type AddObservationResult,
} from './types.js';

// Default memory file path, used when MEMORY_FILE_PATH env var is not set.
// Points to memory.jsonl alongside the compiled script in dist/.
export const defaultMemoryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'memory.jsonl'
);

/**
 * Resolves the memory file path with backward-compatibility migration.
 *
 * Priority:
 * 1. MEMORY_FILE_PATH env var (relative paths resolved against script dir)
 * 2. Legacy memory.json -> memory.jsonl migration
 * 3. Default memory.jsonl alongside the script
 *
 * @returns Absolute path to the JSONL memory file.
 */
export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH);
  }

  const oldMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
  const newMemoryPath = defaultMemoryPath;

  try {
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      return newMemoryPath;
    } catch {
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldMemoryPath, newMemoryPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
      return newMemoryPath;
    }
  } catch {
    return newMemoryPath;
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
        try {
          const item = JSON.parse(line);
          if (item.type === "entity") {
            graph.entities.push({
              name: item.name,
              entityType: item.entityType,
              observations: (item.observations || []).map(normalizeObservation)
            });
          } else if (item.type === "relation") {
            graph.relations.push({
              from: item.from,
              to: item.to,
              relationType: item.relationType
            });
          }
        } catch (parseError) {
          console.error(`Skipping malformed JSONL line: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
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
        type: "entity", name: e.name, entityType: e.entityType, observations: e.observations
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
   * Creates new entities. Skips name-duplicates (both existing and within-batch).
   * Observations can be strings (auto-timestamped) or Observation objects.
   * Duplicate observations within a single entity are deduplicated by content.
   */
  async createEntities(entities: EntityInput[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const normalized: Entity[] = entities.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: [...new Map(
        e.observations.map(obs => {
          const o = typeof obs === 'string' ? createObservation(obs) : obs;
          return [o.content, o] as const;
        })
      ).values()],
    }));
    const existingNames = new Set(graph.entities.map(e => e.name));
    const newEntities: Entity[] = [];
    for (const e of normalized) {
      if (!existingNames.has(e.name)) {
        existingNames.add(e.name);
        newEntities.push(e);
      }
    }
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
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

  /** Returns the entire knowledge graph. */
  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  /**
   * Searches for entities matching the query (case-insensitive substring match
   * against name, entityType, or observation content). Returns matching entities
   * plus relations where at least one endpoint is in the matched set.
   */
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const lowerQuery = query.toLowerCase();
    const filteredEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(lowerQuery) ||
      e.entityType.toLowerCase().includes(lowerQuery) ||
      e.observations.some(o => o.content.toLowerCase().includes(lowerQuery))
    );
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );
    return { entities: filteredEntities, relations: filteredRelations };
  }

  /**
   * Retrieves specific entities by exact name match. Includes relations where
   * at least one endpoint is in the requested set.
   */
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const nameSet = new Set(names);
    const filteredEntities = graph.entities.filter(e => nameSet.has(e.name));
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );
    return { entities: filteredEntities, relations: filteredRelations };
  }
}
