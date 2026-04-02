#!/usr/bin/env node

// index.ts -- MCP server entry point. Registers tools, wires store, starts transport.
// All data types live in types.ts; store implementations in jsonl-store.ts / sqlite-store.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { GraphStore } from './types.js';
import { ensureMemoryFilePath, JsonlStore } from './jsonl-store.js';
import { SqliteStore } from './sqlite-store.js';

// Re-export types that tests and external consumers may need
export { type Observation, type Entity, type Relation, type KnowledgeGraph } from './types.js';
export { JsonlStore, ensureMemoryFilePath, defaultMemoryPath, normalizeObservation } from './jsonl-store.js';
export { type StoreConfig } from './jsonl-store.js';
export { SqliteStore } from './sqlite-store.js';

// Module-level store reference -- initialized in main(), used by all tool handlers
let store: GraphStore;

// --- Zod schemas for MCP tool input/output validation ---
// Input schemas accept plain strings for observations (server adds timestamps).
// Output schemas return full Observation objects with timestamps.
// String fields have .min(1) to prevent empty values and .max() to bound sizes.

const ObservationSchema = z.object({
  content: z.string().min(1).describe("The content of the observation"),
  createdAt: z.string().describe("ISO 8601 UTC timestamp, or 'unknown' for migrated data"),
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

const server = new McpServer({
  name: "memory-server",
  version: "0.8.0",
});

server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: { entities: z.array(EntityInputSchema).max(100) },
    outputSchema: { entities: z.array(EntityOutputSchema) }
  },
  async ({ entities }) => {
    const result = await store.createEntities(entities);
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
    inputSchema: { relations: z.array(RelationSchema).max(100) },
    outputSchema: { relations: z.array(RelationSchema) }
  },
  async ({ relations }) => {
    const result = await store.createRelations(relations);
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
    const result = await store.addObservations(observations);
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
    inputSchema: { entityNames: z.array(z.string().min(1).max(500)).max(100).describe("An array of entity names to delete") },
    outputSchema: { success: z.boolean(), message: z.string() }
  },
  async ({ entityNames }) => {
    await store.deleteEntities(entityNames);
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
        contents: z.array(z.string().min(1).max(5000)).max(100).describe("An array of observation content strings to delete")
      })).max(100)
    },
    outputSchema: { success: z.boolean(), message: z.string() }
  },
  async ({ deletions }) => {
    await store.deleteObservations(deletions);
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
    inputSchema: { relations: z.array(RelationSchema).max(100).describe("An array of relations to delete") },
    outputSchema: { success: z.boolean(), message: z.string() }
  },
  async ({ relations }) => {
    await store.deleteRelations(relations);
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
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async () => {
    const graph = await store.readGraph();
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
    inputSchema: { query: z.string().min(1).describe("The search query to match against entity names, types, and observation content") },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async ({ query }) => {
    const graph = await store.searchNodes(query);
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
    inputSchema: { names: z.array(z.string().min(1).max(500)).max(100).describe("An array of entity names to retrieve") },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async ({ names }) => {
    const graph = await store.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

/**
 * Entry point. Resolves the storage configuration, instantiates the appropriate store,
 * and starts the MCP server on stdio transport.
 */
async function main() {
  const config = await ensureMemoryFilePath();

  // Instantiate the appropriate store based on file extension
  if (config.storeType === 'sqlite') {
    store = new SqliteStore(config.path);
  } else {
    store = new JsonlStore(config.path);
  }
  await store.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

// Graceful shutdown: close the store to release SQLite file locks and flush WAL.
// Without this, -wal and -shm sidecar files may linger on disk after unclean exit.
process.on('SIGINT', async () => {
  if (store) await store.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (store) await store.close();
  process.exit(0);
});
