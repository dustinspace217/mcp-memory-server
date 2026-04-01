#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Default memory file path, used when MEMORY_FILE_PATH env var is not set
export const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.jsonl');

/**
 * Resolves the memory file path with backward-compatibility migration.
 *
 * Priority:
 * 1. If MEMORY_FILE_PATH env var is set, use it (resolving relative paths against
 *    the script directory, not cwd).
 * 2. If no env var is set, check for a legacy "memory.json" file alongside the script.
 *    If found (and no "memory.jsonl" exists), rename it to "memory.jsonl" and log
 *    the migration to stderr.
 * 3. Otherwise, return the default "memory.jsonl" path alongside the script.
 *
 * @returns Absolute path to the JSONL memory file.
 */
export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    // Custom path provided, use it as-is (with absolute path resolution)
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH);
  }

  // No custom path set, check for backward compatibility migration
  const oldMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
  const newMemoryPath = defaultMemoryPath;

  try {
    // Check if old file exists and new file doesn't
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      // Both files exist, use new one (no migration needed)
      return newMemoryPath;
    } catch {
      // Old file exists, new file doesn't - migrate
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldMemoryPath, newMemoryPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
      return newMemoryPath;
    }
  } catch {
    // Old file doesn't exist, use new path
    return newMemoryPath;
  }
}



// An observation is a single piece of knowledge attached to an entity.
// Each observation carries a creation timestamp for staleness detection.
export interface Observation {
  content: string;
  createdAt: string;  // ISO 8601 UTC, or 'unknown' for data migrated from the old string format
}

export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

/**
 * Converts a legacy string observation (from old JSONL files) into an Observation object,
 * or validates that an existing object has the required shape.
 *
 * String observations get createdAt: 'unknown' since we don't know when they were created.
 * Object observations are validated for required fields — malformed data throws rather than
 * silently propagating corruption through the graph.
 *
 * @param obs - Raw observation from JSONL: either a plain string (legacy) or an object
 * @returns A valid Observation with content and createdAt fields
 * @throws Error if obs is not a string and doesn't have a valid content field
 */
function normalizeObservation(obs: unknown): Observation {
  if (typeof obs === 'string') {
    return { content: obs, createdAt: 'unknown' };
  }
  // Validate object shape instead of blindly casting — catches corrupted JSONL entries
  if (typeof obs === 'object' && obs !== null && 'content' in obs && typeof (obs as any).content === 'string') {
    const o = obs as { content: string; createdAt?: unknown };
    return {
      content: o.content,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : 'unknown',
    };
  }
  throw new Error(`Invalid observation format: ${JSON.stringify(obs)}`);
}

// Creates a new Observation with the current UTC timestamp.
// Called when observations are added through the API (not during migration).
function createObservation(content: string): Observation {
  return { content, createdAt: new Date().toISOString() };
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
export class KnowledgeGraphManager {
  constructor(private memoryFilePath: string) {}

  /**
   * Reads the JSONL file from disk and parses it into a KnowledgeGraph.
   * Each line is a JSON object with a "type" field ("entity" or "relation") used for
   * routing during parsing — the type field is NOT included in the returned objects.
   *
   * Legacy observations (stored as plain strings in old files) are auto-migrated to
   * Observation objects with createdAt: 'unknown' via normalizeObservation().
   *
   * Malformed lines are logged to stderr and skipped rather than crashing the entire load.
   * Lines with unrecognized type values are silently ignored (forward compatibility).
   *
   * @returns The full knowledge graph. Returns an empty graph if the file does not exist.
   * @throws Re-throws any file read error that is not ENOENT (file not found).
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
          // Lines with unrecognized type values are silently skipped (forward compatibility)
        } catch (parseError) {
          // Skip malformed lines instead of crashing the entire load
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
   * Serializes the entire knowledge graph to the JSONL file, overwriting its contents.
   * Each entity and relation is written as a single JSON line with a "type" discriminator
   * field added for parsing on reload. Entities are written first, then relations.
   *
   * Uses atomic write (temp file + rename) to prevent data corruption if the process
   * crashes mid-write. fs.rename is atomic on POSIX-compliant filesystems when source
   * and destination are on the same mount.
   *
   * @param graph - The complete graph to persist. Comes from loadGraph() after modification.
   */
  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => JSON.stringify({
        type: "entity",
        name: e.name,
        entityType: e.entityType,
        observations: e.observations
      })),
      ...graph.relations.map(r => JSON.stringify({
        type: "relation",
        from: r.from,
        to: r.to,
        relationType: r.relationType
      })),
    ];
    // Write to temp file then atomically rename to prevent corruption on crash.
    // If rename fails, clean up the temp file so it doesn't leak on disk.
    const tmpPath = this.memoryFilePath + '.tmp';
    await fs.writeFile(tmpPath, lines.join("\n") + "\n");
    try {
      await fs.rename(tmpPath, this.memoryFilePath);
    } catch (renameError) {
      // Clean up orphaned temp file before re-throwing
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw renameError;
    }
  }

  /**
   * Creates new entities in the graph. Skips any entity whose name already exists
   * (deduplication is by name only — entityType and observations are ignored for
   * existing entities).
   *
   * Observations can be passed as plain strings (auto-timestamped with the current UTC
   * time) or as Observation objects (passed through as-is for migration/test scenarios).
   * Duplicate observations within a single entity are deduplicated by content string.
   *
   * @param entities - Array of entities to create. Each has a name, entityType, and observations.
   * @returns Only the entities that were actually created (excludes name-duplicates).
   */
  async createEntities(entities: Array<{ name: string; entityType: string; observations: (string | Observation)[] }>): Promise<Entity[]> {
    const graph = await this.loadGraph();
    // Normalize incoming observations: strings get a fresh timestamp, objects pass through.
    // Deduplicate observations within each entity by content string using a Map.
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
    // Use a Set for O(1) name lookups instead of .some() which is O(n*m).
    // Add to the Set as each entity is accepted so duplicates within the same
    // input batch are also caught (e.g., two entities named "A" in one call).
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
   * Creates new relations in the graph. A relation is a directed edge from one entity
   * to another with a relation type (e.g., "Alice" --knows--> "Bob").
   * Deduplicates by checking all three fields (from, to, relationType).
   *
   * NOTE: This does NOT validate that the referenced entity names actually exist
   * in the graph. Dangling relations are possible. SQLite foreign keys (Phase 2)
   * will resolve this structurally.
   *
   * @param relations - Array of { from, to, relationType } objects.
   * @returns Only the relations that were actually created (excludes duplicates).
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    // Use a Set of composite keys for O(1) dedup lookups instead of nested .some().
    // Add to the Set as each relation is accepted so duplicates within the same
    // input batch are also caught.
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
   * Adds new observations to existing entities. Each observation string is
   * auto-timestamped with the current UTC time and wrapped in an Observation object.
   * Deduplicates by content string — if an observation with the same content already
   * exists on the entity OR appears earlier in the same contents array, it is skipped.
   *
   * @param observations - Array of { entityName, contents: string[] }.
   * @returns Array of { entityName, addedObservations: Observation[] } — only the
   *          observations that were actually added (with their new timestamps).
   * @throws Error if any entityName does not match an existing entity. The error is
   *         thrown before saving, so no partial writes occur for entities listed after
   *         the missing one.
   */
  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: Observation[] }[]> {
    const graph = await this.loadGraph();
    const results = observations.map(o => {
      const entity = graph.entities.find(e => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      // Use a Set of existing content strings for O(1) dedup lookups.
      // Add to the Set as we go so duplicates within the same contents array are also caught.
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
   * Deletes entities by name and cascade-deletes relations: any relation where the
   * deleted entity appears as either the "from" or "to" endpoint is also removed.
   * Silently ignores names that do not match any existing entity (idempotent).
   *
   * @param entityNames - Array of entity name strings to delete.
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    // Use a Set for O(1) lookups instead of Array.includes() which is O(n) per check
    const namesToDelete = new Set(entityNames);
    graph.entities = graph.entities.filter(e => !namesToDelete.has(e.name));
    graph.relations = graph.relations.filter(r => !namesToDelete.has(r.from) && !namesToDelete.has(r.to));
    await this.saveGraph(graph);
  }

  /**
   * Deletes observations by content string — callers don't need to know timestamps.
   * Silently ignores non-existent entities (idempotent by design — "it's already gone"
   * is success). This differs from addObservations which throws on missing entities,
   * because adds are constructive (you need a valid target) while deletes are
   * destructive (the goal is absence, which is already achieved if the entity is gone).
   *
   * @param deletions - Array of { entityName, observations: string[] } to remove.
   */
  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const graph = await this.loadGraph();
    deletions.forEach(d => {
      const entity = graph.entities.find(e => e.name === d.entityName);
      if (entity) {
        const toDelete = new Set(d.observations);
        entity.observations = entity.observations.filter(o => !toDelete.has(o.content));
      }
    });
    await this.saveGraph(graph);
  }

  /**
   * Deletes specific relations by exact match on all three fields (from, to, relationType).
   * Silently ignores relations that do not exist (idempotent).
   *
   * @param relations - Array of { from, to, relationType } to remove.
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    // Use a Set of composite keys for O(1) lookups instead of nested .some()
    const keysToDelete = new Set(relations.map(r => JSON.stringify([r.from, r.to, r.relationType])));
    graph.relations = graph.relations.filter(r => !keysToDelete.has(JSON.stringify([r.from, r.to, r.relationType])));
    await this.saveGraph(graph);
  }

  /**
   * Returns the entire knowledge graph (all entities and all relations).
   * For an empty or missing file, returns { entities: [], relations: [] }.
   */
  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  /**
   * Searches for entities matching the query string (case-insensitive substring match
   * against entity name, entityType, or any observation's content string).
   *
   * Returns matching entities plus any relation where at least one endpoint is in
   * the matched set. This means the result may reference entity names that are NOT
   * in the returned entities array — the caller can use open_nodes to fetch those.
   *
   * @param query - The search string. Matched as a case-insensitive substring.
   * @returns A filtered KnowledgeGraph containing only matching entities and their
   *          connected relations. Returns { entities: [], relations: [] } for no matches.
   */
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Hoist toLowerCase outside the filter to avoid calling it up to 3x per entity
    const lowerQuery = query.toLowerCase();

    // Filter entities by case-insensitive substring match on name, type, or observation content
    const filteredEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(lowerQuery) ||
      e.entityType.toLowerCase().includes(lowerQuery) ||
      e.observations.some(o => o.content.toLowerCase().includes(lowerQuery))
    );

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Include relations where at least one endpoint matches the search results.
    // This lets callers discover connections to nodes outside the result set.
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
  }

  /**
   * Retrieves specific entities by exact name match and includes any relation
   * where at least one endpoint is in the requested set.
   *
   * Changed from requiring BOTH endpoints to match (which silently hid connections
   * to nodes outside the request set) to requiring only ONE endpoint. See the
   * inline comment below for the rationale.
   *
   * @param names - Array of entity name strings to retrieve.
   * @returns A KnowledgeGraph containing the requested entities and their connected
   *          relations. Non-existent names are silently skipped.
   */
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Use a Set for O(1) lookups instead of Array.includes() which is O(n) per entity
    const nameSet = new Set(names);
    const filteredEntities = graph.entities.filter(e => nameSet.has(e.name));

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Include relations where at least one endpoint is in the requested set.
    // Previously this required BOTH endpoints, which meant relations from a
    // requested node to an unrequested node were silently dropped — making it
    // impossible to discover a node's connections without reading the full graph.
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
  }
}

let knowledgeGraphManager: KnowledgeGraphManager;

// Zod schemas for MCP tool input/output validation.
// Input schemas accept plain strings for observations (server adds timestamps).
// Output schemas return full Observation objects with timestamps.
// String fields have .min(1) to prevent empty-name entities and .max() to prevent
// context window blowouts when observations are returned to MCP clients.

const ObservationSchema = z.object({
  content: z.string().min(1).describe("The content of the observation"),
  createdAt: z.string().describe("ISO 8601 UTC timestamp when the observation was created, or 'unknown' for migrated data"),
});

const EntityInputSchema = z.object({
  name: z.string().min(1).max(500).describe("The name of the entity"),
  entityType: z.string().min(1).max(500).describe("The type of the entity"),
  observations: z.array(z.string().min(1).max(5000)).max(100).describe("An array of observation contents associated with the entity"),
});

const EntityOutputSchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(ObservationSchema).describe("An array of observations with content and timestamps"),
});

const RelationSchema = z.object({
  from: z.string().min(1).max(500).describe("The name of the entity where the relation starts"),
  to: z.string().min(1).max(500).describe("The name of the entity where the relation ends"),
  relationType: z.string().min(1).max(500).describe("The type of the relation")
});

// The server instance and tools exposed to Claude
const server = new McpServer({
  name: "memory-server",
  version: "0.7.0",
});

server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntityInputSchema).max(100)
    },
    outputSchema: {
      entities: z.array(EntityOutputSchema)
    }
  },
  async ({ entities }) => {
    const result = await knowledgeGraphManager.createEntities(entities);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result }
    };
  }
);

server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: {
      relations: z.array(RelationSchema).max(100)
    },
    outputSchema: {
      relations: z.array(RelationSchema)
    }
  },
  async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelations(relations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result }
    };
  }
);

server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(z.object({
        entityName: z.string().min(1).max(500).describe("The name of the entity to add the observations to"),
        contents: z.array(z.string().min(1).max(5000)).max(100).describe("An array of observation contents to add")
      })).max(100)
    },
    outputSchema: {
      results: z.array(z.object({
        entityName: z.string(),
        addedObservations: z.array(ObservationSchema)
      }))
    }
  },
  async ({ observations }) => {
    const result = await knowledgeGraphManager.addObservations(observations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result }
    };
  }
);

server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: {
      entityNames: z.array(z.string().min(1).max(500)).max(100).describe("An array of entity names to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntities(entityNames);
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" }
    };
  }
);

server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(z.object({
        entityName: z.string().min(1).max(500).describe("The name of the entity containing the observations"),
        observations: z.array(z.string().min(1).max(5000)).max(100).describe("An array of observations to delete")
      })).max(100)
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ deletions }) => {
    await knowledgeGraphManager.deleteObservations(deletions);
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" }
    };
  }
);

server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: {
      relations: z.array(RelationSchema).max(100).describe("An array of relations to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ relations }) => {
    await knowledgeGraphManager.deleteRelations(relations);
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" }
    };
  }
);

server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: {},
    outputSchema: {
      entities: z.array(EntityOutputSchema),
      relations: z.array(RelationSchema)
    }
  },
  async () => {
    const graph = await knowledgeGraphManager.readGraph();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: {
      query: z.string().min(1).describe("The search query to match against entity names, types, and observation content")
    },
    outputSchema: {
      entities: z.array(EntityOutputSchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ query }) => {
    const graph = await knowledgeGraphManager.searchNodes(query);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string().min(1).max(500)).max(100).describe("An array of entity names to retrieve")
    },
    outputSchema: {
      entities: z.array(EntityOutputSchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ names }) => {
    const graph = await knowledgeGraphManager.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

async function main() {
  // Resolve the memory file path (env var → migration fallback → default),
  // then initialize the knowledge graph manager
  const memoryFilePath = await ensureMemoryFilePath();
  knowledgeGraphManager = new KnowledgeGraphManager(memoryFilePath);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
