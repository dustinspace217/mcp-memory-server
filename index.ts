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
import { normalizeEntityName } from './normalize-name.js';

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
export { type Observation, type Entity, type Relation, type RelationInput, type KnowledgeGraph, type CreateEntitiesResult, type SkippedEntity, type PaginationParams, type PaginatedKnowledgeGraph, InvalidCursorError } from './types.js';
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
  importance: z.number().describe("Importance score 1.0-5.0 (3.0 = medium)"),
  contextLayer: z.enum(['L0', 'L1']).nullable().describe("Context layer: 'L0' = always loaded, 'L1' = session start, null = L2 (on-demand)"),
  memoryType: z.string().nullable().describe("Memory type tag (e.g., 'decision', 'preference', 'fact'). null = unclassified"),
});

/**
 * Reusable Zod schema for entity name fields supplied to MUTATION tools
 * (create_entities, create_relations, add_observations, supersede_observations).
 *
 * Beyond the basic .min(1)/.max(500) length check, this enforces that the name
 * normalizes to a non-empty identity key. Without this refinement, names like
 * '---' or '. . .' would pass Zod validation but throw inside the store layer
 * when it computes `normalized_name` — producing an opaque
 * "Entity name has no content after normalization" error from the bottom of
 * the call stack instead of a clean validation error at the tool boundary.
 *
 * Idempotent delete tools and read tools deliberately do NOT use this schema —
 * the store layer treats unnormalizable names as "no such entity" and silently
 * skips them, preserving the idempotent delete contract.
 */
const EntityNameInputSchema = z.string().min(1).max(500).refine(
  // refine() runs the predicate after .min/.max pass; returning false makes
  // the field fail validation with the message below.
  (name) => {
    try {
      normalizeEntityName(name);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: "Entity name must contain at least one non-separator character. Names that consist only of whitespace, hyphens, underscores, dots, slashes, backslashes, or colons (e.g. '---', '. . .') are rejected because they collapse to an empty identity key.",
  }
);

const EntityInputSchema = z.object({
  name: EntityNameInputSchema.describe("The name of the entity"),
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

// Input schema for creating/deleting relations — just the 3 identifying fields.
// Base relation field schema — no .refine() validation. Used for:
//   1. Output schemas (stored data may include historical names that predate validation)
//   2. Idempotent delete operations (unnormalizable names → "no such relation" → skip)
const RelationBaseSchema = z.object({
  from: z.string().min(1).max(500).describe("The name of the entity where the relation starts"),
  to: z.string().min(1).max(500).describe("The name of the entity where the relation ends"),
  relationType: z.string().min(1).max(500).describe("The type of the relation")
});

// Write-path input schema — from / to use EntityNameInputSchema so the boundary
// rejects names that would collapse to an empty identity key inside the store.
// Only used by create_relations (and anywhere else that creates new relations).
const RelationInputSchema = z.object({
  from: EntityNameInputSchema.describe("The name of the entity where the relation starts"),
  to: EntityNameInputSchema.describe("The name of the entity where the relation ends"),
  relationType: z.string().min(1).max(500).describe("The type of the relation")
});

// Output schema for relations returned by queries — includes system-managed temporal fields.
// createdAt: ISO 8601 UTC when the relation was established (sentinel for legacy data).
// supersededAt: '' = active, ISO timestamp = invalidated.
// Built on RelationBaseSchema (no .refine()) so historical data passes output validation (#57).
const RelationOutputSchema = RelationBaseSchema.extend({
  createdAt: z.string().describe("ISO 8601 UTC timestamp when relation was created, or sentinel for legacy data"),
  supersededAt: z.string().describe("'' = active, ISO timestamp = invalidated"),
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
export function normalizeProjectId(projectId?: string): string | undefined {
  if (!projectId) return undefined;
  // trim() removes surrounding whitespace; toLowerCase() ensures
  // "MyProject" and "myproject" map to the same scope;
  // normalize('NFC') collapses Unicode equivalents (e.g., NFD "cafe\u0301"
  // and NFC "caf\u00e9" both become "café") so macOS (NFD) and Linux (NFC)
  // path-derived project names map to the same scope.
  const normalized = projectId.trim().toLowerCase().normalize('NFC');
  return normalized || undefined;
}

// Schema for entities that were skipped during create_entities (name collision).
// existingName reports which display form the input collided with — important when
// the input was a surface variant (e.g. 'Dustin-Space' → collides with 'dustin-space').
// Without this, Zod strips the field from the MCP output (issue #58).
const SkippedEntitySchema = z.object({
  name: z.string(),
  existingProject: z.string().nullable(),
  existingName: z.string().optional(),
});

// Pagination output schema — included in read_graph and search_nodes responses.
// Plain object (not z.object()) because registerTool's outputSchema expects { [key]: ZodType }.
const PaginatedOutputSchema = {
  entities: z.array(EntityOutputSchema),
  relations: z.array(RelationOutputSchema),
  nextCursor: z.string().nullable().describe("Cursor for the next page, or null if this is the last page"),
  totalCount: z.number().describe("Total number of matching entities across all pages"),
};

const server = new McpServer({
  name: "memory-server",
  version: "1.0.0",
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

    // Build a human-readable summary before the JSON payload (#31).
    // When all entities are skipped (name collisions), the caller needs
    // a clear signal — raw JSON with created:[] is easy to miss.
    let summary: string;
    if (result.created.length === 0 && result.skipped.length > 0) {
      summary = `All ${result.skipped.length} entities already exist (skipped). No new entities were created.\n\n`;
    } else if (result.skipped.length > 0) {
      summary = `Created ${result.created.length} entities. Skipped ${result.skipped.length} (already exist).\n\n`;
    } else {
      summary = `Created ${result.created.length} entities.\n\n`;
    }

    return {
      content: [{ type: "text" as const, text: summary + JSON.stringify(result, null, 2) }],
      structuredContent: { created: result.created, skipped: result.skipped }
    };
  }
);

server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: { relations: z.array(RelationInputSchema).max(100) },
    outputSchema: { relations: z.array(RelationOutputSchema) }
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
        // EntityNameInputSchema rejects names that would collapse to empty (e.g. '---')
        // at the boundary, so the store layer never sees them.
        entityName: EntityNameInputSchema.describe("The name of the entity to add the observations to"),
        contents: z.array(z.string().min(1).max(5000)).max(100).describe("An array of observation contents to add"),
        importances: z.array(z.number().min(1).max(5)).max(100).optional()
          .describe("Parallel array of importance scores (1.0-5.0) matching contents. Omit for default 3.0."),
        contextLayers: z.array(z.enum(['L0', 'L1']).nullable()).max(100).optional()
          .describe("Parallel array of context layers matching contents. 'L0' = always loaded, 'L1' = session start, null = on-demand (L2). Omit for default null."),
        memoryTypes: z.array(z.string().max(50).nullable()).max(100).optional()
          .describe("Parallel array of memory type tags matching contents. Recommended: 'decision','preference','fact','problem','milestone','emotional'. null = unclassified. Omit for default null."),
      })).max(100)
    },
    outputSchema: {
      results: z.array(z.object({
        entityName: z.string(),
        addedObservations: z.array(ObservationSchema),
        similarExisting: z.array(z.object({
          content: z.string(),
          similarity: z.number(),
        })).optional().describe("Semantically similar existing observations (cosine > 0.85). Present when embedding model is ready."),
      }))
    }
  },
  async ({ observations }) => {
    const result = await store.addObservations(observations);
    // Alert callers when similar observations were detected
    let responseText = JSON.stringify(result, null, 2);
    const hasSimilar = result.some(r => r.similarExisting && r.similarExisting.length > 0);
    if (hasSimilar) {
      responseText = 'Note: Some observations are semantically similar to existing ones. Check similarExisting fields.\n\n' + responseText;
    }
    return {
      content: [{ type: "text" as const, text: responseText }],
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
    // Uses RelationBaseSchema (no .refine()) — delete is idempotent, so unnormalizable
    // names are treated as "no such relation" and silently skipped (#57).
    inputSchema: { relations: z.array(RelationBaseSchema).max(100).describe("An array of relations to delete") },
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
  "supersede_observations",
  {
    title: "Supersede Observations",
    description: "Atomically replace observations on entities. Retires the old observation and inserts the new one in a single transaction. Use this instead of delete+add when an observation's content has changed (e.g., updated status, count, or signature).",
    inputSchema: {
      supersessions: z.array(z.object({
        // EntityNameInputSchema rejects names that would collapse to empty (e.g. '---')
        // at the boundary, so the store layer never sees them.
        entityName: EntityNameInputSchema.describe("The entity whose observation to supersede"),
        oldContent: z.string().min(1).max(5000).describe("The exact text of the active observation to retire"),
        newContent: z.string().min(1).max(5000).describe("The replacement observation text"),
      })).max(100),
    },
    outputSchema: { success: z.boolean(), message: z.string() }
  },
  async ({ supersessions }) => {
    await store.supersedeObservations(supersessions);
    return {
      content: [{ type: "text" as const, text: "Observations superseded successfully" }],
      structuredContent: { success: true, message: "Observations superseded successfully" }
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
      asOf: z.string().datetime({ offset: false }).optional().describe("ISO 8601 UTC timestamp (Z suffix only — no offsets). Returns graph state as it was at this moment. Omit for current state. When paginating, you MUST re-pass the same asOf on every page request — the cursor fingerprint encodes the temporal context, and a mismatched (or missing) asOf on a follow-up page will be rejected with InvalidCursorError."),
    },
    outputSchema: PaginatedOutputSchema,
  },
  async ({ projectId, cursor, limit, asOf }) => {
    // limit is always a number (Zod default 40), so pagination is always active via MCP.
    // The store's "return all" path only triggers for direct programmatic callers.
    const result = await store.readGraph(normalizeProjectId(projectId), { cursor, limit }, asOf);
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
      asOf: z.string().datetime({ offset: false }).optional().describe("ISO 8601 UTC timestamp (Z suffix only — no offsets). Returns graph state as it was at this moment. Omit for current state. When paginating, you MUST re-pass the same asOf on every page request — the cursor fingerprint encodes the temporal context, and a mismatched (or missing) asOf on a follow-up page will be rejected with InvalidCursorError."),
    },
    outputSchema: PaginatedOutputSchema,
  },
  async ({ query, projectId, cursor, limit, asOf }) => {
    const result = await store.searchNodes(query, normalizeProjectId(projectId), { cursor, limit }, asOf);
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
      asOf: z.string().datetime({ offset: false }).optional().describe("ISO 8601 UTC timestamp (Z suffix only — no offsets). Returns entity state as it was at this moment. Omit for current state."),
    },
    outputSchema: { entities: z.array(EntityOutputSchema), relations: z.array(RelationOutputSchema) }
  },
  async ({ names, projectId, asOf }) => {
    const graph = await store.openNodes(names, normalizeProjectId(projectId), asOf);
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

server.registerTool(
  "invalidate_relations",
  {
    title: "Invalidate Relations",
    description: "Mark relations as no longer active by setting their superseded_at timestamp. " +
      "The relations are preserved for history but hidden from active queries (readGraph, searchNodes, openNodes). " +
      "Idempotent — already-invalidated relations are silently skipped. " +
      "Use this instead of delete_relations when you want to preserve the relation's history.",
    inputSchema: {
      relations: z.array(z.object({
        from: z.string().min(1).max(500).describe("Source entity name"),
        to: z.string().min(1).max(500).describe("Target entity name"),
        relationType: z.string().min(1).max(500).describe("The type of the relation"),
      })).min(1).max(100).describe("Relations to invalidate"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      invalidated: z.number().describe("Number of relations actually invalidated"),
      requested: z.number().describe("Number of relations in the input"),
    }
  },
  async ({ relations }) => {
    const changed = await store.invalidateRelations(relations);
    // Report actual changes vs requested — already-invalidated relations are skipped
    const message = changed === relations.length
      ? `Invalidated ${changed} relation(s).`
      : `Invalidated ${changed} of ${relations.length} relation(s) (${relations.length - changed} already inactive).`;
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { success: true, message, invalidated: changed, requested: relations.length }
    };
  }
);

server.registerTool(
  "entity_timeline",
  {
    title: "Entity Timeline",
    description: "Returns full history of an entity including superseded observations and invalidated relations. " +
      "Unlike readGraph/searchNodes which only show active items, this shows the complete change history " +
      "with status indicators ('active' or 'superseded') on each observation and relation.",
    inputSchema: {
      entityName: z.string().min(1).max(500).describe("Name of the entity to get timeline for"),
      projectId: ProjectIdSchema,
    },
    outputSchema: {
      name: z.string(),
      entityType: z.string(),
      project: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      observations: z.array(z.object({
        content: z.string(),
        createdAt: z.string(),
        supersededAt: z.string(),
        status: z.enum(['active', 'superseded']),
      })),
      relations: z.array(z.object({
        from: z.string(),
        to: z.string(),
        relationType: z.string(),
        createdAt: z.string(),
        supersededAt: z.string(),
        status: z.enum(['active', 'superseded']),
      })),
    }
  },
  async ({ entityName, projectId }) => {
    const result = await store.entityTimeline(entityName, normalizeProjectId(projectId));
    if (!result) {
      return {
        content: [{ type: "text" as const, text: `Entity "${entityName}" not found.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }
);

server.registerTool(
  "set_observation_metadata",
  {
    title: "Set Observation Metadata",
    description: "Updates importance, context layer, and/or memory type on existing observations " +
      "without superseding them. Preserves the observation's identity, timestamps, and embeddings. " +
      "Use this to promote observations to L0/L1, adjust importance, or tag memory type. " +
      "Observations are identified by (entityName, content) exact match.",
    inputSchema: {
      updates: z.array(z.object({
        // EntityNameInputSchema (with .refine()) — write-path validation rejects names
        // that normalize to empty. The entity must exist; throwing on not-found is correct.
        entityName: EntityNameInputSchema.describe("The entity owning the observation"),
        content: z.string().min(1).max(5000).describe("Exact content of the observation to update"),
        importance: z.number().min(1).max(5).optional()
          .describe("Importance score 1.0-5.0. Only updated if provided."),
        contextLayer: z.enum(['L0', 'L1']).nullable().optional()
          .describe("'L0' = always loaded, 'L1' = session start, null = demote to on-demand (L2). Only updated if key present."),
        memoryType: z.string().max(50).nullable().optional()
          .describe("Memory type tag (e.g. 'decision','preference','fact','problem','procedure'). null = unclassified. Only updated if key present."),
      })).min(1).max(100).describe("Observations to update"),
    },
    outputSchema: {
      updated: z.number().describe("Number of observations actually updated"),
    }
  },
  async ({ updates }) => {
    const count = await store.setObservationMetadata(updates);
    const message = count === updates.length
      ? `Updated metadata on ${count} observation(s).`
      : `Updated ${count} of ${updates.length} observation(s) (${updates.length - count} not found).`;
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { updated: count },
    };
  }
);

server.registerTool(
  "get_context_layers",
  {
    title: "Get Context Layers",
    description: "Returns L0 and L1 observations — the 'push' layers that should be restored at session " +
      "start or after compaction. L0 (~100 token budget) holds core identity and rules that rarely change. " +
      "L1 (~800 token budget) holds active project context loaded at session start. Observations are " +
      "sorted by importance (highest first) and truncated at the token budget. Call this from SessionStart " +
      "and PostCompact hooks to automatically restore critical context.",
    inputSchema: {
      projectId: ProjectIdSchema,
      layers: z.array(z.enum(['L0', 'L1'])).optional()
        .describe("Which layers to return. Defaults to ['L0', 'L1']. Pass ['L0'] for identity-only."),
    },
    outputSchema: {
      L0: z.array(z.object({
        entityName: z.string(),
        content: z.string(),
        importance: z.number(),
        memoryType: z.string().nullable(),
      })).describe("Core identity and rules (always loaded)"),
      L1: z.array(z.object({
        entityName: z.string(),
        content: z.string(),
        importance: z.number(),
        memoryType: z.string().nullable(),
        updatedAt: z.string().optional(),
      })).describe("Session-start context (active work and decisions)"),
      tokenEstimate: z.number().describe("Approximate token count (chars / 4)"),
    }
  },
  async ({ projectId, layers }) => {
    const normalizedProject = normalizeProjectId(projectId);
    const result = await store.getContextLayers(normalizedProject, layers);

    // Build a human-readable summary for the text content.
    const l0Count = result.L0.length;
    const l1Count = result.L1.length;
    const parts = [];
    if (l0Count > 0) parts.push(`${l0Count} L0 observation(s)`);
    if (l1Count > 0) parts.push(`${l1Count} L1 observation(s)`);
    const summary = parts.length > 0
      ? `Context layers: ${parts.join(', ')} (~${result.tokenEstimate} tokens)`
      : 'No L0 or L1 observations found.';

    return {
      content: [{ type: "text" as const, text: summary }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }
);

server.registerTool(
  "get_summary",
  {
    title: "Get Summary",
    description: "Returns a concise knowledge graph snapshot for session-start briefings: " +
      "top observations ranked by importance (then recency), recently updated entities with " +
      "observation counts, and aggregate stats (totals for entities, observations, relations, projects). " +
      "Use excludeContextLayers to avoid double-counting observations already loaded by get_context_layers.",
    inputSchema: {
      projectId: ProjectIdSchema,
      excludeContextLayers: z.boolean().optional()
        .describe("When true, excludes L0/L1 observations from topObservations (to deduplicate with get_context_layers). Default false."),
      limit: z.number().int().min(1).max(100).optional()
        .describe("Max number of top observations to return. Default 20."),
    },
    outputSchema: {
      topObservations: z.array(z.object({
        entityName: z.string(),
        content: z.string(),
        importance: z.number(),
        memoryType: z.string().nullable(),
        updatedAt: z.string(),
      })).describe("Highest-importance observations, sorted by importance DESC then recency DESC"),
      recentEntities: z.array(z.object({
        name: z.string(),
        entityType: z.string(),
        observationCount: z.number(),
        updatedAt: z.string(),
      })).describe("5 most recently updated entities with their observation counts"),
      stats: z.object({
        totalEntities: z.number(),
        totalObservations: z.number(),
        totalRelations: z.number(),
        projectCount: z.number(),
      }).describe("Aggregate counts across the knowledge graph"),
    }
  },
  async ({ projectId, excludeContextLayers, limit }) => {
    const normalizedProject = normalizeProjectId(projectId);
    const result = await store.getSummary(normalizedProject, excludeContextLayers, limit);

    // Build a human-readable summary for the text content.
    const obsCount = result.topObservations.length;
    const entCount = result.recentEntities.length;
    const { totalEntities, totalObservations, totalRelations, projectCount } = result.stats;
    const text = `Summary: ${obsCount} top observation(s), ${entCount} recent entit${entCount === 1 ? 'y' : 'ies'}. ` +
      `Graph totals: ${totalEntities} entities, ${totalObservations} observations, ` +
      `${totalRelations} relations across ${projectCount} project(s).`;

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: result as unknown as Record<string, unknown>,
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

// Graceful shutdown: signal the embedding sweep to stop, then close the database
// to release SQLite file locks and flush WAL. Without this, -wal and -shm sidecar
// files may linger on disk after unclean exit. Wrapped in try/catch so
// process.exit() always runs even if close() throws.
process.on('SIGINT', async () => {
  try {
    if (store) {
      store.shutdown();
      await store.close();
    }
  } catch (err) {
    console.error('Error closing store during SIGINT shutdown:', err);
  }
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try {
    if (store) {
      store.shutdown();
      await store.close();
    }
  } catch (err) {
    console.error('Error closing store during SIGTERM shutdown:', err);
  }
  process.exit(0);
});
