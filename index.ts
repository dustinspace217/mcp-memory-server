#!/usr/bin/env node

// index.ts -- MCP server entry point. Registers tools, wires store, starts transport.
// All data types live in types.ts; store implementations in jsonl-store.ts / sqlite-store.ts.
// Store selection (StoreConfig, ensureMemoryFilePath) lives here because it's an
// entry-point concern -- deciding which backend to instantiate based on file extension.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from 'path';
import { fileURLToPath } from 'url';
import type { GraphStore } from './types.js';
import { JsonlStore, migrateJsonToJsonl } from './jsonl-store.js';
import { SqliteStore } from './sqlite-store.js';

// --- Store configuration ---
// Determines which backend to use and where to store data.

/** Configuration returned by ensureMemoryFilePath() -- determines which store to use. */
export type StoreConfig = { path: string; storeType: 'jsonl' | 'sqlite' };

// Default memory file path, used when MEMORY_FILE_PATH env var is not set.
// Points to memory.db alongside the compiled script in dist/.
export const defaultMemoryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'memory.db'
);

/**
 * Resolves the memory storage configuration from the MEMORY_FILE_PATH env var.
 * Determines the store type from the file extension and handles legacy migrations.
 *
 * Selection logic:
 * - .jsonl extension -> JSONL store (with .json->.jsonl migration)
 * - .db or .sqlite extension -> SQLite store
 * - Other extension -> throws with helpful message
 * - No env var -> defaults to memory.db (SQLite)
 *
 * @returns StoreConfig with the resolved path and store type
 * @throws Error if MEMORY_FILE_PATH has an unrecognized extension
 */
export async function ensureMemoryFilePath(): Promise<StoreConfig> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  if (process.env.MEMORY_FILE_PATH) {
    const envPath = path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(scriptDir, process.env.MEMORY_FILE_PATH);

    if (envPath.endsWith('.jsonl')) {
      // Handle legacy .json -> .jsonl migration for JSONL users
      await migrateJsonToJsonl(scriptDir, envPath);
      return { path: envPath, storeType: 'jsonl' };
    }
    if (envPath.endsWith('.db') || envPath.endsWith('.sqlite')) {
      return { path: envPath, storeType: 'sqlite' };
    }
    throw new Error(
      `Unsupported file extension for MEMORY_FILE_PATH: "${process.env.MEMORY_FILE_PATH}". ` +
      `Use .jsonl for JSONL storage or .db/.sqlite for SQLite storage.`
    );
  }

  // No env var -- default to SQLite
  return { path: defaultMemoryPath, storeType: 'sqlite' };
}

// Re-export types that tests and external consumers may need
export { type Observation, type Entity, type Relation, type KnowledgeGraph, type CreateEntitiesResult, type SkippedEntity, type PaginationParams, type PaginatedKnowledgeGraph, InvalidCursorError } from './types.js';
export { JsonlStore, normalizeObservation } from './jsonl-store.js';
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
  project: z.string().nullable().describe("Project this entity belongs to, or null for global"),
  updatedAt: z.string().describe("ISO 8601 UTC timestamp of last update, or sentinel for legacy data"),
  createdAt: z.string().describe("ISO 8601 UTC timestamp of creation, or sentinel for legacy data"),
});

const RelationSchema = z.object({
  from: z.string().min(1).max(500).describe("The name of the entity where the relation starts"),
  to: z.string().min(1).max(500).describe("The name of the entity where the relation ends"),
  relationType: z.string().min(1).max(500).describe("The type of the relation")
});

// Optional project scope for filtering tools. Omit to operate globally.
// .trim() strips whitespace BEFORE .min(1) checks length, so whitespace-only
// inputs like " " or "\t" are rejected instead of silently becoming global scope.
const ProjectIdSchema = z.string().trim().min(1).max(500)
  .describe("Project scope for filtering. Omit for global/unscoped.")
  .optional();

/**
 * Normalizes a projectId input: trims whitespace, lowercases, and converts
 * empty/undefined to undefined (so the store treats it as global).
 * Called in tool handlers before passing to store methods.
 *
 * @param projectId - Raw projectId string from tool input, may be undefined
 * @returns Cleaned lowercase string, or undefined if input was empty/missing
 */
function normalizeProjectId(projectId?: string): string | undefined {
  if (!projectId) return undefined;
  // trim() removes surrounding whitespace; toLowerCase() ensures
  // "MyProject" and "myproject" map to the same scope;
  // normalize('NFC') collapses Unicode equivalents (e.g., NFD "cafe\u0301"
  // and NFC "caf\u00e9" both become "café") so macOS (NFD) and Linux (NFC)
  // path-derived project names map to the same scope.
  const normalized = projectId.trim().toLowerCase().normalize('NFC');
  return normalized || undefined;
}

// Schema for entities that were skipped during create_entities (name collision)
const SkippedEntitySchema = z.object({
  name: z.string(),
  existingProject: z.string().nullable(),
});

// Pagination output schema — included in read_graph and search_nodes responses.
// Plain object (not z.object()) because registerTool's outputSchema expects { [key]: ZodType }.
const PaginatedOutputSchema = {
  entities: z.array(EntityOutputSchema),
  relations: z.array(RelationSchema),
  nextCursor: z.string().nullable().describe("Cursor for the next page, or null if this is the last page"),
  totalCount: z.number().describe("Total number of matching entities across all pages"),
};

const server = new McpServer({
  name: "memory-server",
  version: "0.10.1",
});

server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntityInputSchema).max(100),
      projectId: ProjectIdSchema,
    },
    outputSchema: {
      created: z.array(EntityOutputSchema),
      skipped: z.array(SkippedEntitySchema),
    }
  },
  async ({ entities, projectId }) => {
    // normalizeProjectId lowercases and trims; undefined = global scope
    const result = await store.createEntities(entities, normalizeProjectId(projectId));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { created: result.created, skipped: result.skipped }
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
    description: "Read the knowledge graph. Returns entities sorted by most recently updated, paginated. Use the returned nextCursor to fetch subsequent pages. Omit cursor for the first page.",
    inputSchema: {
      projectId: ProjectIdSchema,
      cursor: z.string().max(10000).optional().describe("Opaque cursor from a previous response for fetching the next page. Omit for first page."),
      limit: z.number().int().min(1).max(100).optional().default(40).describe("Max entities per page (default 40, max 100)"),
    },
    outputSchema: PaginatedOutputSchema,
  },
  async ({ projectId, cursor, limit }) => {
    // limit is always a number (Zod default 40), so pagination is always active via MCP.
    // The store's "return all" path only triggers for direct programmatic callers.
    const result = await store.readGraph(normalizeProjectId(projectId), { cursor, limit });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { ...result }
    };
  }
);

server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph. Returns matching entities sorted by most recently updated, paginated. Use the returned nextCursor to fetch subsequent pages. Omit cursor for the first page.",
    inputSchema: {
      query: z.string().min(1).max(5000).describe("The search query to match against entity names, types, and observation content"),
      projectId: ProjectIdSchema,
      cursor: z.string().max(10000).optional().describe("Opaque cursor from a previous response for fetching the next page. Omit for first page."),
      limit: z.number().int().min(1).max(100).optional().default(40).describe("Max entities per page (default 40, max 100)"),
    },
    outputSchema: PaginatedOutputSchema,
  },
  async ({ query, projectId, cursor, limit }) => {
    const result = await store.searchNodes(query, normalizeProjectId(projectId), { cursor, limit });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { ...result }
    };
  }
);

server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string().min(1).max(500)).max(100).describe("An array of entity names to retrieve"),
      projectId: ProjectIdSchema,
    },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationSchema) }
  },
  async ({ names, projectId }) => {
    const graph = await store.openNodes(names, normalizeProjectId(projectId));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List all project names in the knowledge graph",
    inputSchema: {},
    outputSchema: { projects: z.array(z.string()) }
  },
  async () => {
    // Returns all distinct non-null project names from the store
    const projects = await store.listProjects();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(projects, null, 2) }],
      structuredContent: { projects }
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
// Wrapped in try/catch so process.exit() always runs even if close() throws
// (e.g., double-close, database corruption, or mid-transaction signal).
process.on('SIGINT', async () => {
  try {
    if (store) await store.close();
  } catch (err) {
    console.error('Error closing store during SIGINT shutdown:', err);
  }
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try {
    if (store) await store.close();
  } catch (err) {
    console.error('Error closing store during SIGTERM shutdown:', err);
  }
  process.exit(0);
});
