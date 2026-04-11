/**
 * MCP Tool Handler Integration Tests
 *
 * These tests exercise the FULL flow that MCP tool handlers in index.ts perform:
 *   1. Zod schema validates the input
 *   2. normalizeProjectId() cleans the projectId
 *   3. The store method is called with the normalized value
 *   4. The result is returned in the expected output shape
 *
 * This fills the gap identified in QA: store-level tests exist (~202 tests),
 * but nothing tests the normalizeProjectId integration or Zod schema constraints
 * as they're wired in the actual tool handlers.
 *
 * Approach:
 * - Replicates normalizeProjectId() (a simple pure function not exported from index.ts)
 * - Replicates the Zod schemas from index.ts for validation testing
 * - Creates a real SqliteStore to verify data flows through correctly
 * - Tests are structured to mirror the actual handler code paths
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { SqliteStore } from '../sqlite-store.js';
import type { GraphStore } from '../types.js';

// Resolve the directory containing this test file — used for building temp file paths
const testDir = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------
// Replicate normalizeProjectId() from index.ts
// ----------------------------------------------------------
// This is the exact logic from index.ts lines 123-132.
// We replicate it here because it's a private (non-exported) function,
// and the purpose of these tests is to verify that this normalization
// is correctly applied before data reaches the store.

/**
 * Normalizes a projectId: trims whitespace, lowercases, NFC-normalizes Unicode,
 * and converts empty/undefined to undefined (global scope).
 * This is an exact copy of the function in index.ts.
 *
 * @param projectId - Raw projectId string, may be undefined
 * @returns Cleaned lowercase string, or undefined for global scope
 */
function normalizeProjectId(projectId?: string): string | undefined {
	if (!projectId) return undefined;
	// trim() strips whitespace; toLowerCase() normalizes case;
	// normalize('NFC') collapses Unicode equivalents (NFD → NFC)
	const normalized = projectId.trim().toLowerCase().normalize('NFC');
	return normalized || undefined;
}

// ----------------------------------------------------------
// Replicate Zod schemas from index.ts for validation testing
// ----------------------------------------------------------
// These mirror the schemas defined in index.ts lines 82-147.
// We replicate them rather than importing because they're module-scoped
// (not exported) in index.ts.

/** Schema for a single entity in create_entities input — name, type, and observation strings */
const EntityInputSchema = z.object({
	name: z.string().min(1).max(500).describe("The name of the entity"),
	entityType: z.string().min(1).max(500).describe("The type of the entity"),
	observations: z.array(z.string().min(1).max(5000)).max(100)
		.describe("An array of observation contents associated with the entity"),
});

/** Schema for projectId — trims whitespace, enforces min(1) AFTER trim, max 500 chars, optional */
const ProjectIdSchema = z.string().trim().min(1).max(500)
	.describe("Project scope for filtering. Omit for global/unscoped.")
	.optional();

/** Schema for the full create_entities input — array of entities + optional projectId */
const CreateEntitiesInputSchema = z.object({
	entities: z.array(EntityInputSchema).max(100),
	projectId: ProjectIdSchema,
});

/**
 * Schema for the asOf parameter — ISO 8601 UTC timestamp with Z suffix only.
 * Mirrors the production schema in index.ts: `.datetime({ offset: false })`
 * forbids non-UTC offsets so caller-supplied timestamps lexicographically
 * compare correctly against the Z-suffixed timestamps stored in SQLite.
 */
const AsOfSchema = z.string().datetime({ offset: false }).optional();

/** Schema for search_nodes input — query string + optional projectId, cursor, limit, asOf */
const SearchNodesInputSchema = z.object({
	query: z.string().min(1).max(5000)
		.describe("The search query to match against entity names, types, and observation content"),
	projectId: ProjectIdSchema,
	cursor: z.string().max(10000).optional()
		.describe("Opaque cursor from a previous response for fetching the next page"),
	limit: z.number().int().min(1).max(100).optional().default(40)
		.describe("Max entities per page (default 40, max 100)"),
	asOf: AsOfSchema,
});

/** Schema for read_graph input — optional projectId, cursor, limit, asOf */
const ReadGraphInputSchema = z.object({
	projectId: ProjectIdSchema,
	cursor: z.string().max(10000).optional()
		.describe("Opaque cursor from a previous response"),
	limit: z.number().int().min(1).max(100).optional().default(40)
		.describe("Max entities per page"),
	asOf: AsOfSchema,
});

/** Schema for open_nodes input — array of names + optional projectId + asOf */
const OpenNodesInputSchema = z.object({
	names: z.array(z.string().min(1).max(500)).max(100)
		.describe("An array of entity names to retrieve"),
	projectId: ProjectIdSchema,
	asOf: AsOfSchema,
});

// ============================================================
// Test suite
// ============================================================

describe('MCP Tool Handler Integration', () => {
	// `store` — the SqliteStore instance used by each test, created fresh in beforeEach
	let store: GraphStore;
	// `storePath` — temp file path for the SQLite database, unique per test
	let storePath: string;

	beforeEach(async () => {
		// Build a unique path so parallel tests don't collide on the same file
		storePath = path.join(testDir, `test-mcp-tools-${Date.now()}.db`);
		store = new SqliteStore(storePath);
		await store.init();
	});

	afterEach(async () => {
		await store.close();
		// Clean up SQLite database and its sidecar files (WAL, SHM)
		for (const suffix of ['', '-wal', '-shm']) {
			try { await fs.unlink(storePath + suffix); } catch { /* ignore missing files */ }
		}
	});

	// ----------------------------------------------------------
	// Section 1: normalizeProjectId integration
	// Verifies that projectId is normalized (trimmed, lowercased,
	// NFC) before reaching the store, matching what the tool
	// handlers in index.ts do.
	// ----------------------------------------------------------
	describe('normalizeProjectId integration', () => {

		it('create_entities with padded projectId stores under normalized key', async () => {
			// Simulates what the create_entities handler does:
			// 1. Receives input with projectId " MyProject "
			// 2. Calls normalizeProjectId() → "myproject"
			// 3. Passes "myproject" to store.createEntities()
			const rawProjectId = ' MyProject ';
			const normalized = normalizeProjectId(rawProjectId);

			// Verify normalization happened correctly
			expect(normalized).toBe('myproject');

			// Create an entity with the normalized projectId — same as the handler does
			const result = await store.createEntities(
				[{ name: 'TestEntity', entityType: 'concept', observations: ['a fact'] }],
				normalized
			);
			expect(result.created).toHaveLength(1);
			expect(result.created[0].project).toBe('myproject');

			// Verify the entity is readable under the normalized project scope
			const graph = await store.readGraph('myproject');
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('TestEntity');
		});

		it('read_graph with mixed-case projectId reads from normalized scope', async () => {
			// First, create entities under the normalized project name (as the handler would)
			await store.createEntities(
				[{ name: 'Entity1', entityType: 'item', observations: ['obs1'] }],
				normalizeProjectId('myproject')
			);

			// Now simulate read_graph with " MyProject " — handler normalizes before calling store
			const rawProjectId = ' MyProject ';
			const graph = await store.readGraph(normalizeProjectId(rawProjectId));

			// The entity created under "myproject" should be found via " MyProject " after normalization
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('Entity1');
		});

		it('search_nodes with mixed-case projectId searches normalized scope', async () => {
			// Create entity under normalized project
			await store.createEntities(
				[{ name: 'SearchTarget', entityType: 'concept', observations: ['findable content'] }],
				normalizeProjectId('myproject')
			);

			// Simulate search_nodes handler: normalize "MyProject" → "myproject"
			const rawProjectId = 'MyProject';
			const result = await store.searchNodes(
				'findable',
				normalizeProjectId(rawProjectId),
				{ limit: 40 }
			);

			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('SearchTarget');
		});

		it('open_nodes with mixed-case projectId opens from normalized scope', async () => {
			// Create entity under normalized project
			await store.createEntities(
				[{ name: 'NodeToOpen', entityType: 'item', observations: ['detail'] }],
				normalizeProjectId('myproject')
			);

			// Simulate open_nodes handler: normalize "MyProject" → "myproject"
			const rawProjectId = 'MyProject';
			const graph = await store.openNodes(
				['NodeToOpen'],
				normalizeProjectId(rawProjectId)
			);

			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('NodeToOpen');
		});

		it('empty string projectId normalizes to undefined (global scope)', async () => {
			// normalizeProjectId("") should return undefined (global)
			// The handler checks: if (!projectId) return undefined
			const normalized = normalizeProjectId('');
			expect(normalized).toBeUndefined();

			// Create entity with no project scope (global)
			await store.createEntities(
				[{ name: 'GlobalEntity', entityType: 'thing', observations: ['global obs'] }],
				normalized
			);

			// Verify it's stored globally (project = null in the database)
			const graph = await store.readGraph(undefined);
			const globalEntity = graph.entities.find(e => e.name === 'GlobalEntity');
			expect(globalEntity).toBeDefined();
			expect(globalEntity!.project).toBeNull();
		});

		it('whitespace-only projectId normalizes to undefined (global scope)', async () => {
			// "   " after trim() → "", which is falsy → undefined
			const normalized = normalizeProjectId('   ');
			expect(normalized).toBeUndefined();
		});

		it('NFC normalization collapses equivalent Unicode representations', async () => {
			// NFD: "cafe\u0301" (e + combining accent) vs NFC: "caf\u00e9" (single char)
			// Both should normalize to the same project key
			const nfdProject = 'cafe\u0301';  // NFD form — "e" + combining acute accent
			const nfcProject = 'caf\u00e9';   // NFC form — precomposed "e" with accent

			const normalizedNFD = normalizeProjectId(nfdProject);
			const normalizedNFC = normalizeProjectId(nfcProject);

			// Both should produce the same normalized string
			expect(normalizedNFD).toBe(normalizedNFC);
			expect(normalizedNFD).toBe('café');

			// Create entity via NFD project name, read via NFC — should find it
			await store.createEntities(
				[{ name: 'UnicodeEntity', entityType: 'test', observations: ['unicode test'] }],
				normalizedNFD
			);

			const graph = await store.readGraph(normalizedNFC);
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('UnicodeEntity');
		});

		it('list_projects returns normalized project names after creation', async () => {
			// Create entities under different raw projectIds that all normalize to "myproject"
			await store.createEntities(
				[{ name: 'E1', entityType: 't', observations: ['o1'] }],
				normalizeProjectId('MyProject')
			);
			await store.createEntities(
				[{ name: 'E2', entityType: 't', observations: ['o2'] }],
				normalizeProjectId(' MYPROJECT ')
			);

			// list_projects should show only one project: "myproject"
			const projects = await store.listProjects();
			expect(projects).toContain('myproject');
			// Both E1 and E2 share the same normalized project, so only one project entry
			expect(projects.filter(p => p === 'myproject')).toHaveLength(1);
		});
	});

	// ----------------------------------------------------------
	// Section 2: Zod input validation
	// Verifies that schema constraints match what index.ts defines,
	// catching violations that would be rejected at the MCP layer.
	// ----------------------------------------------------------
	describe('Zod input validation', () => {

		it('rejects entity name longer than 500 characters', () => {
			// EntityInputSchema.name has .max(500)
			const longName = 'x'.repeat(501);
			const result = EntityInputSchema.safeParse({
				name: longName,
				entityType: 'test',
				observations: ['obs'],
			});
			expect(result.success).toBe(false);
		});

		it('rejects observation content longer than 5000 characters', () => {
			// EntityInputSchema.observations items have .max(5000)
			const longObs = 'y'.repeat(5001);
			const result = EntityInputSchema.safeParse({
				name: 'ValidName',
				entityType: 'test',
				observations: [longObs],
			});
			expect(result.success).toBe(false);
		});

		it('rejects empty entity name', () => {
			// EntityInputSchema.name has .min(1)
			const result = EntityInputSchema.safeParse({
				name: '',
				entityType: 'test',
				observations: ['obs'],
			});
			expect(result.success).toBe(false);
		});

		it('rejects entity array exceeding 100 items', () => {
			// CreateEntitiesInputSchema.entities has .max(100)
			const tooManyEntities = Array.from({ length: 101 }, (_, i) => ({
				name: `Entity${i}`,
				entityType: 'test',
				observations: ['obs'],
			}));
			const result = CreateEntitiesInputSchema.safeParse({
				entities: tooManyEntities,
			});
			expect(result.success).toBe(false);
		});

		it('rejects cursor string longer than 10000 characters', () => {
			// SearchNodesInputSchema.cursor has .max(10000)
			const longCursor = 'c'.repeat(10001);
			const result = SearchNodesInputSchema.safeParse({
				query: 'test',
				cursor: longCursor,
			});
			expect(result.success).toBe(false);
		});

		it('rejects empty observation content in entity', () => {
			// EntityInputSchema.observations items have .min(1)
			const result = EntityInputSchema.safeParse({
				name: 'ValidName',
				entityType: 'test',
				observations: [''],
			});
			expect(result.success).toBe(false);
		});

		it('rejects whitespace-only projectId (trim then min check)', () => {
			// ProjectIdSchema has .trim().min(1), so " " becomes "" which fails min(1)
			const result = CreateEntitiesInputSchema.safeParse({
				entities: [{ name: 'E1', entityType: 't', observations: ['o'] }],
				projectId: '   ',
			});
			expect(result.success).toBe(false);
		});

		it('accepts valid input within all constraints', () => {
			// Sanity check: well-formed input should pass all schema checks
			const result = CreateEntitiesInputSchema.safeParse({
				entities: [{
					name: 'ValidEntity',
					entityType: 'concept',
					observations: ['A valid observation'],
				}],
				projectId: 'my-project',
			});
			expect(result.success).toBe(true);
		});

		it('accepts input without projectId (optional field)', () => {
			// projectId is optional — omitting it should be valid
			const result = CreateEntitiesInputSchema.safeParse({
				entities: [{
					name: 'GlobalEntity',
					entityType: 'thing',
					observations: ['no project'],
				}],
			});
			expect(result.success).toBe(true);
			// Verify the parsed value has projectId undefined
			if (result.success) {
				expect(result.data.projectId).toBeUndefined();
			}
		});

		it('accepts entity name at exactly 500 characters', () => {
			// Boundary check: exactly 500 should pass, 501 should fail
			const exactName = 'a'.repeat(500);
			const result = EntityInputSchema.safeParse({
				name: exactName,
				entityType: 'test',
				observations: ['obs'],
			});
			expect(result.success).toBe(true);
		});

		it('accepts observation content at exactly 5000 characters', () => {
			// Boundary check: exactly 5000 should pass
			const exactObs = 'b'.repeat(5000);
			const result = EntityInputSchema.safeParse({
				name: 'ValidName',
				entityType: 'test',
				observations: [exactObs],
			});
			expect(result.success).toBe(true);
		});

		it('accepts exactly 100 entities in create_entities', () => {
			// Boundary check: exactly 100 should pass, 101 should fail
			const maxEntities = Array.from({ length: 100 }, (_, i) => ({
				name: `Entity${i}`,
				entityType: 'test',
				observations: ['obs'],
			}));
			const result = CreateEntitiesInputSchema.safeParse({
				entities: maxEntities,
			});
			expect(result.success).toBe(true);
		});

		it('rejects observations array exceeding 100 items on a single entity', () => {
			// EntityInputSchema.observations has .max(100)
			const tooManyObs = Array.from({ length: 101 }, (_, i) => `observation ${i}`);
			const result = EntityInputSchema.safeParse({
				name: 'ValidName',
				entityType: 'test',
				observations: tooManyObs,
			});
			expect(result.success).toBe(false);
		});

		it('rejects search query that is empty', () => {
			// SearchNodesInputSchema.query has .min(1)
			const result = SearchNodesInputSchema.safeParse({
				query: '',
			});
			expect(result.success).toBe(false);
		});

		it('applies default limit of 40 when omitted in read_graph', () => {
			// ReadGraphInputSchema.limit has .default(40)
			const result = ReadGraphInputSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.limit).toBe(40);
			}
		});

		it('rejects limit of 0 in read_graph', () => {
			// ReadGraphInputSchema.limit has .min(1)
			const result = ReadGraphInputSchema.safeParse({ limit: 0 });
			expect(result.success).toBe(false);
		});

		it('rejects limit over 100 in read_graph', () => {
			// ReadGraphInputSchema.limit has .max(100)
			const result = ReadGraphInputSchema.safeParse({ limit: 101 });
			expect(result.success).toBe(false);
		});

		// ----- asOf parameter validation -----
		// All three temporal-aware tools (read_graph, search_nodes, open_nodes)
		// share the same AsOfSchema. These tests pin the contract: Z-suffix only,
		// optional, and rejects every common malformation a caller could send.

		it('accepts a valid Z-suffixed UTC timestamp on read_graph', () => {
			const result = ReadGraphInputSchema.safeParse({ asOf: '2026-04-11T12:00:00.000Z' });
			expect(result.success).toBe(true);
		});

		it('accepts a valid Z-suffixed UTC timestamp on search_nodes', () => {
			const result = SearchNodesInputSchema.safeParse({ query: 'foo', asOf: '2026-04-11T12:00:00.000Z' });
			expect(result.success).toBe(true);
		});

		it('accepts a valid Z-suffixed UTC timestamp on open_nodes', () => {
			const result = OpenNodesInputSchema.safeParse({ names: ['foo'], asOf: '2026-04-11T12:00:00.000Z' });
			expect(result.success).toBe(true);
		});

		it('rejects timestamp with non-UTC offset (+05:00) on read_graph', () => {
			// Offsets break lexicographic comparison against Z-suffixed stored values.
			// `.datetime({ offset: false })` enforces this.
			const result = ReadGraphInputSchema.safeParse({ asOf: '2026-04-11T12:00:00+05:00' });
			expect(result.success).toBe(false);
		});

		it('rejects timestamp with non-UTC offset (-08:00) on search_nodes', () => {
			const result = SearchNodesInputSchema.safeParse({ query: 'foo', asOf: '2026-04-11T12:00:00-08:00' });
			expect(result.success).toBe(false);
		});

		it('rejects timestamp with non-UTC offset on open_nodes', () => {
			const result = OpenNodesInputSchema.safeParse({ names: ['foo'], asOf: '2026-04-11T12:00:00+05:00' });
			expect(result.success).toBe(false);
		});

		it('rejects empty string asOf on read_graph', () => {
			// Empty-string contract: callers must omit asOf for current state, not send '';
			// the store layer also throws on '' as a defense-in-depth measure.
			const result = ReadGraphInputSchema.safeParse({ asOf: '' });
			expect(result.success).toBe(false);
		});

		it('rejects empty string asOf on search_nodes', () => {
			const result = SearchNodesInputSchema.safeParse({ query: 'foo', asOf: '' });
			expect(result.success).toBe(false);
		});

		it('rejects empty string asOf on open_nodes', () => {
			const result = OpenNodesInputSchema.safeParse({ names: ['foo'], asOf: '' });
			expect(result.success).toBe(false);
		});

		it('rejects malformed asOf (not ISO 8601) on read_graph', () => {
			const result = ReadGraphInputSchema.safeParse({ asOf: 'yesterday' });
			expect(result.success).toBe(false);
		});

		it('rejects date-only asOf (no time component) on search_nodes', () => {
			const result = SearchNodesInputSchema.safeParse({ query: 'foo', asOf: '2026-04-11' });
			expect(result.success).toBe(false);
		});

		it('accepts omitting asOf (treats as undefined / current state)', () => {
			const result = ReadGraphInputSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.asOf).toBeUndefined();
			}
		});
	});

	// ----------------------------------------------------------
	// Section 3: Output shape
	// Verifies paginated responses include nextCursor and totalCount,
	// matching what the tool handlers return.
	// ----------------------------------------------------------
	describe('output shape', () => {

		it('read_graph response includes nextCursor and totalCount', async () => {
			// Create a few entities so the graph isn't empty
			await store.createEntities([
				{ name: 'A', entityType: 't', observations: ['o1'] },
				{ name: 'B', entityType: 't', observations: ['o2'] },
			]);

			// Call readGraph with pagination params — same as the read_graph handler does
			const result = await store.readGraph(undefined, { limit: 40 });

			// Verify the paginated response shape
			expect(result).toHaveProperty('entities');
			expect(result).toHaveProperty('relations');
			expect(result).toHaveProperty('nextCursor');
			expect(result).toHaveProperty('totalCount');
			// With 2 entities and limit 40, everything fits on one page
			expect(result.totalCount).toBe(2);
			expect(result.nextCursor).toBeNull();
		});

		it('search_nodes response includes nextCursor and totalCount', async () => {
			await store.createEntities([
				{ name: 'SearchMe', entityType: 't', observations: ['searchable content'] },
			]);

			// Call searchNodes with pagination — same as the search_nodes handler does
			const result = await store.searchNodes('searchable', undefined, { limit: 40 });

			expect(result).toHaveProperty('nextCursor');
			expect(result).toHaveProperty('totalCount');
			expect(result.totalCount).toBe(1);
			expect(result.nextCursor).toBeNull();
		});

		it('read_graph returns nextCursor when more pages exist', async () => {
			// Create 3 entities, request with limit=2 → should have a next page
			await store.createEntities([
				{ name: 'P1', entityType: 't', observations: ['o'] },
				{ name: 'P2', entityType: 't', observations: ['o'] },
				{ name: 'P3', entityType: 't', observations: ['o'] },
			]);

			const firstPage = await store.readGraph(undefined, { limit: 2 });

			// First page should have 2 entities and a non-null cursor
			expect(firstPage.entities).toHaveLength(2);
			expect(firstPage.totalCount).toBe(3);
			expect(firstPage.nextCursor).not.toBeNull();

			// Second page should have 1 entity and no more pages
			const secondPage = await store.readGraph(undefined, {
				cursor: firstPage.nextCursor!,
				limit: 2,
			});
			expect(secondPage.entities).toHaveLength(1);
			expect(secondPage.nextCursor).toBeNull();
		});
	});

	// ----------------------------------------------------------
	// Section 4: Tool handler behavior (end-to-end)
	// Verifies full flows matching what tool handlers do:
	// input validation → normalization → store call → result shape.
	// ----------------------------------------------------------
	describe('tool handler behavior', () => {

		it('create_entities returns CreateEntitiesResult with created and skipped arrays', async () => {
			// First call: entity is new → should appear in "created"
			const result1 = await store.createEntities(
				[{ name: 'NewEntity', entityType: 'concept', observations: ['first obs'] }],
				normalizeProjectId('testproject')
			);
			expect(result1.created).toHaveLength(1);
			expect(result1.skipped).toHaveLength(0);
			expect(result1.created[0].name).toBe('NewEntity');
			expect(result1.created[0].project).toBe('testproject');

			// Verify created entity has timestamp fields
			expect(result1.created[0]).toHaveProperty('updatedAt');
			expect(result1.created[0]).toHaveProperty('createdAt');
			expect(result1.created[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(result1.created[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			// Verify observations have timestamps
			expect(result1.created[0].observations).toHaveLength(1);
			expect(result1.created[0].observations[0]).toHaveProperty('content');
			expect(result1.created[0].observations[0]).toHaveProperty('createdAt');

			// Second call: same name → should appear in "skipped"
			const result2 = await store.createEntities(
				[{ name: 'NewEntity', entityType: 'concept', observations: ['second obs'] }],
				normalizeProjectId('testproject')
			);
			expect(result2.created).toHaveLength(0);
			expect(result2.skipped).toHaveLength(1);
			expect(result2.skipped[0].name).toBe('NewEntity');
			expect(result2.skipped[0].existingProject).toBe('testproject');
		});

		it('list_projects returns project names from stored entities', async () => {
			// Start with no projects
			const emptyProjects = await store.listProjects();
			expect(emptyProjects).toHaveLength(0);

			// Create entities in two different projects
			await store.createEntities(
				[{ name: 'E1', entityType: 't', observations: ['o1'] }],
				normalizeProjectId('ProjectAlpha')
			);
			await store.createEntities(
				[{ name: 'E2', entityType: 't', observations: ['o2'] }],
				normalizeProjectId('ProjectBeta')
			);

			// list_projects should return both normalized project names
			const projects = await store.listProjects();
			expect(projects).toHaveLength(2);
			expect(projects).toContain('projectalpha');
			expect(projects).toContain('projectbeta');
		});

		it('delete_entities + read_graph confirms entities are gone', async () => {
			// Create entities
			const projectId = normalizeProjectId('cleanup-test');
			await store.createEntities([
				{ name: 'ToDelete', entityType: 'temp', observations: ['temporary data'] },
				{ name: 'ToKeep', entityType: 'permanent', observations: ['keep this'] },
			], projectId);

			// Verify both exist
			const beforeGraph = await store.readGraph(projectId, { limit: 40 });
			expect(beforeGraph.entities).toHaveLength(2);

			// Delete one entity — same as the delete_entities handler does
			await store.deleteEntities(['ToDelete']);

			// Verify only ToKeep remains
			const afterGraph = await store.readGraph(projectId, { limit: 40 });
			expect(afterGraph.entities).toHaveLength(1);
			expect(afterGraph.entities[0].name).toBe('ToKeep');
		});

		it('delete_entities also removes associated relations', async () => {
			const projectId = normalizeProjectId('relation-test');

			// Create two entities and a relation between them
			await store.createEntities([
				{ name: 'NodeA', entityType: 'item', observations: ['a'] },
				{ name: 'NodeB', entityType: 'item', observations: ['b'] },
			], projectId);
			await store.createRelations([
				{ from: 'NodeA', to: 'NodeB', relationType: 'links_to' },
			]);

			// Verify relation exists
			const beforeGraph = await store.readGraph(projectId, { limit: 40 });
			expect(beforeGraph.relations).toHaveLength(1);

			// Delete NodeA — its relations should be cleaned up
			await store.deleteEntities(['NodeA']);

			// Verify relation is gone
			const afterGraph = await store.readGraph(projectId, { limit: 40 });
			expect(afterGraph.relations).toHaveLength(0);
			// Only NodeB should remain
			expect(afterGraph.entities).toHaveLength(1);
			expect(afterGraph.entities[0].name).toBe('NodeB');
		});

		it('full handler simulation: validate → normalize → store → verify', async () => {
			// This test simulates the complete flow of a create_entities tool call,
			// from raw input validation through to verifying the stored result.

			// Step 1: Raw input as it would arrive from the MCP client
			const rawInput = {
				entities: [
					{ name: 'SimEntity', entityType: 'demo', observations: ['demo observation'] },
				],
				projectId: '  DemoProject  ',
			};

			// Step 2: Validate with Zod schema (same as the MCP SDK would do)
			const parseResult = CreateEntitiesInputSchema.safeParse(rawInput);
			expect(parseResult.success).toBe(true);
			if (!parseResult.success) return;  // type narrowing for TS

			// Note: Zod's .trim() on ProjectIdSchema trims the value during parsing
			const validatedInput = parseResult.data;

			// Step 3: Normalize projectId (same as the handler does)
			const normalizedProjectId = normalizeProjectId(validatedInput.projectId);
			expect(normalizedProjectId).toBe('demoproject');

			// Step 4: Call the store method (same as the handler does)
			const result = await store.createEntities(
				validatedInput.entities,
				normalizedProjectId
			);

			// Step 5: Verify the result matches expected output shape
			expect(result.created).toHaveLength(1);
			expect(result.created[0].name).toBe('SimEntity');
			expect(result.created[0].project).toBe('demoproject');
			expect(result.skipped).toHaveLength(0);

			// Step 6: Read back and verify data is accessible under normalized project
			const graph = await store.readGraph('demoproject', { limit: 40 });
			expect(graph.entities).toHaveLength(1);
			expect(graph.totalCount).toBe(1);
		});

		it('cross-project normalization: different casings converge on same project', async () => {
			// This tests a real-world scenario: an MCP client sends "MyProject" in one
			// call and "myproject" in another. The handler's normalizeProjectId ensures
			// they both map to the same scope.

			// First call with "MyProject"
			await store.createEntities(
				[{ name: 'E1', entityType: 't', observations: ['from MyProject'] }],
				normalizeProjectId('MyProject')
			);

			// Second call with "MYPROJECT"
			await store.createEntities(
				[{ name: 'E2', entityType: 't', observations: ['from MYPROJECT'] }],
				normalizeProjectId('MYPROJECT')
			);

			// Third call with "  myProject  " (whitespace + mixed case)
			await store.createEntities(
				[{ name: 'E3', entityType: 't', observations: ['from padded'] }],
				normalizeProjectId('  myProject  ')
			);

			// All three should be under "myproject"
			const graph = await store.readGraph('myproject', { limit: 40 });
			expect(graph.entities).toHaveLength(3);
			expect(graph.totalCount).toBe(3);

			// Only one project should exist
			const projects = await store.listProjects();
			expect(projects).toHaveLength(1);
			expect(projects[0]).toBe('myproject');
		});

		it('open_nodes returns entities and relations for specific nodes', async () => {
			const projectId = normalizeProjectId('open-test');

			// Create entities and relations
			await store.createEntities([
				{ name: 'Alpha', entityType: 'node', observations: ['alpha obs'] },
				{ name: 'Beta', entityType: 'node', observations: ['beta obs'] },
				{ name: 'Gamma', entityType: 'node', observations: ['gamma obs'] },
			], projectId);
			await store.createRelations([
				{ from: 'Alpha', to: 'Beta', relationType: 'connects' },
				{ from: 'Beta', to: 'Gamma', relationType: 'connects' },
			]);

			// Open just Alpha and Beta — should see their entities + relation between them
			const graph = await store.openNodes(['Alpha', 'Beta'], normalizeProjectId('open-test'));
			expect(graph.entities).toHaveLength(2);
			expect(graph.relations).toHaveLength(1);
			expect(graph.relations[0].from).toBe('Alpha');
			expect(graph.relations[0].to).toBe('Beta');

			// open_nodes returns KnowledgeGraph (not paginated), so no nextCursor/totalCount
			expect(graph).not.toHaveProperty('nextCursor');
			expect(graph).not.toHaveProperty('totalCount');
		});
	});

	// ----------------------------------------------------------
	// Section 5: entity_timeline tool handler
	// ----------------------------------------------------------
	describe('entity_timeline tool handler', () => {

		it('returns full timeline with superseded observations', async () => {
			const projectId = normalizeProjectId('timeline-test');
			await store.createEntities([
				{ name: 'TimelineEntity', entityType: 'concept', observations: ['version 1'] },
			], projectId);

			await store.supersedeObservations([
				{ entityName: 'TimelineEntity', oldContent: 'version 1', newContent: 'version 2' },
			]);

			const result = await store.entityTimeline(
				'TimelineEntity',
				normalizeProjectId('timeline-test')
			);

			expect(result).not.toBeNull();
			expect(result!.name).toBe('TimelineEntity');
			expect(result!.entityType).toBe('concept');
			expect(result!.project).toBe('timeline-test');
			expect(result!.observations).toHaveLength(2);

			const superseded = result!.observations.find(o => o.status === 'superseded');
			const active = result!.observations.find(o => o.status === 'active');

			expect(superseded).toBeDefined();
			expect(superseded!.content).toBe('version 1');
			expect(superseded!.supersededAt).not.toBe('');
			expect(superseded!.supersededAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			expect(active).toBeDefined();
			expect(active!.content).toBe('version 2');
			expect(active!.supersededAt).toBe('');
		});

		it('returns null for non-existent entity', async () => {
			const result = await store.entityTimeline(
				'DoesNotExist',
				normalizeProjectId('no-project')
			);
			expect(result).toBeNull();
		});

		it('includes temporal relations in timeline (active + superseded)', async () => {
			await store.createEntities([
				{ name: 'TimeA', entityType: 'test', observations: ['a'] },
				{ name: 'TimeB', entityType: 'test', observations: ['b'] },
			]);
			await store.createRelations([
				{ from: 'TimeA', to: 'TimeB', relationType: 'links_to' },
			]);
			await store.invalidateRelations([
				{ from: 'TimeA', to: 'TimeB', relationType: 'links_to' },
			]);
			await store.createRelations([
				{ from: 'TimeA', to: 'TimeB', relationType: 'links_to' },
			]);

			const timeline = await store.entityTimeline('TimeA');
			expect(timeline).not.toBeNull();
			expect(timeline!.relations).toHaveLength(2);

			const supersededRelations = timeline!.relations.filter(r => r.status === 'superseded');
			const activeRelations = timeline!.relations.filter(r => r.status === 'active');
			expect(supersededRelations).toHaveLength(1);
			expect(activeRelations).toHaveLength(1);
		});

		it('normalizes projectId before calling store', async () => {
			await store.createEntities([
				{ name: 'NormTimeline', entityType: 'node', observations: ['obs1'] },
			], normalizeProjectId('TimeProject'));

			const result = await store.entityTimeline(
				'NormTimeline',
				normalizeProjectId(' TIMEPROJECT ')
			);

			expect(result).not.toBeNull();
			expect(result!.name).toBe('NormTimeline');
			expect(result!.project).toBe('timeproject');
		});
	});

	// ----------------------------------------------------------
	// Section 6: invalidate_relations tool handler
	// ----------------------------------------------------------
	describe('invalidate_relations tool handler', () => {

		it('invalidates active relations and returns count', async () => {
			await store.createEntities([
				{ name: 'IR_A', entityType: 'test', observations: ['a'] },
				{ name: 'IR_B', entityType: 'test', observations: ['b'] },
			]);
			await store.createRelations([
				{ from: 'IR_A', to: 'IR_B', relationType: 'knows' },
			]);

			const changed = await store.invalidateRelations([
				{ from: 'IR_A', to: 'IR_B', relationType: 'knows' },
			]);
			expect(changed).toBe(1);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(0);
		});

		it('idempotent: already-invalidated relation returns 0', async () => {
			await store.createEntities([
				{ name: 'Idem_A', entityType: 'test', observations: ['a'] },
				{ name: 'Idem_B', entityType: 'test', observations: ['b'] },
			]);
			await store.createRelations([
				{ from: 'Idem_A', to: 'Idem_B', relationType: 'knows' },
			]);

			expect(await store.invalidateRelations([
				{ from: 'Idem_A', to: 'Idem_B', relationType: 'knows' },
			])).toBe(1);

			expect(await store.invalidateRelations([
				{ from: 'Idem_A', to: 'Idem_B', relationType: 'knows' },
			])).toBe(0);
		});

		it('reports actual vs requested counts for mixed batch', async () => {
			await store.createEntities([
				{ name: 'Mix_A', entityType: 'test', observations: ['a'] },
				{ name: 'Mix_B', entityType: 'test', observations: ['b'] },
				{ name: 'Mix_C', entityType: 'test', observations: ['c'] },
			]);
			await store.createRelations([
				{ from: 'Mix_A', to: 'Mix_B', relationType: 'rel1' },
				{ from: 'Mix_A', to: 'Mix_C', relationType: 'rel2' },
			]);

			// Pre-invalidate one
			await store.invalidateRelations([
				{ from: 'Mix_A', to: 'Mix_B', relationType: 'rel1' },
			]);

			const relations = [
				{ from: 'Mix_A', to: 'Mix_B', relationType: 'rel1' },
				{ from: 'Mix_A', to: 'Mix_C', relationType: 'rel2' },
			];
			const changed = await store.invalidateRelations(relations);
			expect(changed).toBe(1);

			// Verify handler message construction
			const requested = relations.length;
			const message = changed === requested
				? `Invalidated ${changed} relation(s).`
				: `Invalidated ${changed} of ${requested} relation(s) (${requested - changed} already inactive).`;
			expect(message).toBe('Invalidated 1 of 2 relation(s) (1 already inactive).');
		});

		it('returns 0 when invalidating non-existent relations', async () => {
			await store.createEntities([
				{ name: 'Ghost_A', entityType: 'test', observations: ['a'] },
				{ name: 'Ghost_B', entityType: 'test', observations: ['b'] },
			]);

			const changed = await store.invalidateRelations([
				{ from: 'Ghost_A', to: 'Ghost_B', relationType: 'nonexistent' },
			]);
			expect(changed).toBe(0);
		});

		it('handler message uses simple format when all succeed', async () => {
			await store.createEntities([
				{ name: 'All_A', entityType: 'test', observations: ['a'] },
				{ name: 'All_B', entityType: 'test', observations: ['b'] },
			]);
			await store.createRelations([
				{ from: 'All_A', to: 'All_B', relationType: 'r1' },
			]);

			const changed = await store.invalidateRelations([
				{ from: 'All_A', to: 'All_B', relationType: 'r1' },
			]);
			expect(changed).toBe(1);
			const message = changed === 1
				? `Invalidated ${changed} relation(s).`
				: `should not reach here`;
			expect(message).toBe('Invalidated 1 relation(s).');
		});
	});

	// ----------------------------------------------------------
	// Section 7: supersede_observations tool handler
	// ----------------------------------------------------------
	describe('supersede_observations tool handler', () => {

		it('supersedes observation and old is hidden from active queries', async () => {
			await store.createEntities([
				{ name: 'SupEntity', entityType: 'concept', observations: ['status: draft'] },
			], normalizeProjectId('sup-test'));

			await store.supersedeObservations([
				{ entityName: 'SupEntity', oldContent: 'status: draft', newContent: 'status: published' },
			]);

			const graph = await store.readGraph(normalizeProjectId('sup-test'), { limit: 40 });
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].observations).toHaveLength(1);
			expect(graph.entities[0].observations[0].content).toBe('status: published');
		});

		it('throws when old observation does not exist on entity', async () => {
			await store.createEntities([
				{ name: 'SupMissing', entityType: 'concept', observations: ['existing content'] },
			]);

			await expect(
				store.supersedeObservations([
					{ entityName: 'SupMissing', oldContent: 'wrong content', newContent: 'new content' },
				])
			).rejects.toThrow();
		});

		it('throws when entity does not exist', async () => {
			await expect(
				store.supersedeObservations([
					{ entityName: 'NoSuchEntity', oldContent: 'anything', newContent: 'anything else' },
				])
			).rejects.toThrow('not found');
		});

		it('superseded observation appears in timeline but not in readGraph', async () => {
			await store.createEntities([
				{ name: 'SupTimeline', entityType: 'test', observations: ['v1'] },
			]);

			await store.supersedeObservations([
				{ entityName: 'SupTimeline', oldContent: 'v1', newContent: 'v2' },
			]);

			const graph = await store.readGraph();
			const entity = graph.entities.find(e => e.name === 'SupTimeline');
			expect(entity).toBeDefined();
			expect(entity!.observations).toHaveLength(1);
			expect(entity!.observations[0].content).toBe('v2');

			const timeline = await store.entityTimeline('SupTimeline');
			expect(timeline).not.toBeNull();
			expect(timeline!.observations).toHaveLength(2);
			expect(timeline!.observations.find(o => o.status === 'superseded')!.content).toBe('v1');
			expect(timeline!.observations.find(o => o.status === 'active')!.content).toBe('v2');
		});

		it('Zod rejects empty oldContent', () => {
			const SupersessionsInputSchema = z.object({
				supersessions: z.array(z.object({
					entityName: z.string().min(1).max(500),
					oldContent: z.string().min(1).max(5000),
					newContent: z.string().min(1).max(5000),
				})).max(100),
			});

			const result = SupersessionsInputSchema.safeParse({
				supersessions: [{ entityName: 'E1', oldContent: '', newContent: 'new' }],
			});
			expect(result.success).toBe(false);
		});

		it('Zod rejects missing entityName', () => {
			const SupersessionsInputSchema = z.object({
				supersessions: z.array(z.object({
					entityName: z.string().min(1).max(500),
					oldContent: z.string().min(1).max(5000),
					newContent: z.string().min(1).max(5000),
				})).max(100),
			});

			const result = SupersessionsInputSchema.safeParse({
				supersessions: [{ oldContent: 'old', newContent: 'new' }],
			});
			expect(result.success).toBe(false);
		});
	});

	// ----------------------------------------------------------
	// Section 8: Error responses
	// ----------------------------------------------------------
	describe('error responses', () => {

		it('add_observations throws for non-existent entity', async () => {
			await expect(
				store.addObservations([
					{ entityName: 'EntityThatDoesNotExist', contents: ['some observation'] },
				])
			).rejects.toThrow('Entity with name EntityThatDoesNotExist not found');
		});

		it('add_observations rolls back entire batch when one entity missing', async () => {
			await store.createEntities([
				{ name: 'ValidEntity', entityType: 'test', observations: ['exists'] },
			]);

			await expect(
				store.addObservations([
					{ entityName: 'ValidEntity', contents: ['new obs'] },
					{ entityName: 'InvalidEntity', contents: ['will fail'] },
				])
			).rejects.toThrow('Entity with name InvalidEntity not found');

			// Transaction rolled back — ValidEntity should NOT have the new observation
			const graph = await store.readGraph();
			const entity = graph.entities.find(e => e.name === 'ValidEntity');
			expect(entity!.observations).toHaveLength(1);
			expect(entity!.observations[0].content).toBe('exists');
		});

		it('Zod rejects empty entityName in add_observations', () => {
			const AddObsSchema = z.object({
				observations: z.array(z.object({
					entityName: z.string().min(1).max(500),
					contents: z.array(z.string().min(1).max(5000)).max(100),
				})).max(100),
			});
			expect(AddObsSchema.safeParse({
				observations: [{ entityName: '', contents: ['obs'] }],
			}).success).toBe(false);
		});

		it('Zod rejects empty contents string in add_observations', () => {
			const AddObsSchema = z.object({
				observations: z.array(z.object({
					entityName: z.string().min(1).max(500),
					contents: z.array(z.string().min(1).max(5000)).max(100),
				})).max(100),
			});
			expect(AddObsSchema.safeParse({
				observations: [{ entityName: 'X', contents: [''] }],
			}).success).toBe(false);
		});

		it('Zod rejects empty from field in invalidate_relations', () => {
			const InvalidateSchema = z.object({
				relations: z.array(z.object({
					from: z.string().min(1).max(500),
					to: z.string().min(1).max(500),
					relationType: z.string().min(1).max(500),
				})).min(1).max(100),
			});
			expect(InvalidateSchema.safeParse({
				relations: [{ from: '', to: 'B', relationType: 'knows' }],
			}).success).toBe(false);
		});

		it('Zod rejects empty entityName in entity_timeline', () => {
			const TimelineSchema = z.object({
				entityName: z.string().min(1).max(500),
				projectId: ProjectIdSchema,
			});
			expect(TimelineSchema.safeParse({ entityName: '' }).success).toBe(false);
		});
	});

	// ----------------------------------------------------------
	// Section 9: create_entities skip signal
	// ----------------------------------------------------------
	describe('create_entities skip signal', () => {

		it('all entities already exist produces skip summary', async () => {
			const projectId = normalizeProjectId('skip-test');
			await store.createEntities([
				{ name: 'Existing1', entityType: 'test', observations: ['obs1'] },
				{ name: 'Existing2', entityType: 'test', observations: ['obs2'] },
			], projectId);

			const result = await store.createEntities([
				{ name: 'Existing1', entityType: 'test', observations: ['obs1'] },
				{ name: 'Existing2', entityType: 'test', observations: ['obs2'] },
			], projectId);

			expect(result.created).toHaveLength(0);
			expect(result.skipped).toHaveLength(2);
		});

		it('mixed batch reports created and skipped', async () => {
			const projectId = normalizeProjectId('mixed-skip');
			await store.createEntities([
				{ name: 'AlreadyHere', entityType: 'test', observations: ['old obs'] },
			], projectId);

			const result = await store.createEntities([
				{ name: 'AlreadyHere', entityType: 'test', observations: ['new obs'] },
				{ name: 'BrandNew', entityType: 'test', observations: ['fresh obs'] },
			], projectId);

			expect(result.created).toHaveLength(1);
			expect(result.created[0].name).toBe('BrandNew');
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0].name).toBe('AlreadyHere');
		});

		it('skipped entry includes existingProject for collision feedback', async () => {
			const projectId = normalizeProjectId('ProjectX');
			await store.createEntities([
				{ name: 'Singleton', entityType: 'unique', observations: ['data'] },
			], projectId);

			const result = await store.createEntities([
				{ name: 'Singleton', entityType: 'unique', observations: ['more data'] },
			], projectId);

			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0].name).toBe('Singleton');
			expect(result.skipped[0].existingProject).toBe('projectx');
		});
	});
});
