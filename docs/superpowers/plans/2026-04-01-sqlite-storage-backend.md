# Phase 2: SQLite Storage Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSONL flat-file storage with SQLite as the default backend while keeping JSONL as a fallback, enforcing dedup and FK constraints at the database level.

**Architecture:** Split the monolithic `index.ts` (~714 lines) into four files: `types.ts` (interfaces + GraphStore contract), `jsonl-store.ts` (renamed KnowledgeGraphManager), `sqlite-store.ts` (new SQLite backend with auto-migration), and a slimmed `index.ts` (MCP server + store wiring). Both stores implement the `GraphStore` interface. Store selection is by file extension (`.jsonl` vs `.db`/`.sqlite`).

**Tech Stack:** TypeScript, Node.js 22, `better-sqlite3` (synchronous SQLite bindings), `@modelcontextprotocol/sdk`, Zod, Vitest

**Design Spec:** `docs/superpowers/specs/2026-04-01-sqlite-storage-backend-design.md`

---

### Task 1: Install Dependencies and Update Build Config

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Install better-sqlite3 and its type definitions**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

- [ ] **Step 2: Update tsconfig.json to include new source files**

Change the `include` array from `["index.ts"]` to include all four source files:

```json
{
  "include": [
    "index.ts",
    "types.ts",
    "jsonl-store.ts",
    "sqlite-store.ts"
  ]
}
```

- [ ] **Step 3: Verify build still works**

```bash
npm run build
```

Expected: compiles with no errors (new files don't exist yet, but the include array is forward-looking -- tsc ignores missing entries).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "Add better-sqlite3 dependency and update tsconfig includes"
```

---

### Task 2: Create `types.ts`

Extract all shared interfaces, named input/output types, the `GraphStore` interface, and the `createObservation` helper into `types.ts`.

**Files:**
- Create: `types.ts`

- [ ] **Step 1: Create types.ts with all shared types**

```typescript
// types.ts -- Shared interfaces and types for the knowledge graph.
// Both JsonlStore and SqliteStore depend on these types.

/**
 * A single piece of knowledge attached to an entity.
 * Each observation carries a creation timestamp for staleness detection.
 * createdAt is ISO 8601 UTC, or 'unknown' for data migrated from the old string format.
 */
export interface Observation {
  content: string;
  createdAt: string;
}

/** A named node in the knowledge graph with a type and attached observations. */
export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
}

/** A directed edge between two entities with a relation type. */
export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

/** The complete knowledge graph: all entities and all relations. */
export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// --- Named input/output types for GraphStore methods ---

/** Input type for createEntities. Observations can be plain strings (auto-timestamped)
 *  or Observation objects (passed through for migration/test scenarios). */
export type EntityInput = {
  name: string;
  entityType: string;
  observations: (string | Observation)[];
};

/** Input type for addObservations. Each entry targets an entity by name. */
export type AddObservationInput = {
  entityName: string;
  contents: string[];
};

/** Input type for deleteObservations. Field is 'contents' (not 'observations')
 *  to be consistent with AddObservationInput. */
export type DeleteObservationInput = {
  entityName: string;
  contents: string[];
};

/** Return type for addObservations. Reports which observations were actually added
 *  (excludes duplicates). */
export type AddObservationResult = {
  entityName: string;
  addedObservations: Observation[];
};

/**
 * The GraphStore interface -- the contract both JsonlStore and SqliteStore implement.
 * Methods mirror the MCP tool operations. Return types use Readonly to prevent
 * accidental mutation of returned data.
 */
export interface GraphStore {
  /** One-time setup: create tables, run migrations, etc. No-op for JSONL. */
  init(): Promise<void>;

  /** Cleanup: close DB connection. No-op for JSONL. */
  close(): Promise<void>;

  createEntities(entities: EntityInput[]): Promise<Readonly<Entity[]>>;
  createRelations(relations: Relation[]): Promise<Readonly<Relation[]>>;
  addObservations(observations: AddObservationInput[]): Promise<Readonly<AddObservationResult[]>>;
  deleteEntities(entityNames: string[]): Promise<void>;
  deleteObservations(deletions: DeleteObservationInput[]): Promise<void>;
  deleteRelations(relations: Relation[]): Promise<void>;
  readGraph(): Promise<Readonly<KnowledgeGraph>>;
  searchNodes(query: string): Promise<Readonly<KnowledgeGraph>>;
  openNodes(names: string[]): Promise<Readonly<KnowledgeGraph>>;
}

/**
 * Creates a new Observation with the current UTC timestamp.
 * Called when observations are added through the API (not during migration).
 *
 * @param content - The observation content string
 * @returns An Observation object with content and an ISO 8601 createdAt timestamp
 */
export function createObservation(content: string): Observation {
  return { content, createdAt: new Date().toISOString() };
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: compiles cleanly. `types.ts` is standalone with no imports.

- [ ] **Step 3: Commit**

```bash
git add types.ts
git commit -m "Extract shared types, GraphStore interface, and createObservation into types.ts"
```

---

### Task 3: Create `jsonl-store.ts`

Extract `KnowledgeGraphManager` (renamed to `JsonlStore`), `normalizeObservation`, and `ensureMemoryFilePath` from `index.ts` into `jsonl-store.ts`. The class now implements `GraphStore` with no-op `init()`/`close()`.

**Files:**
- Create: `jsonl-store.ts`

- [ ] **Step 1: Create jsonl-store.ts**

Move these from `index.ts`:
- `defaultMemoryPath` constant (line 11)
- `ensureMemoryFilePath()` function (lines 26-56)
- `normalizeObservation()` function (lines 96-109)
- `KnowledgeGraphManager` class (lines 118-458) -- renamed to `JsonlStore`

Import types from `types.ts` instead of defining them inline. Replace inline `createObservation()` calls with the import from `types.ts`.

The key changes from the original class:
- Class name: `KnowledgeGraphManager` -> `JsonlStore`
- Implements: `GraphStore` interface
- New methods: `init()` and `close()` (both no-ops)
- `deleteObservations` parameter uses `DeleteObservationInput` (field `contents` instead of `observations`)
- `createEntities` parameter uses `EntityInput` type
- `addObservations` parameter and return use `AddObservationInput` / `AddObservationResult`

```typescript
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
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: compiles cleanly. `jsonl-store.ts` imports from `types.ts`, no circular dependencies.

- [ ] **Step 3: Commit**

```bash
git add jsonl-store.ts
git commit -m "Extract JsonlStore, normalizeObservation, and ensureMemoryFilePath into jsonl-store.ts"
```

---

### Task 4: Slim `index.ts` and Update Tests

Replace inline types and the `KnowledgeGraphManager` class in `index.ts` with imports from the new modules. Update both test files to import from the new locations. Rename `deleteObservations` field from `observations` to `contents` in the Zod schema.

**Files:**
- Modify: `index.ts`
- Modify: `__tests__/knowledge-graph.test.ts`
- Modify: `__tests__/file-path.test.ts`

- [ ] **Step 1: Rewrite index.ts**

Replace the entire contents of `index.ts`. The new version imports types from `types.ts` and the store from `jsonl-store.ts`. It only contains the MCP server setup, Zod schemas, tool registrations, and `main()`.

Key changes:
- All types imported from `types.ts` and `jsonl-store.ts` instead of defined inline
- Module-level variable renamed from `knowledgeGraphManager` to `store` (typed as `GraphStore`)
- Version bumped to `0.8.0` in McpServer constructor
- `delete_observations` Zod schema field renamed from `observations` to `contents`
- Re-exports types from both modules for backward compatibility
- `main()` still uses `JsonlStore` only (SqliteStore wired in Task 10)

```typescript
#!/usr/bin/env node

// index.ts -- MCP server entry point. Registers tools, wires store, starts transport.
// All data types live in types.ts; store implementations in jsonl-store.ts / sqlite-store.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { GraphStore } from './types.js';
import { ensureMemoryFilePath, JsonlStore } from './jsonl-store.js';

// Re-export types that tests and external consumers may need
export { type Observation, type Entity, type Relation, type KnowledgeGraph } from './types.js';
export { JsonlStore, ensureMemoryFilePath, defaultMemoryPath, normalizeObservation } from './jsonl-store.js';

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
 * Entry point. Resolves the storage path, instantiates the appropriate store,
 * and starts the MCP server on stdio transport.
 */
async function main() {
  const memoryFilePath = await ensureMemoryFilePath();
  store = new JsonlStore(memoryFilePath);
  await store.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
```

- [ ] **Step 2: Update knowledge-graph.test.ts imports and field names**

Change the import line at the top of the file:

```typescript
// OLD:
import { KnowledgeGraphManager, Entity, Observation, Relation, KnowledgeGraph } from '../index.js';

// NEW:
import { Entity, Observation, Relation, KnowledgeGraph } from '../types.js';
import { JsonlStore } from '../jsonl-store.js';
```

Then apply these mechanical changes throughout the file:
1. Replace `KnowledgeGraphManager` with `JsonlStore` everywhere (type annotations and constructor calls)
2. In all `deleteObservations` test calls, rename the field `observations` to `contents` (4 call sites):

```typescript
// OLD:
await manager.deleteObservations([
  { entityName: 'Alice', observations: ['likes coffee'] },
]);
// NEW:
await manager.deleteObservations([
  { entityName: 'Alice', contents: ['likes coffee'] },
]);
```

The 4 call sites are in:
- `describe('deleteObservations')`: both tests
- `describe('observation timestamps')`: the "delete by content" test
- `describe('idempotent delete edge cases')`: the "deleting observations that do not exist" test

- [ ] **Step 3: Update file-path.test.ts imports**

```typescript
// OLD:
import { ensureMemoryFilePath, defaultMemoryPath } from '../index.js';

// NEW:
import { ensureMemoryFilePath, defaultMemoryPath } from '../jsonl-store.js';
```

No other changes needed -- `ensureMemoryFilePath` still returns `string` at this point.

- [ ] **Step 4: Verify all tests pass**

```bash
npm test
```

Expected: all 69 tests pass (60 + 9).

- [ ] **Step 5: Verify build**

```bash
npm run build
```

Expected: compiles cleanly.

- [ ] **Step 6: Commit**

```bash
git add index.ts __tests__/knowledge-graph.test.ts __tests__/file-path.test.ts
git commit -m "Slim index.ts to MCP server + store wiring, update test imports

Rename KnowledgeGraphManager to JsonlStore in tests.
Rename deleteObservations field 'observations' to 'contents' for consistency.
Version bumped to 0.8.0 in MCP server."
```

---

### Task 5: Create SqliteStore Skeleton

Create `sqlite-store.ts` with the SQLite schema, `init()`/`close()`, and stub implementations for all CRUD methods that throw "not implemented". This lets us parameterize the test suite in the next task.

**Files:**
- Create: `sqlite-store.ts`

- [ ] **Step 1: Create sqlite-store.ts with schema and stubs**

```typescript
// sqlite-store.ts -- SQLite storage backend for the knowledge graph.
// Uses better-sqlite3 for synchronous, high-performance database access.
// Methods are async (returning resolved promises) to match the GraphStore interface.

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
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

/**
 * Escapes LIKE special characters so they match as literal substrings.
 * Without this, a query containing '%' or '_' would act as a wildcard.
 *
 * @param query - Raw search string from the user
 * @returns Escaped string safe for use in LIKE '%escaped%' ESCAPE '\'
 */
function escapeLike(query: string): string {
  return query.replace(/[%_\\]/g, '\\$&');
}

/**
 * SQLite-backed knowledge graph store. Uses WAL mode for concurrent read performance
 * and foreign key constraints for referential integrity.
 *
 * Implements GraphStore so it can be swapped with JsonlStore transparently.
 */
export class SqliteStore implements GraphStore {
  // The '!' (definite assignment) tells TypeScript this is set in init() before use.
  // better-sqlite3's Database type -- a synchronous SQLite connection handle.
  private db!: Database.Database;

  /**
   * @param dbPath - Absolute path to the .db file. Created on first init() if missing.
   */
  constructor(private dbPath: string) {}

  /**
   * Opens the SQLite database, sets pragmas, and creates tables if they don't exist.
   * Must be called before any other method.
   *
   * WAL (Write-Ahead Logging) mode allows concurrent readers without blocking writers.
   * foreign_keys must be enabled per-connection (SQLite doesn't persist this setting).
   */
  async init(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create tables. IF NOT EXISTS makes this safe to call on an existing database.
    // entities.name has a UNIQUE constraint so it can be referenced by relations.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(entity_id, content)
      );

      CREATE TABLE IF NOT EXISTS relations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        relation_type TEXT NOT NULL,
        UNIQUE(from_entity, to_entity, relation_type)
      );
    `);
  }

  /** Closes the database connection. Call when done to release the file lock. */
  async close(): Promise<void> {
    this.db.close();
  }

  async createEntities(_entities: EntityInput[]): Promise<Entity[]> {
    throw new Error('SqliteStore.createEntities not implemented');
  }

  async createRelations(_relations: Relation[]): Promise<Relation[]> {
    throw new Error('SqliteStore.createRelations not implemented');
  }

  async addObservations(_observations: AddObservationInput[]): Promise<AddObservationResult[]> {
    throw new Error('SqliteStore.addObservations not implemented');
  }

  async deleteEntities(_entityNames: string[]): Promise<void> {
    throw new Error('SqliteStore.deleteEntities not implemented');
  }

  async deleteObservations(_deletions: DeleteObservationInput[]): Promise<void> {
    throw new Error('SqliteStore.deleteObservations not implemented');
  }

  async deleteRelations(_relations: Relation[]): Promise<void> {
    throw new Error('SqliteStore.deleteRelations not implemented');
  }

  async readGraph(): Promise<KnowledgeGraph> {
    throw new Error('SqliteStore.readGraph not implemented');
  }

  async searchNodes(_query: string): Promise<KnowledgeGraph> {
    throw new Error('SqliteStore.searchNodes not implemented');
  }

  async openNodes(_names: string[]): Promise<KnowledgeGraph> {
    throw new Error('SqliteStore.openNodes not implemented');
  }
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: compiles cleanly.

- [ ] **Step 3: Commit**

```bash
git add sqlite-store.ts
git commit -m "Add SqliteStore skeleton with schema creation and stub methods"
```

---

### Task 6: Parameterize the Test Suite

Refactor `knowledge-graph.test.ts` to run shared behavioral tests against both `JsonlStore` and `SqliteStore` using `describe.each`. Move JSONL-specific tests into a standalone section.

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts`

- [ ] **Step 1: Restructure the test file into three sections**

The file has three sections:

**Section 1: Parameterized shared tests** -- Wrap all behavioral tests inside `describe.each`. These run against both stores. Uses `store` (typed as `GraphStore`) instead of `manager`.

The `describe.each` wrapper and setup:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GraphStore, Relation } from '../types.js';
import { JsonlStore } from '../jsonl-store.js';
import { SqliteStore } from '../sqlite-store.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

// Factory function type -- creates a store given a file path
type StoreFactory = (filePath: string) => GraphStore;

describe.each<[string, string, StoreFactory]>([
  ['JsonlStore', 'jsonl', (p) => new JsonlStore(p)],
  ['SqliteStore', 'db', (p) => new SqliteStore(p)],
])('%s', (_storeName, ext, createStore) => {
  let store: GraphStore;
  let storePath: string;

  beforeEach(async () => {
    storePath = path.join(testDir, `test-memory-${Date.now()}.${ext}`);
    store = createStore(storePath);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    // Clean up all possible data files
    for (const suffix of ['', '.tmp', '-wal', '-shm']) {
      try { await fs.unlink(storePath + suffix); } catch { /* ignore */ }
    }
  });

  // --- All shared tests go here, using `store` instead of `manager` ---
  // Move in: createEntities (3), createRelations (3), addObservations (3),
  //   deleteEntities (3), deleteObservations (2), deleteRelations (1),
  //   readGraph (2), searchNodes (7), openNodes (7),
  //   file persistence: persist across instances (1),
  //   observation timestamps (6 -- see below for which ones),
  //   observation deduplication within createEntities (1),
  //   addObservations dedup within single contents array (1),
  //   within-batch deduplication (2), composite key safety (2),
  //   idempotent delete edge cases (2)

  // For persistence tests that create a second store instance:
  //   await store.close();
  //   const store2 = createStore(storePath);
  //   await store2.init();
  //   const graph = await store2.readGraph();
  //   await store2.close();
  //   store = createStore(storePath);  // re-open for afterEach
  //   await store.init();
});
```

**Which observation timestamp tests are shared vs JSONL-only:**
- SHARED (6 tests): ISO timestamp assignment (createEntities), ISO timestamp (addObservations), preserve across save/load, dedup by content, delete by content, search content
- JSONL-ONLY (2 tests): migrate legacy string observations, mixed legacy + new observations

**Section 2: JSONL-specific tests** in a standalone `describe('JsonlStore-specific', ...)` block. Move in: JSONL format test, strip type field tests (3), legacy observation migration (2), normalizeObservation tests (2+2), malformed JSONL tests (2), atomic write tests (2). Total: ~15 JSONL-only tests.

**Section 3: SqliteStore-specific tests** -- left empty for now, filled in Task 12.

- [ ] **Step 2: Run tests -- SqliteStore tests expected to fail**

```bash
npm test
```

Expected: All JsonlStore tests pass. All JSONL-specific tests pass. SqliteStore tests fail with "not implemented" errors. This is correct -- the stub methods throw, confirming the parameterization works.

- [ ] **Step 3: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "Parameterize test suite with describe.each for JsonlStore and SqliteStore"
```

---

### Task 7: Implement SqliteStore Write Operations

Implement `createEntities`, `createRelations`, and `addObservations` in `SqliteStore`. These make the corresponding test groups pass for both stores.

**Files:**
- Modify: `sqlite-store.ts`

- [ ] **Step 1: Implement createEntities**

Replace the stub with:

```typescript
  /**
   * Creates new entities in the SQLite database.
   * Uses INSERT OR IGNORE to skip name-duplicates (both existing and within-batch).
   * Observations are inserted with INSERT OR IGNORE to deduplicate by (entity_id, content).
   *
   * @param entities - Array of entities to create, each with observations as strings or objects
   * @returns Only the entities that were actually created (excludes name-duplicates)
   */
  async createEntities(entities: EntityInput[]): Promise<Entity[]> {
    // Prepared statements are compiled once and reused -- faster than db.exec() per row
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?)'
    );
    const getEntityId = this.db.prepare(
      'SELECT id FROM entities WHERE name = ?'
    );
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );

    const results: Entity[] = [];

    // db.transaction() wraps the callback in BEGIN/COMMIT. If the callback throws,
    // it automatically rolls back. This is a better-sqlite3 feature (not raw SQL).
    const txn = this.db.transaction(() => {
      for (const e of entities) {
        // INSERT OR IGNORE returns changes=0 if the name already exists (UNIQUE constraint)
        const info = insertEntity.run(e.name, e.entityType);
        if (info.changes === 0) continue;

        // Get the auto-generated id for inserting observations
        const row = getEntityId.get(e.name) as { id: number };
        const observations: Observation[] = [];

        for (const obs of e.observations) {
          const o = typeof obs === 'string' ? createObservation(obs) : obs;
          const obsInfo = insertObs.run(row.id, o.content, o.createdAt);
          if (obsInfo.changes > 0) {
            observations.push(o);
          }
        }

        results.push({ name: e.name, entityType: e.entityType, observations });
      }
    });
    txn();

    return results;
  }
```

- [ ] **Step 2: Implement createRelations**

```typescript
  /**
   * Creates new relations in the SQLite database.
   * Uses INSERT OR IGNORE to skip duplicates (UNIQUE constraint on all 3 fields).
   * Foreign key constraints ensure both endpoint entities exist -- throws on violation.
   *
   * @param relations - Array of { from, to, relationType }
   * @returns Only the relations that were actually created
   * @throws SqliteError if from or to entity doesn't exist (FK constraint violation)
   */
  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)'
    );

    const results: Relation[] = [];

    const txn = this.db.transaction(() => {
      for (const r of relations) {
        const info = insert.run(r.from, r.to, r.relationType);
        if (info.changes > 0) {
          results.push(r);
        }
      }
    });
    txn();

    return results;
  }
```

- [ ] **Step 3: Implement addObservations**

```typescript
  /**
   * Adds observations to existing entities. Throws if any entity is not found
   * (check happens before any insertions, so no partial writes).
   * Uses INSERT OR IGNORE to deduplicate by (entity_id, content).
   *
   * @param observations - Array of { entityName, contents: string[] }
   * @returns Per-entity results with only the observations actually added
   * @throws Error if any entityName doesn't match an existing entity
   */
  async addObservations(observations: AddObservationInput[]): Promise<AddObservationResult[]> {
    const findEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );

    const results: AddObservationResult[] = [];

    const txn = this.db.transaction(() => {
      for (const o of observations) {
        const row = findEntity.get(o.entityName) as { id: number } | undefined;
        if (!row) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }

        const addedObservations: Observation[] = [];
        for (const content of o.contents) {
          const obs = createObservation(content);
          const info = insertObs.run(row.id, obs.content, obs.createdAt);
          if (info.changes > 0) {
            addedObservations.push(obs);
          }
        }

        results.push({ entityName: o.entityName, addedObservations });
      }
    });
    txn();

    return results;
  }
```

- [ ] **Step 4: Run tests to verify progress**

```bash
npm test
```

Expected: createEntities, createRelations, and addObservations test groups now pass for SqliteStore. Other SqliteStore test groups still fail ("not implemented").

- [ ] **Step 5: Commit**

```bash
git add sqlite-store.ts
git commit -m "Implement SqliteStore write operations: createEntities, createRelations, addObservations"
```

---

### Task 8: Implement SqliteStore Delete Operations

Implement `deleteEntities`, `deleteObservations`, and `deleteRelations`. CASCADE handles related cleanup for entity deletes.

**Files:**
- Modify: `sqlite-store.ts`

- [ ] **Step 1: Implement deleteEntities**

```typescript
  /**
   * Deletes entities by name. ON DELETE CASCADE on the observations and relations
   * foreign keys automatically removes related rows -- no manual cleanup needed.
   * Silently ignores names that don't exist (idempotent).
   *
   * @param entityNames - Array of entity name strings to delete
   */
  async deleteEntities(entityNames: string[]): Promise<void> {
    const del = this.db.prepare('DELETE FROM entities WHERE name = ?');
    const txn = this.db.transaction(() => {
      for (const name of entityNames) {
        del.run(name);
      }
    });
    txn();
  }
```

- [ ] **Step 2: Implement deleteObservations**

```typescript
  /**
   * Deletes specific observations by content string from the named entities.
   * Silently ignores non-existent entities (idempotent -- absence is the goal).
   *
   * @param deletions - Array of { entityName, contents: string[] }
   */
  async deleteObservations(deletions: DeleteObservationInput[]): Promise<void> {
    const findEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    const delObs = this.db.prepare(
      'DELETE FROM observations WHERE entity_id = ? AND content = ?'
    );

    const txn = this.db.transaction(() => {
      for (const d of deletions) {
        const row = findEntity.get(d.entityName) as { id: number } | undefined;
        if (!row) continue;
        for (const content of d.contents) {
          delObs.run(row.id, content);
        }
      }
    });
    txn();
  }
```

- [ ] **Step 3: Implement deleteRelations**

```typescript
  /**
   * Deletes specific relations by exact match on all three fields.
   * Silently ignores non-existent relations (idempotent).
   *
   * @param relations - Array of { from, to, relationType }
   */
  async deleteRelations(relations: Relation[]): Promise<void> {
    const del = this.db.prepare(
      'DELETE FROM relations WHERE from_entity = ? AND to_entity = ? AND relation_type = ?'
    );
    const txn = this.db.transaction(() => {
      for (const r of relations) {
        del.run(r.from, r.to, r.relationType);
      }
    });
    txn();
  }
```

- [ ] **Step 4: Run tests to verify progress**

```bash
npm test
```

Expected: delete test groups now pass for SqliteStore.

- [ ] **Step 5: Commit**

```bash
git add sqlite-store.ts
git commit -m "Implement SqliteStore delete operations with CASCADE support"
```

---

### Task 9: Implement SqliteStore Read and Search Operations

Implement `readGraph`, `searchNodes`, and `openNodes`. After this task, all shared tests should pass for both stores.

**Files:**
- Modify: `sqlite-store.ts`

- [ ] **Step 1: Add private helpers to reduce repetition**

These avoid repeating the observation-grouping and relation-fetching logic:

```typescript
  /**
   * Fetches full Entity objects for a set of entity rows, including their observations.
   * Groups observation rows by entity name and assembles complete Entity objects.
   * Uses a single query to fetch all observations (avoids N+1 queries).
   *
   * @param entityRows - Array of { name, entityType } from an entities query
   * @returns Entity array with observations attached
   */
  private buildEntities(entityRows: { name: string; entityType: string }[]): Entity[] {
    if (entityRows.length === 0) return [];

    // Build placeholder string for SQL IN clause (one '?' per entity)
    const names = entityRows.map(e => e.name);
    const placeholders = names.map(() => '?').join(',');

    // Fetch all observations for these entities in one query
    const obsRows = this.db.prepare(`
      SELECT e.name AS entityName, o.content, o.created_at AS createdAt
      FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.name IN (${placeholders})
    `).all(...names) as { entityName: string; content: string; createdAt: string }[];

    // Group observations by entity name using a Map
    const obsMap = new Map<string, Observation[]>();
    for (const o of obsRows) {
      if (!obsMap.has(o.entityName)) obsMap.set(o.entityName, []);
      obsMap.get(o.entityName)!.push({ content: o.content, createdAt: o.createdAt });
    }

    return entityRows.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: obsMap.get(e.name) || [],
    }));
  }

  /**
   * Fetches all relations where at least one endpoint is in the given name set.
   *
   * @param entityNames - Array of entity name strings
   * @returns Relation array with from/to/relationType fields
   */
  private getConnectedRelations(entityNames: string[]): Relation[] {
    if (entityNames.length === 0) return [];

    const placeholders = entityNames.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType
      FROM relations
      WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})
    `).all(...entityNames, ...entityNames) as Relation[];
  }
```

- [ ] **Step 2: Implement readGraph**

```typescript
  /**
   * Returns the entire knowledge graph (all entities with observations, all relations).
   * For an empty database, returns { entities: [], relations: [] }.
   */
  async readGraph(): Promise<KnowledgeGraph> {
    const entityRows = this.db.prepare(
      'SELECT name, entity_type AS entityType FROM entities'
    ).all() as { name: string; entityType: string }[];

    const entities = this.buildEntities(entityRows);

    const relations = this.db.prepare(
      'SELECT from_entity AS "from", to_entity AS "to", relation_type AS relationType FROM relations'
    ).all() as Relation[];

    return { entities, relations };
  }
```

- [ ] **Step 3: Implement searchNodes**

```typescript
  /**
   * Searches entities by case-insensitive substring match against name, entityType,
   * or observation content. Uses LIKE with escaped wildcards.
   *
   * SQLite's LIKE is case-insensitive for ASCII characters (A-Z) by default.
   * For full Unicode case folding, FTS5 with ICU would be needed.
   *
   * @param query - The search string, matched as a case-insensitive substring
   * @returns Matching entities + relations where at least one endpoint matches
   */
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const escaped = escapeLike(query);
    const pattern = `%${escaped}%`;

    // Find entities matching the query in name, type, or any observation content.
    // LEFT JOIN ensures entities with no observations are still checked.
    // DISTINCT prevents duplicates when multiple observations match.
    const entityRows = this.db.prepare(`
      SELECT DISTINCT e.name, e.entity_type AS entityType
      FROM entities e
      LEFT JOIN observations o ON o.entity_id = e.id
      WHERE e.name LIKE ? ESCAPE '\\'
         OR e.entity_type LIKE ? ESCAPE '\\'
         OR o.content LIKE ? ESCAPE '\\'
    `).all(pattern, pattern, pattern) as { name: string; entityType: string }[];

    const entities = this.buildEntities(entityRows);
    const relations = this.getConnectedRelations(entityRows.map(e => e.name));

    return { entities, relations };
  }
```

- [ ] **Step 4: Implement openNodes**

```typescript
  /**
   * Retrieves specific entities by exact name match. Returns matching entities
   * plus relations where at least one endpoint is in the requested set.
   * Non-existent names are silently skipped.
   *
   * @param names - Array of entity name strings to retrieve
   * @returns Matching entities with observations + connected relations
   */
  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    if (names.length === 0) return { entities: [], relations: [] };

    const placeholders = names.map(() => '?').join(',');
    const entityRows = this.db.prepare(
      `SELECT name, entity_type AS entityType FROM entities WHERE name IN (${placeholders})`
    ).all(...names) as { name: string; entityType: string }[];

    const entities = this.buildEntities(entityRows);
    const relations = this.getConnectedRelations(entityRows.map(e => e.name));

    return { entities, relations };
  }
```

- [ ] **Step 5: Run tests -- all shared tests should now pass for both stores**

```bash
npm test
```

Expected: ALL tests pass -- both JsonlStore and SqliteStore sections green.

- [ ] **Step 6: Commit**

```bash
git add sqlite-store.ts
git commit -m "Implement SqliteStore read/search operations -- full test parity with JsonlStore"
```

---

### Task 10: Store Selection

Refactor `ensureMemoryFilePath()` to return a `StoreConfig` (path + store type), change the default from `memory.jsonl` to `memory.db`, and wire up store selection in `main()`.

**Files:**
- Modify: `jsonl-store.ts`
- Modify: `index.ts`
- Modify: `__tests__/file-path.test.ts`

- [ ] **Step 1: Add StoreConfig type and refactor ensureMemoryFilePath in jsonl-store.ts**

Add the `StoreConfig` type export and update `defaultMemoryPath` to point to `memory.db`:

```typescript
/** Configuration returned by ensureMemoryFilePath() -- determines which store to use. */
export type StoreConfig = { path: string; storeType: 'jsonl' | 'sqlite' };

// Change the default from .jsonl to .db (SQLite is now the default backend)
export const defaultMemoryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'memory.db'
);
```

Replace the `ensureMemoryFilePath` function body:

```typescript
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

/**
 * Handles the legacy memory.json -> memory.jsonl migration.
 * Only runs when the target is the default memory.jsonl path alongside the script.
 */
async function migrateJsonToJsonl(scriptDir: string, jsonlPath: string): Promise<void> {
  const oldJsonPath = path.join(scriptDir, 'memory.json');
  const targetIsDefault = jsonlPath === path.join(scriptDir, 'memory.jsonl');

  if (!targetIsDefault) return;

  try {
    await fs.access(oldJsonPath);
    try {
      await fs.access(jsonlPath);
      // Both exist -- use the new one, no migration
    } catch {
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldJsonPath, jsonlPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
    }
  } catch {
    // Old file doesn't exist -- nothing to migrate
  }
}
```

- [ ] **Step 2: Wire up store selection in index.ts main()**

Update the import and main function in `index.ts`:

```typescript
// Add SqliteStore import:
import { SqliteStore } from './sqlite-store.js';

// Add to re-exports:
export { type StoreConfig } from './jsonl-store.js';
export { SqliteStore } from './sqlite-store.js';

// Replace main():
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
```

- [ ] **Step 3: Rewrite file-path.test.ts for StoreConfig return type**

The tests now check `config.path` and `config.storeType` instead of just a string. Also tests for `.db`/`.sqlite` extension handling and error on unrecognized extensions.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureMemoryFilePath, defaultMemoryPath } from '../jsonl-store.js';

describe('ensureMemoryFilePath', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const oldMemoryPath = path.join(testDir, '..', 'memory.json');
  const jsonlMemoryPath = path.join(testDir, '..', 'memory.jsonl');

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MEMORY_FILE_PATH;
    delete process.env.MEMORY_FILE_PATH;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.MEMORY_FILE_PATH = originalEnv;
    } else {
      delete process.env.MEMORY_FILE_PATH;
    }
    try { await fs.unlink(oldMemoryPath); } catch { /* ignore */ }
    try { await fs.unlink(jsonlMemoryPath); } catch { /* ignore */ }
  });

  describe('with MEMORY_FILE_PATH environment variable', () => {
    it('should return JSONL config for .jsonl extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/custom-memory.jsonl';
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: '/tmp/custom-memory.jsonl', storeType: 'jsonl' });
    });

    it('should return SQLite config for .db extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/custom-memory.db';
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: '/tmp/custom-memory.db', storeType: 'sqlite' });
    });

    it('should return SQLite config for .sqlite extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/custom-memory.sqlite';
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: '/tmp/custom-memory.sqlite', storeType: 'sqlite' });
    });

    it('should resolve relative paths against script directory', async () => {
      process.env.MEMORY_FILE_PATH = 'custom-memory.jsonl';
      const config = await ensureMemoryFilePath();
      expect(path.isAbsolute(config.path)).toBe(true);
      expect(config.path).toContain('custom-memory.jsonl');
      expect(config.storeType).toBe('jsonl');
    });

    it('should throw on unrecognized file extension', async () => {
      process.env.MEMORY_FILE_PATH = '/tmp/memory.txt';
      await expect(ensureMemoryFilePath()).rejects.toThrow('Unsupported file extension');
    });
  });

  describe('without MEMORY_FILE_PATH environment variable', () => {
    it('should default to SQLite (.db)', async () => {
      const config = await ensureMemoryFilePath();
      expect(config).toEqual({ path: defaultMemoryPath, storeType: 'sqlite' });
    });
  });

  describe('defaultMemoryPath', () => {
    it('should end with memory.db', () => {
      expect(defaultMemoryPath).toMatch(/memory\.db$/);
    });

    it('should be an absolute path', () => {
      expect(path.isAbsolute(defaultMemoryPath)).toBe(true);
    });
  });

  describe('legacy .json to .jsonl migration', () => {
    it('should migrate memory.json to memory.jsonl when using default JSONL path', async () => {
      process.env.MEMORY_FILE_PATH = path.join(testDir, '..', 'memory.jsonl');
      await fs.writeFile(oldMemoryPath, '{"test":"data"}');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = await ensureMemoryFilePath();

      expect(config.storeType).toBe('jsonl');
      const newExists = await fs.access(jsonlMemoryPath).then(() => true).catch(() => false);
      const oldExists = await fs.access(oldMemoryPath).then(() => true).catch(() => false);
      expect(newExists).toBe(true);
      expect(oldExists).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('DETECTED'));
      consoleErrorSpy.mockRestore();
    });

    it('should preserve content during migration', async () => {
      process.env.MEMORY_FILE_PATH = path.join(testDir, '..', 'memory.jsonl');
      const testContent = '{"entities": [{"name": "test"}]}';
      await fs.writeFile(oldMemoryPath, testContent);

      await ensureMemoryFilePath();
      const migratedContent = await fs.readFile(jsonlMemoryPath, 'utf-8');
      expect(migratedContent).toBe(testContent);
    });
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add jsonl-store.ts index.ts __tests__/file-path.test.ts
git commit -m "Add store selection by file extension, default to SQLite

ensureMemoryFilePath() now returns StoreConfig { path, storeType }.
Default changes from memory.jsonl to memory.db.
main() instantiates JsonlStore or SqliteStore based on extension."
```

---

### Task 11: JSONL to SQLite Auto-Migration

Add migration logic to `SqliteStore.init()`. When a `.db` file doesn't exist but a `.jsonl` file is found at the same location, auto-migrate the data in a single transaction and rename the JSONL file to `.jsonl.bak`.

**Files:**
- Modify: `sqlite-store.ts`
- Create: `__tests__/migration.test.ts`

- [ ] **Step 1: Write migration tests**

Create `__tests__/migration.test.ts`:

```typescript
// migration.test.ts -- Tests for JSONL to SQLite auto-migration.
// Migration happens inside SqliteStore.init() when the .db file doesn't exist
// but a .jsonl file is found at the same path (with extension swapped).

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonlStore } from '../jsonl-store.js';
import { SqliteStore } from '../sqlite-store.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe('JSONL to SQLite migration', () => {
  let dbPath: string;
  let jsonlPath: string;

  afterEach(async () => {
    for (const p of [dbPath, jsonlPath, jsonlPath + '.bak']) {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }
    for (const suffix of ['-wal', '-shm']) {
      try { await fs.unlink(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('should auto-migrate entities, observations, and relations from JSONL', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Seed a JSONL file with data
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([
      { name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
      { name: 'Bob', entityType: 'person', observations: ['likes coding'] },
    ]);
    await jsonlStore.createRelations([
      { from: 'Alice', to: 'Bob', relationType: 'knows' },
    ]);
    await jsonlStore.close();

    // Open a SqliteStore at the same base path -- should trigger migration
    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(2);
    expect(graph.entities.find(e => e.name === 'Alice')?.observations[0].content).toBe('works at Acme');
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]).toEqual({ from: 'Alice', to: 'Bob', relationType: 'knows' });

    await sqliteStore.close();
  });

  it('should rename .jsonl to .jsonl.bak after migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([{ name: 'Test', entityType: 'test', observations: [] }]);
    await jsonlStore.close();

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();
    await sqliteStore.close();

    const bakExists = await fs.access(jsonlPath + '.bak').then(() => true).catch(() => false);
    const jsonlExists = await fs.access(jsonlPath).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);
    expect(jsonlExists).toBe(false);
  });

  it('should skip migration when .db already exists', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Seed JSONL and create DB via first migration
    const jsonlStore = new JsonlStore(jsonlPath);
    await jsonlStore.init();
    await jsonlStore.createEntities([{ name: 'Original', entityType: 'test', observations: [] }]);
    await jsonlStore.close();

    const sqliteStore1 = new SqliteStore(dbPath);
    await sqliteStore1.init();
    await sqliteStore1.close();

    // Re-create a JSONL file (simulating leftover data)
    const jsonlStore2 = new JsonlStore(jsonlPath);
    await jsonlStore2.init();
    await jsonlStore2.createEntities([{ name: 'ShouldNotAppear', entityType: 'test', observations: [] }]);
    await jsonlStore2.close();

    // Second init should NOT re-migrate
    const sqliteStore2 = new SqliteStore(dbPath);
    await sqliteStore2.init();
    const graph = await sqliteStore2.readGraph();
    await sqliteStore2.close();

    expect(graph.entities.find(e => e.name === 'ShouldNotAppear')).toBeUndefined();
  });

  it('should handle legacy string observations during migration', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Write a JSONL file with legacy string observations (not objects)
    const legacyLine = JSON.stringify({
      type: 'entity', name: 'Legacy', entityType: 'test',
      observations: ['old string observation'],
    });
    await fs.writeFile(jsonlPath, legacyLine + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0].observations[0].content).toBe('old string observation');
    expect(graph.entities[0].observations[0].createdAt).toBe('unknown');

    await sqliteStore.close();
  });

  it('should tolerate duplicate entities in corrupted JSONL', async () => {
    const id = Date.now();
    jsonlPath = path.join(testDir, `test-migrate-${id}.jsonl`);
    dbPath = path.join(testDir, `test-migrate-${id}.db`);

    // Two entities with the same name (corrupted data)
    const line1 = JSON.stringify({ type: 'entity', name: 'Dupe', entityType: 'a', observations: [] });
    const line2 = JSON.stringify({ type: 'entity', name: 'Dupe', entityType: 'b', observations: [] });
    await fs.writeFile(jsonlPath, line1 + '\n' + line2 + '\n');

    const sqliteStore = new SqliteStore(dbPath);
    await sqliteStore.init();

    const graph = await sqliteStore.readGraph();
    expect(graph.entities).toHaveLength(1);

    await sqliteStore.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test __tests__/migration.test.ts
```

Expected: migration tests fail because SqliteStore.init() doesn't have migration logic yet.

- [ ] **Step 3: Implement migration in SqliteStore.init()**

Add the import for `JsonlStore` at the top of `sqlite-store.ts`:

```typescript
import { JsonlStore } from './jsonl-store.js';
```

Add a `fileExists` helper:

```typescript
/**
 * Checks if a file exists at the given path.
 * @returns true if the file is accessible, false otherwise
 */
async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
```

Update `init()` to add migration logic before and after schema creation:

```typescript
  async init(): Promise<void> {
    // --- Check for JSONL migration BEFORE opening the DB ---
    // (Opening the DB creates the file, which would defeat the "db doesn't exist" check)
    let migrationData: KnowledgeGraph | null = null;
    const dbAlreadyExists = await fileExists(this.dbPath);

    if (!dbAlreadyExists) {
      // Look for a JSONL file at the same path but with .jsonl extension
      const jsonlPath = this.dbPath.replace(/\.(db|sqlite)$/, '.jsonl');
      if (jsonlPath !== this.dbPath && await fileExists(jsonlPath)) {
        console.error(`DETECTED: Found ${jsonlPath}, will migrate to SQLite`);
        const jsonlStore = new JsonlStore(jsonlPath);
        await jsonlStore.init();
        migrationData = await jsonlStore.readGraph();
        await jsonlStore.close();
      }
    }

    // --- Open database and create schema ---
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(entity_id, content)
      );
      CREATE TABLE IF NOT EXISTS relations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity   TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        to_entity     TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
        relation_type TEXT NOT NULL,
        UNIQUE(from_entity, to_entity, relation_type)
      );
    `);

    // --- Run migration if data was loaded from JSONL ---
    if (migrationData) {
      const jsonlPath = this.dbPath.replace(/\.(db|sqlite)$/, '.jsonl');
      this.migrateFromJsonl(migrationData);
      try {
        await fs.rename(jsonlPath, jsonlPath + '.bak');
      } catch (renameError) {
        console.error(`WARNING: Migration succeeded but could not rename ${jsonlPath} to .bak:`, renameError);
      }
      console.error(
        `COMPLETED: Migrated ${migrationData.entities.length} entities and ` +
        `${migrationData.relations.length} relations to SQLite. Backup at ${jsonlPath}.bak`
      );
    }
  }

  /**
   * Imports a KnowledgeGraph (read from JSONL) into the SQLite database.
   * Runs in a single transaction -- rolls back on any error.
   * Uses INSERT OR IGNORE to tolerate duplicates in corrupted JSONL data.
   * Dangling relations (referencing non-existent entities) are silently skipped
   * because the FK constraint prevents insertion.
   */
  private migrateFromJsonl(graph: KnowledgeGraph): void {
    const insertEntity = this.db.prepare(
      'INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?)'
    );
    const getEntityId = this.db.prepare(
      'SELECT id FROM entities WHERE name = ?'
    );
    const insertObs = this.db.prepare(
      'INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)'
    );
    const insertRel = this.db.prepare(
      'INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)'
    );

    const txn = this.db.transaction(() => {
      for (const entity of graph.entities) {
        insertEntity.run(entity.name, entity.entityType);
        const row = getEntityId.get(entity.name) as { id: number };
        for (const obs of entity.observations) {
          insertObs.run(row.id, obs.content, obs.createdAt);
        }
      }
      for (const rel of graph.relations) {
        try {
          insertRel.run(rel.from, rel.to, rel.relationType);
        } catch {
          // FK violation -- endpoint entity doesn't exist. Skip silently.
        }
      }
    });
    txn();
  }
```

- [ ] **Step 4: Run tests to verify migration works**

```bash
npm test
```

Expected: all tests pass, including the new migration tests.

- [ ] **Step 5: Commit**

```bash
git add sqlite-store.ts __tests__/migration.test.ts
git commit -m "Add JSONL to SQLite auto-migration in SqliteStore.init()

Detects .jsonl file at same path, imports in single transaction,
renames to .jsonl.bak. Tolerates duplicates and dangling relations."
```

---

### Task 12: SQLite-Specific Tests

Add tests for SQLite-only behavior: FK constraint enforcement, LIKE wildcard escaping, WAL journal mode, and INSERT OR IGNORE dedup.

**Files:**
- Modify: `__tests__/knowledge-graph.test.ts` (add SqliteStore-specific section)

- [ ] **Step 1: Add SQLite-specific test section**

Add after the JSONL-specific section in `knowledge-graph.test.ts`:

```typescript
describe('SqliteStore-specific', () => {
  let store: SqliteStore;
  let storePath: string;

  beforeEach(async () => {
    storePath = path.join(testDir, `test-sqlite-${Date.now()}.db`);
    store = new SqliteStore(storePath);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { await fs.unlink(storePath + suffix); } catch { /* ignore */ }
    }
  });

  describe('foreign key constraints', () => {
    it('should reject relations referencing non-existent entities', async () => {
      await expect(
        store.createRelations([
          { from: 'Ghost', to: 'Phantom', relationType: 'knows' },
        ])
      ).rejects.toThrow();
    });

    it('should cascade-delete observations when entity is deleted', async () => {
      await store.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['obs1', 'obs2'] },
      ]);
      await store.deleteEntities(['Alice']);

      // Re-create Alice -- should have no leftover observations
      await store.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
      ]);
      const graph = await store.readGraph();
      expect(graph.entities[0].observations).toHaveLength(0);
    });

    it('should cascade-delete relations when entity is deleted', async () => {
      await store.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);
      await store.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ]);
      await store.deleteEntities(['Alice']);

      const graph = await store.readGraph();
      expect(graph.relations).toHaveLength(0);
    });
  });

  describe('LIKE wildcard escaping', () => {
    it('should treat % as a literal character in search', async () => {
      await store.createEntities([
        { name: '100% complete', entityType: 'status', observations: [] },
        { name: 'incomplete', entityType: 'status', observations: [] },
      ]);

      const result = await store.searchNodes('100%');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('100% complete');
    });

    it('should treat _ as a literal character in search', async () => {
      await store.createEntities([
        { name: 'my_var', entityType: 'variable', observations: [] },
        { name: 'myXvar', entityType: 'variable', observations: [] },
      ]);

      const result = await store.searchNodes('my_var');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('my_var');
    });
  });

  describe('WAL journal mode', () => {
    it('should use WAL journal mode', async () => {
      // Access private db field for this infrastructure test
      const mode = (store as any).db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    });
  });

  describe('INSERT OR IGNORE behavior', () => {
    it('should silently skip duplicate entity names', async () => {
      await store.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['first'] },
      ]);
      const result = await store.createEntities([
        { name: 'Alice', entityType: 'robot', observations: ['second'] },
      ]);

      expect(result).toHaveLength(0);
      const graph = await store.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].entityType).toBe('person');
    });

    it('should silently skip duplicate observations on same entity', async () => {
      await store.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['original'] },
      ]);
      const result = await store.addObservations([
        { entityName: 'Alice', contents: ['original', 'new one'] },
      ]);

      expect(result[0].addedObservations).toHaveLength(1);
      expect(result[0].addedObservations[0].content).toBe('new one');
    });
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: all tests pass, including the new SQLite-specific tests.

- [ ] **Step 3: Commit**

```bash
git add __tests__/knowledge-graph.test.ts
git commit -m "Add SQLite-specific tests: FK constraints, LIKE escaping, WAL mode, INSERT OR IGNORE"
```

---

### Task 13: Version Bump and Documentation

Bump version to `0.8.0` in package.json, update CLAUDE.md and README.md for the new architecture.

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Bump version in package.json**

Change `"version": "0.7.0"` to `"version": "0.8.0"`.

Note: the MCP server version string in `index.ts` was already updated to `"0.8.0"` in Task 4.

- [ ] **Step 2: Update CLAUDE.md**

Update to reflect the 4-file split, both storage backends, updated test structure, and Phase 2 marked as done. Key sections to change:

- Opening line: mention SQLite default + JSONL fallback
- Tech Stack: add better-sqlite3
- Architecture: describe all 4 files, GraphStore interface, store selection, auto-migration, SQLite schema, dedup strategy
- Known Limitations: JSONL no file locking / no FK; SQLite ASCII-only case folding
- Tests: describe parameterized suite, file-path tests, migration tests
- Planned Phases: mark Phase 2 as done

- [ ] **Step 3: Update README.md**

Key changes:
- Opening: "JSONL-backed graph" -> "persistent knowledge graph (SQLite default, JSONL fallback)"
- Config example: change `memory.jsonl` to `memory.db` in the MCP config JSON
- Add "Storage Backends" section after "Data Model" covering:
  - SQLite (default): auto-created `memory.db`, FK constraints, WAL mode
  - JSONL (fallback): set `MEMORY_FILE_PATH` to a `.jsonl` path
  - Migration: auto on first run, `.jsonl.bak` backup, rollback steps
- Mark SQLite as done in planned features
- Update Data Model to mention both backends

- [ ] **Step 4: Final verification**

```bash
npm test && npm run build
```

Expected: all tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json CLAUDE.md README.md
git commit -m "Bump version to 0.8.0, update docs for SQLite storage backend

Mark Phase 2 as done. Document both backends, migration scenarios,
and new 4-file architecture."
```

---

## Post-Implementation Checklist

After all 13 tasks are complete:

- [ ] Run full test suite: `npm test` -- all tests green
- [ ] Build: `npm run build` -- no TypeScript errors
- [ ] Manual smoke test: start server with no env var, create entities, verify `memory.db` created
- [ ] Manual migration test: create a `memory.jsonl` with data, start server with default config, verify `memory.db` created and `memory.jsonl.bak` exists
- [ ] Manual JSONL fallback test: set `MEMORY_FILE_PATH=memory.jsonl`, verify JSONL store used
- [ ] Push to GitHub
- [ ] Update GitHub issues if applicable
