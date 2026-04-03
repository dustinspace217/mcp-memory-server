import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GraphStore, Relation } from '../types.js';
import { InvalidCursorError } from '../types.js';
import { JsonlStore, normalizeObservation } from '../jsonl-store.js';
import { SqliteStore } from '../sqlite-store.js';

// Resolve the directory containing this test file, used for temp file paths
const testDir = path.dirname(fileURLToPath(import.meta.url));

// Factory function type -- creates a store given a file path
type StoreFactory = (filePath: string) => GraphStore;

// ============================================================
// Section 1: Parameterized shared behavioral tests
// These run against BOTH JsonlStore and SqliteStore.
// ============================================================

describe.each<[string, string, StoreFactory]>([
	['JsonlStore', 'jsonl', (p) => new JsonlStore(p)],
	['SqliteStore', 'db', (p) => new SqliteStore(p)],
])('%s', (_storeName, ext, createStore) => {
	// `store` is the active store instance for each test
	let store: GraphStore;
	// `storePath` is the temp file path for this test run (unique per test via Date.now())
	let storePath: string;

	beforeEach(async () => {
		// Build a unique path so parallel tests don't collide
		storePath = path.join(testDir, `test-memory-${Date.now()}.${ext}`);
		store = createStore(storePath);
		await store.init();
	});

	afterEach(async () => {
		await store.close();
		// Clean up all possible sidecar files (JSONL temp, SQLite WAL/SHM)
		for (const suffix of ['', '.tmp', '-wal', '-shm']) {
			try { await fs.unlink(storePath + suffix); } catch { /* ignore */ }
		}
	});

	// ----------------------------------------------------------
	// createEntities
	// ----------------------------------------------------------
	describe('createEntities', () => {
		it('should create new entities', async () => {
			const { created: newEntities } = await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
				{ name: 'Bob', entityType: 'person', observations: ['likes programming'] },
			]);

			expect(newEntities).toHaveLength(2);
			expect(newEntities[0]).toEqual(expect.objectContaining({ name: 'Alice', entityType: 'person' }));
			expect(newEntities[0].observations).toHaveLength(1);
			expect(newEntities[0].observations[0]).toEqual(expect.objectContaining({ content: 'works at Acme Corp' }));
			expect(newEntities[0].observations[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(2);
		});

		it('should not create duplicate entities', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
			]);
			const { created: newEntities } = await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
			]);

			expect(newEntities).toHaveLength(0);

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
		});

		it('should handle empty entity arrays', async () => {
			const { created: newEntities } = await store.createEntities([]);
			expect(newEntities).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// createRelations
	// ----------------------------------------------------------
	describe('createRelations', () => {
		it('should create new relations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);

			const relations: Relation[] = [
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
			];

			const newRelations = await store.createRelations(relations);
			expect(newRelations).toHaveLength(1);
			expect(newRelations).toEqual(relations);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(1);
		});

		it('should not create duplicate relations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);

			const relations: Relation[] = [
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
			];

			await store.createRelations(relations);
			const newRelations = await store.createRelations(relations);

			expect(newRelations).toHaveLength(0);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(1);
		});

		it('should handle empty relation arrays', async () => {
			const newRelations = await store.createRelations([]);
			expect(newRelations).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// addObservations
	// ----------------------------------------------------------
	describe('addObservations', () => {
		it('should add observations to existing entities', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
			]);

			const results = await store.addObservations([
				{ entityName: 'Alice', contents: ['likes coffee', 'has a dog'] },
			]);

			expect(results).toHaveLength(1);
			expect(results[0].entityName).toBe('Alice');
			expect(results[0].addedObservations).toHaveLength(2);

			const graph = await store.readGraph();
			const alice = graph.entities.find(e => e.name === 'Alice');
			expect(alice?.observations).toHaveLength(3);
		});

		it('should not add duplicate observations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
			]);

			await store.addObservations([
				{ entityName: 'Alice', contents: ['likes coffee'] },
			]);

			const results = await store.addObservations([
				{ entityName: 'Alice', contents: ['likes coffee', 'has a dog'] },
			]);

			expect(results[0].addedObservations).toHaveLength(1);
			expect(results[0].addedObservations[0]).toEqual(expect.objectContaining({ content: 'has a dog' }));

			const graph = await store.readGraph();
			const alice = graph.entities.find(e => e.name === 'Alice');
			expect(alice?.observations).toHaveLength(3);
		});

		it('should throw error for non-existent entity', async () => {
			await expect(
				store.addObservations([
					{ entityName: 'NonExistent', contents: ['some observation'] },
				])
			).rejects.toThrow('Entity with name NonExistent not found');
		});
	});

	// ----------------------------------------------------------
	// deleteEntities
	// ----------------------------------------------------------
	describe('deleteEntities', () => {
		it('should delete entities', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);

			await store.deleteEntities(['Alice']);

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('Bob');
		});

		it('should cascade delete relations when deleting entities', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
				{ name: 'Charlie', entityType: 'person', observations: [] },
			]);

			await store.createRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
				{ from: 'Bob', to: 'Charlie', relationType: 'knows' },
			]);

			await store.deleteEntities(['Bob']);

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(2);
			expect(graph.relations).toHaveLength(0);
		});

		it('should handle deleting non-existent entities', async () => {
			await store.deleteEntities(['NonExistent']);
			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// deleteObservations
	// ----------------------------------------------------------
	describe('deleteObservations', () => {
		it('should delete observations from entities', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp', 'likes coffee'] },
			]);

			await store.deleteObservations([
				{ entityName: 'Alice', contents: ['likes coffee'] },
			]);

			const graph = await store.readGraph();
			const alice = graph.entities.find(e => e.name === 'Alice');
			expect(alice?.observations).toHaveLength(1);
			expect(alice?.observations[0]).toEqual(expect.objectContaining({ content: 'works at Acme Corp' }));
		});

		it('should handle deleting from non-existent entities', async () => {
			await store.deleteObservations([
				{ entityName: 'NonExistent', contents: ['some observation'] },
			]);
			// Should not throw error
			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// deleteRelations
	// ----------------------------------------------------------
	describe('deleteRelations', () => {
		it('should delete specific relations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);

			await store.createRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
				{ from: 'Alice', to: 'Bob', relationType: 'works_with' },
			]);

			await store.deleteRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
			]);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(1);
			expect(graph.relations[0].relationType).toBe('works_with');
		});
	});

	// ----------------------------------------------------------
	// readGraph
	// ----------------------------------------------------------
	describe('readGraph', () => {
		it('should return empty graph when file does not exist', async () => {
			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(0);
			expect(graph.relations).toHaveLength(0);
		});

		it('should return complete graph with entities and relations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
			]);

			await store.createRelations([
				{ from: 'Alice', to: 'Alice', relationType: 'self' },
			]);

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
			expect(graph.relations).toHaveLength(1);
		});

		it('should persist and load across instances', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['persistent data'] },
			]);

			// Close the current store and open a fresh instance on the same file
			await store.close();
			const store2 = createStore(storePath);
			await store2.init();
			const graph = await store2.readGraph();
			await store2.close();

			// Re-open so afterEach can close and clean up normally
			store = createStore(storePath);
			await store.init();

			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('Alice');
			expect(graph.entities[0].observations[0]).toEqual(expect.objectContaining({ content: 'persistent data' }));
			expect(graph.entities[0].observations[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	// ----------------------------------------------------------
	// searchNodes
	// ----------------------------------------------------------
	describe('searchNodes', () => {
		beforeEach(async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp', 'likes programming'] },
				{ name: 'Bob', entityType: 'person', observations: ['works at TechCo'] },
				{ name: 'Acme Corp', entityType: 'company', observations: ['tech company'] },
			]);

			await store.createRelations([
				{ from: 'Alice', to: 'Acme Corp', relationType: 'works_at' },
				{ from: 'Bob', to: 'Acme Corp', relationType: 'competitor' },
			]);
		});

		it('should search by entity name', async () => {
			const result = await store.searchNodes('Alice');
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('Alice');
		});

		it('should search by entity type', async () => {
			const result = await store.searchNodes('company');
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('Acme Corp');
		});

		it('should search by observation content', async () => {
			const result = await store.searchNodes('programming');
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('Alice');
		});

		it('should be case insensitive', async () => {
			const result = await store.searchNodes('ALICE');
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('Alice');
		});

		it('should include relations where at least one endpoint matches', async () => {
			const result = await store.searchNodes('Acme');
			expect(result.entities).toHaveLength(2); // Alice and Acme Corp
			// Both relations included: Alice → Acme Corp (Alice matched) and Bob → Acme Corp (Acme Corp matched)
			expect(result.relations).toHaveLength(2);
		});

		it('should include outgoing relations to unmatched entities', async () => {
			const result = await store.searchNodes('Alice');
			expect(result.entities).toHaveLength(1);
			// Alice → Acme Corp relation included because Alice is the source
			expect(result.relations).toHaveLength(1);
			expect(result.relations[0].from).toBe('Alice');
			expect(result.relations[0].to).toBe('Acme Corp');
		});

		it('should return empty graph for no matches', async () => {
			const result = await store.searchNodes('NonExistent');
			expect(result.entities).toHaveLength(0);
			expect(result.relations).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// openNodes
	// ----------------------------------------------------------
	describe('openNodes', () => {
		beforeEach(async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
				{ name: 'Charlie', entityType: 'person', observations: [] },
			]);

			await store.createRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
				{ from: 'Bob', to: 'Charlie', relationType: 'knows' },
			]);
		});

		it('should open specific nodes by name', async () => {
			const result = await store.openNodes(['Alice', 'Bob']);
			expect(result.entities).toHaveLength(2);
			expect(result.entities.map(e => e.name)).toContain('Alice');
			expect(result.entities.map(e => e.name)).toContain('Bob');
		});

		it('should include all relations connected to opened nodes', async () => {
			const result = await store.openNodes(['Alice', 'Bob']);
			// Alice → Bob (both endpoints opened) and Bob → Charlie (Bob is opened)
			expect(result.relations).toHaveLength(2);
			expect(result.relations.some(r => r.from === 'Alice' && r.to === 'Bob')).toBe(true);
			expect(result.relations.some(r => r.from === 'Bob' && r.to === 'Charlie')).toBe(true);
		});

		it('should include relations connected to opened nodes', async () => {
			const result = await store.openNodes(['Bob']);
			// Bob has two relations: Alice → Bob and Bob → Charlie
			expect(result.relations).toHaveLength(2);
			expect(result.relations.some(r => r.from === 'Alice' && r.to === 'Bob')).toBe(true);
			expect(result.relations.some(r => r.from === 'Bob' && r.to === 'Charlie')).toBe(true);
		});

		it('should include outgoing relations to nodes not in the open set', async () => {
			// This is the core bug fix for #3137: open_nodes should return
			// relations FROM the opened node, even if the target is not opened
			const result = await store.openNodes(['Alice']);
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('Alice');
			// Alice → Bob relation is included because Alice is opened
			expect(result.relations).toHaveLength(1);
			expect(result.relations[0].from).toBe('Alice');
			expect(result.relations[0].to).toBe('Bob');
		});

		it('should include incoming relations from nodes not in the open set', async () => {
			const result = await store.openNodes(['Charlie']);
			expect(result.entities).toHaveLength(1);
			// Bob → Charlie relation is included because Charlie is opened
			expect(result.relations).toHaveLength(1);
			expect(result.relations[0].from).toBe('Bob');
			expect(result.relations[0].to).toBe('Charlie');
		});

		it('should handle opening non-existent nodes', async () => {
			const result = await store.openNodes(['NonExistent']);
			expect(result.entities).toHaveLength(0);
		});

		it('should handle empty node list', async () => {
			const result = await store.openNodes([]);
			expect(result.entities).toHaveLength(0);
			expect(result.relations).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// project filtering
	// ----------------------------------------------------------
	describe('project filtering', () => {
		it('should tag entities with projectId on create', async () => {
			const result = await store.createEntities(
				[{ name: 'ProjectEntity', entityType: 'test', observations: ['obs1'] }],
				'my-project'
			);
			expect(result.created).toHaveLength(1);
			expect(result.created[0].project).toBe('my-project');
			expect(result.skipped).toHaveLength(0);
		});

		it('should set project to null when projectId omitted', async () => {
			const result = await store.createEntities([
				{ name: 'GlobalEntity', entityType: 'test', observations: ['obs1'] },
			]);
			expect(result.created).toHaveLength(1);
			expect(result.created[0].project).toBeNull();
		});

		it('should normalize projectId to lowercase and trimmed', async () => {
			const result = await store.createEntities(
				[{ name: 'NormEntity', entityType: 'test', observations: ['obs1'] }],
				'  My-Project  '
			);
			expect(result.created[0].project).toBe('my-project');
		});

		it('should report skipped entities with existing project info', async () => {
			await store.createEntities(
				[{ name: 'Shared', entityType: 'test', observations: ['obs1'] }],
				'project-a'
			);
			const result = await store.createEntities(
				[{ name: 'Shared', entityType: 'test', observations: ['obs2'] }],
				'project-b'
			);
			expect(result.created).toHaveLength(0);
			expect(result.skipped).toHaveLength(1);
			expect(result.skipped[0]).toEqual({ name: 'Shared', existingProject: 'project-a' });
		});

		it('should filter readGraph by project + globals', async () => {
			await store.createEntities(
				[{ name: 'A', entityType: 'test', observations: ['a'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'B', entityType: 'test', observations: ['b'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'G', entityType: 'test', observations: ['global'] },
			]);

			const filtered = await store.readGraph('proj-1');
			const names = filtered.entities.map(e => e.name).sort();
			expect(names).toEqual(['A', 'G']);
		});

		it('should return entire graph when readGraph has no projectId', async () => {
			await store.createEntities(
				[{ name: 'A', entityType: 'test', observations: ['a'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'B', entityType: 'test', observations: ['b'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'G', entityType: 'test', observations: ['global'] },
			]);

			const all = await store.readGraph();
			expect(all.entities).toHaveLength(3);
		});

		it('should filter searchNodes by project + globals', async () => {
			await store.createEntities(
				[{ name: 'Alpha', entityType: 'test', observations: ['shared keyword'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'Beta', entityType: 'test', observations: ['shared keyword'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'Gamma', entityType: 'test', observations: ['shared keyword'] },
			]);

			const result = await store.searchNodes('shared', 'proj-1');
			const names = result.entities.map(e => e.name).sort();
			expect(names).toEqual(['Alpha', 'Gamma']);
		});

		it('should search entire graph when searchNodes has no projectId', async () => {
			await store.createEntities(
				[{ name: 'Alpha', entityType: 'test', observations: ['keyword'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'Beta', entityType: 'test', observations: ['keyword'] }],
				'proj-2'
			);

			const result = await store.searchNodes('keyword');
			expect(result.entities).toHaveLength(2);
		});

		it('should filter openNodes by project + globals', async () => {
			await store.createEntities(
				[{ name: 'X', entityType: 'test', observations: ['x'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'Y', entityType: 'test', observations: ['y'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'Z', entityType: 'test', observations: ['z'] },
			]);

			const result = await store.openNodes(['X', 'Y', 'Z'], 'proj-1');
			const names = result.entities.map(e => e.name).sort();
			expect(names).toEqual(['X', 'Z']);
		});

		it('should return all requested entities when openNodes has no projectId', async () => {
			await store.createEntities(
				[{ name: 'X', entityType: 'test', observations: ['x'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'Y', entityType: 'test', observations: ['y'] }],
				'proj-2'
			);

			const result = await store.openNodes(['X', 'Y']);
			expect(result.entities).toHaveLength(2);
		});

		it('should only include relations where both endpoints are in the result set', async () => {
			await store.createEntities(
				[{ name: 'P1', entityType: 'test', observations: ['p1'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'P2', entityType: 'test', observations: ['p2'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'Global', entityType: 'test', observations: ['g'] },
			]);
			await store.createRelations([
				{ from: 'P1', to: 'Global', relationType: 'uses' },
				{ from: 'P1', to: 'P2', relationType: 'cross_project' },
				{ from: 'P2', to: 'Global', relationType: 'also_uses' },
			]);

			const result = await store.readGraph('proj-1');
			expect(result.entities.map(e => e.name).sort()).toEqual(['Global', 'P1']);
			expect(result.relations).toHaveLength(1);
			expect(result.relations[0]).toEqual(
				expect.objectContaining({ from: 'P1', to: 'Global', relationType: 'uses' })
			);
		});

		it('should exclude cross-project relations from searchNodes with projectId', async () => {
			// Create entities in two projects plus a global entity
			await store.createEntities(
				[{ name: 'SearchP1', entityType: 'test', observations: ['searchable'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'SearchP2', entityType: 'test', observations: ['searchable'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'SearchGlobal', entityType: 'test', observations: ['searchable'] },
			]);
			await store.createRelations([
				{ from: 'SearchP1', to: 'SearchGlobal', relationType: 'uses' },
				{ from: 'SearchP1', to: 'SearchP2', relationType: 'cross_project' },
			]);

			// searchNodes with proj-1 should return P1 + Global (both match "searchable"),
			// and only the P1->Global relation (AND logic: both endpoints in result set)
			const result = await store.searchNodes('searchable', 'proj-1');
			const names = result.entities.map(e => e.name).sort();
			expect(names).toEqual(['SearchGlobal', 'SearchP1']);
			expect(result.relations).toHaveLength(1);
			expect(result.relations[0]).toEqual(
				expect.objectContaining({ from: 'SearchP1', to: 'SearchGlobal', relationType: 'uses' })
			);
		});

		it('should exclude cross-project relations from openNodes with projectId', async () => {
			// Create entities in two projects plus a global entity
			await store.createEntities(
				[{ name: 'OpenP1', entityType: 'test', observations: ['o1'] }],
				'proj-1'
			);
			await store.createEntities(
				[{ name: 'OpenP2', entityType: 'test', observations: ['o2'] }],
				'proj-2'
			);
			await store.createEntities([
				{ name: 'OpenGlobal', entityType: 'test', observations: ['og'] },
			]);
			await store.createRelations([
				{ from: 'OpenP1', to: 'OpenGlobal', relationType: 'uses' },
				{ from: 'OpenP1', to: 'OpenP2', relationType: 'cross_project' },
			]);

			// openNodes with proj-1 scope: request all 3 by name, should only get P1 + Global
			const result = await store.openNodes(['OpenP1', 'OpenP2', 'OpenGlobal'], 'proj-1');
			const names = result.entities.map(e => e.name).sort();
			expect(names).toEqual(['OpenGlobal', 'OpenP1']);
			expect(result.relations).toHaveLength(1);
			expect(result.relations[0]).toEqual(
				expect.objectContaining({ from: 'OpenP1', to: 'OpenGlobal', relationType: 'uses' })
			);
		});

		it('should list distinct project names sorted alphabetically', async () => {
			await store.createEntities(
				[{ name: 'A', entityType: 'test', observations: ['a'] }],
				'zebra'
			);
			await store.createEntities(
				[{ name: 'B', entityType: 'test', observations: ['b'] }],
				'alpha'
			);
			await store.createEntities([
				{ name: 'C', entityType: 'test', observations: ['c'] },
			]);

			const projects = await store.listProjects();
			expect(projects).toEqual(['alpha', 'zebra']);
		});

		it('should return empty array from listProjects on empty database', async () => {
			const projects = await store.listProjects();
			expect(projects).toEqual([]);
		});

		it('should persist project field across store restarts', async () => {
			await store.createEntities(
				[{ name: 'Persistent', entityType: 'test', observations: ['data'] }],
				'my-project'
			);

			await store.close();
			const store2 = createStore(storePath);
			await store2.init();
			const graph = await store2.readGraph();
			await store2.close();

			// Re-open so afterEach can close and clean up normally
			store = createStore(storePath);
			await store.init();

			expect(graph.entities[0].project).toBe('my-project');
		});
	});

	// ----------------------------------------------------------
	// observation timestamps (shared subset)
	// ----------------------------------------------------------
	describe('observation timestamps', () => {
		it('should assign ISO 8601 timestamps to observations created via createEntities', async () => {
			const before = new Date().toISOString();
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
			]);
			const after = new Date().toISOString();

			const graph = await store.readGraph();
			const obs = graph.entities[0].observations[0];
			expect(obs.content).toBe('works at Acme');
			expect(obs.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
			expect(obs.createdAt >= before).toBe(true);
			expect(obs.createdAt <= after).toBe(true);
		});

		it('should assign ISO 8601 timestamps to observations added via addObservations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
			]);

			const before = new Date().toISOString();
			await store.addObservations([
				{ entityName: 'Alice', contents: ['likes coffee'] },
			]);
			const after = new Date().toISOString();

			const graph = await store.readGraph();
			const obs = graph.entities[0].observations[0];
			expect(obs.content).toBe('likes coffee');
			expect(obs.createdAt >= before).toBe(true);
			expect(obs.createdAt <= after).toBe(true);
		});

		it('should preserve timestamps across save/load cycles', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['test'] },
			]);

			const graph1 = await store.readGraph();
			const timestamp1 = graph1.entities[0].observations[0].createdAt;

			// Close and re-open to force a real disk round-trip
			await store.close();
			const store2 = createStore(storePath);
			await store2.init();
			const graph2 = await store2.readGraph();
			const timestamp2 = graph2.entities[0].observations[0].createdAt;
			await store2.close();

			// Re-open so afterEach can close and clean up normally
			store = createStore(storePath);
			await store.init();

			expect(timestamp2).toBe(timestamp1);
		});

		it('should deduplicate by content when adding to entities with timestamped observations', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['existing'] },
			]);

			const results = await store.addObservations([
				{ entityName: 'Alice', contents: ['existing', 'new one'] },
			]);

			expect(results[0].addedObservations).toHaveLength(1);
			expect(results[0].addedObservations[0].content).toBe('new one');
		});

		it('should delete observations by content string even with timestamps', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['keep this', 'delete this'] },
			]);

			await store.deleteObservations([
				{ entityName: 'Alice', contents: ['delete this'] },
			]);

			const graph = await store.readGraph();
			const alice = graph.entities[0];
			expect(alice.observations).toHaveLength(1);
			expect(alice.observations[0].content).toBe('keep this');
		});

		it('should search observation content with timestamps', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
				{ name: 'Bob', entityType: 'person', observations: ['works at TechCo'] },
			]);

			const result = await store.searchNodes('Acme');
			expect(result.entities).toHaveLength(1);
			expect(result.entities[0].name).toBe('Alice');
		});
	});

	// ----------------------------------------------------------
	// entity timestamps (updatedAt / createdAt on Entity objects)
	// ----------------------------------------------------------
	describe('entity timestamps', () => {
		// Verifies that both updatedAt and createdAt are set on newly created entities,
		// that they are valid ISO 8601 strings, and that they fall within the
		// before/after window of the createEntities call.
		it('should set updatedAt and createdAt on entity creation', async () => {
			const before = new Date().toISOString();
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['test'] },
			]);
			const after = new Date().toISOString();

			// Read back the graph and pull out the entity we just created
			const graph = await store.readGraph();
			const alice = graph.entities[0];

			// Both timestamps should be ISO 8601 format
			expect(alice.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(alice.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			// updatedAt should fall within the before/after window
			expect(alice.updatedAt >= before).toBe(true);
			expect(alice.updatedAt <= after).toBe(true);

			// On creation, createdAt and updatedAt should be identical
			expect(alice.createdAt).toBe(alice.updatedAt);
		});

		// Verifies that adding an observation bumps updatedAt but leaves createdAt unchanged
		it('should bump updatedAt when observations are added', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['initial'] },
			]);
			const graph1 = await store.readGraph();
			// Capture the original timestamps from the freshly created entity
			const originalUpdatedAt = graph1.entities[0].updatedAt;
			const originalCreatedAt = graph1.entities[0].createdAt;

			// Small delay so timestamps differ
			await new Promise(r => setTimeout(r, 10));

			await store.addObservations([
				{ entityName: 'Alice', contents: ['new observation'] },
			]);

			const graph2 = await store.readGraph();
			const alice = graph2.entities[0];
			// updatedAt should have advanced past the original value
			expect(alice.updatedAt > originalUpdatedAt).toBe(true);
			// createdAt should remain unchanged — it records when the entity was born
			expect(alice.createdAt).toBe(originalCreatedAt);
		});

		// Verifies that deleting an observation bumps updatedAt
		it('should bump updatedAt when observations are deleted', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['keep', 'remove'] },
			]);
			const graph1 = await store.readGraph();
			const originalUpdatedAt = graph1.entities[0].updatedAt;

			// Small delay so timestamps differ
			await new Promise(r => setTimeout(r, 10));

			await store.deleteObservations([
				{ entityName: 'Alice', contents: ['remove'] },
			]);

			const graph2 = await store.readGraph();
			// updatedAt should be newer than the original after the observation was deleted
			expect(graph2.entities[0].updatedAt > originalUpdatedAt).toBe(true);
		});

		// Verifies that creating relations does NOT touch entity timestamps —
		// relations are a separate concern from the entity's own data
		it('should NOT bump updatedAt when relations are created', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);
			const graph1 = await store.readGraph();
			// Grab Alice's updatedAt before adding a relation
			const aliceUpdatedAt = graph1.entities.find(e => e.name === 'Alice')!.updatedAt;

			// Small delay so any accidental timestamp bump would be detectable
			await new Promise(r => setTimeout(r, 10));

			await store.createRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
			]);

			const graph2 = await store.readGraph();
			// Alice's updatedAt should be identical — relations don't mutate entities
			expect(graph2.entities.find(e => e.name === 'Alice')!.updatedAt).toBe(aliceUpdatedAt);
		});

		// Verifies that entity timestamps survive a close/reopen cycle —
		// they are persisted to disk, not just held in memory
		it('should persist timestamps across store restarts', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['test'] },
			]);
			const graph1 = await store.readGraph();
			const originalUpdatedAt = graph1.entities[0].updatedAt;
			const originalCreatedAt = graph1.entities[0].createdAt;

			// Close the current store, open a fresh instance from the same path
			await store.close();
			const store2 = createStore(storePath);
			await store2.init();
			const graph2 = await store2.readGraph();
			await store2.close();

			// Re-open so afterEach can close and clean up normally
			store = createStore(storePath);
			await store.init();

			// Timestamps should survive the round-trip through disk
			expect(graph2.entities[0].updatedAt).toBe(originalUpdatedAt);
			expect(graph2.entities[0].createdAt).toBe(originalCreatedAt);
		});
	});

	// ----------------------------------------------------------
	// pagination
	// ----------------------------------------------------------
	describe('pagination', () => {
		/**
		 * Helper: create N entities with staggered timestamps.
		 * Each entity is created in a separate call with a small delay between them,
		 * so updatedAt values are guaranteed to differ (needed for cursor-based ordering).
		 *
		 * @param store - The GraphStore to create entities in
		 * @param count - How many entities to create (named Entity-000, Entity-001, ...)
		 * @param projectId - Optional project scope for all created entities
		 */
		async function createStaggeredEntities(store: GraphStore, count: number, projectId?: string): Promise<void> {
			for (let i = 0; i < count; i++) {
				await store.createEntities(
					[{ name: `Entity-${String(i).padStart(3, '0')}`, entityType: 'test', observations: [`obs for ${i}`] }],
					projectId,
				);
				// Small delay so updatedAt values differ — 5ms is enough for unique millisecond timestamps
				if (i < count - 1) {
					await new Promise(r => setTimeout(r, 5));
				}
			}
		}

		// Verifies that when all entities fit in a single page, nextCursor is null
		// and totalCount matches the entity count
		it('should return all entities with nextCursor null when count <= limit', async () => {
			await createStaggeredEntities(store, 3);

			const result = await store.readGraph(undefined, { limit: 10 });
			expect(result.entities).toHaveLength(3);
			expect(result.nextCursor).toBeNull();
			expect(result.totalCount).toBe(3);
		});

		// Verifies that readGraph paginates correctly with explicit limit=40
		// (the default page size). Creates 45 entities so it spans two pages.
		// Note: store.readGraph() without pagination returns ALL entities (backward compat),
		// so we pass { limit: 40 } explicitly to activate pagination.
		it('should paginate readGraph with explicit limit', async () => {
			// Create more entities than the default page size (40)
			await createStaggeredEntities(store, 45);

			// Pass limit=40 explicitly — readGraph() without pagination returns everything
			const page1 = await store.readGraph(undefined, { limit: 40 });
			expect(page1.entities).toHaveLength(40);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.totalCount).toBe(45);

			const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 40 });
			expect(page2.entities).toHaveLength(5);
			expect(page2.nextCursor).toBeNull();
			expect(page2.totalCount).toBe(45);
		});

		// Verifies that custom limit values work correctly across multiple pages
		it('should paginate with custom limit', async () => {
			await createStaggeredEntities(store, 10);

			// Page through 10 entities, 3 at a time
			const page1 = await store.readGraph(undefined, { limit: 3 });
			expect(page1.entities).toHaveLength(3);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.totalCount).toBe(10);

			const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 3 });
			expect(page2.entities).toHaveLength(3);
			expect(page2.nextCursor).not.toBeNull();

			const page3 = await store.readGraph(undefined, { cursor: page2.nextCursor!, limit: 3 });
			expect(page3.entities).toHaveLength(3);
			expect(page3.nextCursor).not.toBeNull();

			// Last page: only 1 remaining entity
			const page4 = await store.readGraph(undefined, { cursor: page3.nextCursor!, limit: 3 });
			expect(page4.entities).toHaveLength(1);
			expect(page4.nextCursor).toBeNull();
		});

		// Verifies that entities are sorted by most recently updated first (DESC order)
		it('should return entities sorted by most recently updated first', async () => {
			await createStaggeredEntities(store, 5);

			const result = await store.readGraph(undefined, { limit: 5 });
			// Most recently created entity should be first (Entity-004, created last)
			expect(result.entities[0].name).toBe('Entity-004');
			// Oldest entity should be last (Entity-000, created first)
			expect(result.entities[4].name).toBe('Entity-000');
		});

		// Verifies that paginating through the entire dataset produces no duplicates.
		// Each entity should appear on exactly one page.
		it('should not return duplicate entities across pages', async () => {
			await createStaggeredEntities(store, 10);

			const allNames: string[] = [];
			let cursor: string | undefined;

			// Paginate through everything with limit=3
			for (let page = 0; page < 10; page++) {
				const result = await store.readGraph(undefined, { cursor, limit: 3 });
				allNames.push(...result.entities.map(e => e.name));
				if (!result.nextCursor) break;
				cursor = result.nextCursor;
			}

			expect(allNames).toHaveLength(10);
			// Set dedup: if any name appears twice, the Set would be smaller
			expect(new Set(allNames).size).toBe(10);
		});

		// Verifies that searchNodes also supports pagination (same cursor mechanism)
		it('should paginate searchNodes', async () => {
			await createStaggeredEntities(store, 10);

			const page1 = await store.searchNodes('Entity', undefined, { limit: 3 });
			expect(page1.entities).toHaveLength(3);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.totalCount).toBe(10);

			const page2 = await store.searchNodes('Entity', undefined, { cursor: page1.nextCursor!, limit: 3 });
			expect(page2.entities).toHaveLength(3);
			expect(page2.nextCursor).not.toBeNull();
		});

		// Verifies that pagination respects project filtering —
		// proj-a entities + global entities should be included, but not proj-b entities
		it('should respect project filter during pagination', async () => {
			await createStaggeredEntities(store, 5, 'proj-a');
			// Create 3 global entities with unique names (can't reuse Entity-00N — names are globally unique)
			await store.createEntities([
				{ name: 'Global-1', entityType: 'test', observations: ['g1'] },
				{ name: 'Global-2', entityType: 'test', observations: ['g2'] },
				{ name: 'Global-3', entityType: 'test', observations: ['g3'] },
			]);

			const result = await store.readGraph('proj-a', { limit: 100 });
			// Should include proj-a entities + global entities
			const projANames = result.entities.filter(e => e.project === 'proj-a').map(e => e.name);
			const globalNames = result.entities.filter(e => e.project === null).map(e => e.name);
			expect(projANames).toHaveLength(5);
			expect(globalNames.length).toBeGreaterThanOrEqual(3);
		});

		// Verifies that a completely garbled cursor string throws InvalidCursorError
		it('should throw InvalidCursorError for malformed cursor', async () => {
			await expect(
				store.readGraph(undefined, { cursor: 'not-valid-base64!!!' })
			).rejects.toThrow(InvalidCursorError);
		});

		// Verifies that a cursor generated by readGraph cannot be used with searchNodes —
		// the cursor encodes the query context, so cross-method usage is rejected
		it('should throw InvalidCursorError for cursor from different query', async () => {
			await createStaggeredEntities(store, 5);

			const page1 = await store.readGraph(undefined, { limit: 2 });
			expect(page1.nextCursor).not.toBeNull();

			// Use readGraph cursor with searchNodes — should fail because query context differs
			await expect(
				store.searchNodes('Entity', undefined, { cursor: page1.nextCursor! })
			).rejects.toThrow(InvalidCursorError);
		});

		// Verifies that a cursor from one project cannot be reused with a different project —
		// the cursor encodes the projectId, so cross-project usage is rejected
		it('should throw InvalidCursorError for cursor from different projectId', async () => {
			await createStaggeredEntities(store, 5, 'proj-a');
			await store.createEntities(
				[{ name: 'B-Entity', entityType: 'test', observations: ['b'] }],
				'proj-b',
			);

			const page1 = await store.readGraph('proj-a', { limit: 2 });
			expect(page1.nextCursor).not.toBeNull();

			// Use proj-a cursor with proj-b — should fail because projectId differs
			await expect(
				store.readGraph('proj-b', { cursor: page1.nextCursor! })
			).rejects.toThrow(InvalidCursorError);
		});

		// Verifies that requesting a limit > 100 is clamped to the max (100)
		it('should clamp limit to max 100', async () => {
			await createStaggeredEntities(store, 5);

			// Requesting limit=200 should be clamped to 100 (but we only have 5 entities,
			// so the result will have 5 — the point is it doesn't throw)
			const result = await store.readGraph(undefined, { limit: 200 });
			expect(result.entities).toHaveLength(5);
			expect(result.nextCursor).toBeNull();
		});

		// Verifies that only relations where BOTH endpoints are in the current page
		// are included. Cross-page relations (one endpoint per page) are excluded.
		it('should return only relations where both endpoints are in current page', async () => {
			// Create 4 entities with relations spanning pages
			await store.createEntities([
				{ name: 'A', entityType: 'test', observations: ['a'] },
			]);
			await new Promise(r => setTimeout(r, 10));
			await store.createEntities([
				{ name: 'B', entityType: 'test', observations: ['b'] },
			]);
			await new Promise(r => setTimeout(r, 10));
			await store.createEntities([
				{ name: 'C', entityType: 'test', observations: ['c'] },
			]);
			await new Promise(r => setTimeout(r, 10));
			await store.createEntities([
				{ name: 'D', entityType: 'test', observations: ['d'] },
			]);

			await store.createRelations([
				{ from: 'A', to: 'B', relationType: 'knows' },    // Both on page 2
				{ from: 'C', to: 'D', relationType: 'knows' },    // Both on page 1
				{ from: 'B', to: 'D', relationType: 'cross' },    // Spans pages
			]);

			// Page 1 (limit=2): D and C (most recent first)
			const page1 = await store.readGraph(undefined, { limit: 2 });
			expect(page1.entities.map(e => e.name)).toEqual(['D', 'C']);
			// Only C->D relation should appear (both endpoints on this page)
			expect(page1.relations).toHaveLength(1);
			expect(page1.relations[0]).toEqual(expect.objectContaining({ from: 'C', to: 'D' }));

			// Page 2 (limit=2): B and A (older entities)
			const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 2 });
			expect(page2.entities.map(e => e.name)).toEqual(['B', 'A']);
			// Only A->B relation should appear (both endpoints on this page)
			expect(page2.relations).toHaveLength(1);
			expect(page2.relations[0]).toEqual(expect.objectContaining({ from: 'A', to: 'B' }));
			// B->D relation is NOT on either page (endpoints span pages)
		});

		// Verifies that pagination on an empty graph returns sensible defaults
		it('should handle empty graph with pagination', async () => {
			const result = await store.readGraph(undefined, { limit: 10 });
			expect(result.entities).toHaveLength(0);
			expect(result.relations).toHaveLength(0);
			expect(result.nextCursor).toBeNull();
			expect(result.totalCount).toBe(0);
		});

		// Verifies that totalCount reflects the FULL result set, not just the current page,
		// and remains consistent across pages
		it('should return totalCount reflecting full result set', async () => {
			await createStaggeredEntities(store, 15);

			const page1 = await store.readGraph(undefined, { limit: 5 });
			expect(page1.totalCount).toBe(15);

			const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 5 });
			expect(page2.totalCount).toBe(15);
		});

		// --- Test gaps filled from Phase 4 review (issue #39) ---

		// Verifies full traversal of searchNodes pagination — collects ALL entities
		// across every page and ensures no duplicates and no missing entities
		it('should traverse all searchNodes pages without duplicates', async () => {
			await createStaggeredEntities(store, 10);

			const allNames: string[] = [];
			let cursor: string | undefined;

			// Paginate through all search results with limit=3
			for (let page = 0; page < 10; page++) {
				const result = await store.searchNodes('Entity', undefined, { cursor, limit: 3 });
				allNames.push(...result.entities.map(e => e.name));
				if (!result.nextCursor) break;
				cursor = result.nextCursor;
			}

			expect(allNames).toHaveLength(10);
			expect(new Set(allNames).size).toBe(10);
		});

		// Verifies limit=1 works correctly as a minimum page size — each page
		// should have exactly 1 entity, and full traversal yields all entities
		it('should paginate with limit=1 (minimum page size)', async () => {
			await createStaggeredEntities(store, 5);

			const allNames: string[] = [];
			let cursor: string | undefined;

			for (let page = 0; page < 10; page++) {
				const result = await store.readGraph(undefined, { cursor, limit: 1 });
				expect(result.entities).toHaveLength(page < 5 ? 1 : 0);
				allNames.push(...result.entities.map(e => e.name));
				if (!result.nextCursor) break;
				cursor = result.nextCursor;
			}

			expect(allNames).toHaveLength(5);
			expect(new Set(allNames).size).toBe(5);
		});

		// Verifies the exact boundary where count == limit — when the entity count
		// exactly matches the limit, nextCursor should be null (no extra page)
		it('should handle count == limit exact boundary', async () => {
			await createStaggeredEntities(store, 5);

			// Request exactly 5 entities — all fit in one page, no next page
			const result = await store.readGraph(undefined, { limit: 5 });
			expect(result.entities).toHaveLength(5);
			expect(result.nextCursor).toBeNull();
			expect(result.totalCount).toBe(5);
		});

		// Verifies that clampLimit actually clamps to MAX_PAGE_SIZE (100) by creating
		// more than 100 entities — with a limit > 100, the result should be clamped
		it('should actually clamp limit to 100 with more than 100 entities', async () => {
			// Create 105 entities (more than MAX_PAGE_SIZE) to verify clamping is real
			await createStaggeredEntities(store, 105);

			// Request limit=200 — should be clamped to 100
			const page1 = await store.readGraph(undefined, { limit: 200 });
			expect(page1.entities).toHaveLength(100);
			expect(page1.nextCursor).not.toBeNull();
			expect(page1.totalCount).toBe(105);

			// Second page should have the remaining 5
			const page2 = await store.readGraph(undefined, { cursor: page1.nextCursor!, limit: 200 });
			expect(page2.entities).toHaveLength(5);
			expect(page2.nextCursor).toBeNull();
		});

		// Verifies searchNodes pagination works correctly with a projectId filter.
		// Entities from the project + globals should be included; other projects excluded.
		it('should paginate searchNodes with projectId filter', async () => {
			// Create project-scoped entities
			await createStaggeredEntities(store, 5, 'proj-x');
			// Create global entities with distinct names (entity names are globally unique)
			await store.createEntities([
				{ name: 'Global-Search-1', entityType: 'test', observations: ['searchable content'] },
			]);

			// Search within proj-x scope — should find proj-x entities + globals matching query
			const page1 = await store.searchNodes('test', 'proj-x', { limit: 3 });
			expect(page1.entities.length).toBeGreaterThan(0);
			// All results should belong to proj-x or be global
			for (const e of page1.entities) {
				expect(e.project === 'proj-x' || e.project === null).toBe(true);
			}

			// If there's a next page, continue traversal
			if (page1.nextCursor) {
				const page2 = await store.searchNodes('test', 'proj-x', { cursor: page1.nextCursor, limit: 3 });
				for (const e of page2.entities) {
					expect(e.project === 'proj-x' || e.project === null).toBe(true);
				}
			}
		});

		// Regression test for issue #36: fingerprint collision when projectId contains
		// the delimiter character. With the old ':' delimiter, projectId="a:b" + query="c"
		// would produce the same fingerprint as projectId="a" + query="b:c".
		// With the null-byte separator fix, these produce distinct fingerprints.
		it('should not allow fingerprint collision across different projectId/query combos', async () => {
			// Create entities visible to both "queries" (global entities)
			await createStaggeredEntities(store, 5);

			// Get a cursor from searchNodes with projectId="a" and query="test"
			// (matches entityType "test" on all 5 entities, producing a cursor)
			const result1 = await store.searchNodes('test', 'a', { limit: 2 });

			// We must get a cursor (5 entities match, limit=2 → more pages)
			expect(result1.nextCursor).not.toBeNull();

			// Using the cursor with swapped projectId/query should throw
			// because the fingerprint encodes the exact projectId+query combo.
			// With the old ':' delimiter this could collide; null-byte separator prevents it.
			await expect(
				store.searchNodes('a', 'test', { cursor: result1.nextCursor!, limit: 2 })
			).rejects.toThrow(InvalidCursorError);
		});

		// Verifies that cursor field validation rejects invalid 'i' values.
		// The 'i' field must be a non-negative finite integer.
		it('should reject cursors with invalid i values', async () => {
			await createStaggeredEntities(store, 3);

			// Craft cursors with invalid 'i' values — these should all be rejected
			const craftCursor = (payload: Record<string, unknown>) =>
				Buffer.from(JSON.stringify(payload)).toString('base64');

			// i: Infinity — would silently restart pagination from page 1
			await expect(
				store.readGraph(undefined, { cursor: craftCursor({ u: '2025-01-01', i: Infinity, q: 'readGraph\0' }) })
			).rejects.toThrow(InvalidCursorError);

			// i: -1 — negative id would truncate results
			await expect(
				store.readGraph(undefined, { cursor: craftCursor({ u: '2025-01-01', i: -1, q: 'readGraph\0' }) })
			).rejects.toThrow(InvalidCursorError);

			// i: 3.14 — fractional id is nonsensical
			await expect(
				store.readGraph(undefined, { cursor: craftCursor({ u: '2025-01-01', i: 3.14, q: 'readGraph\0' }) })
			).rejects.toThrow(InvalidCursorError);

			// n: 42 — name field should be string if present
			await expect(
				store.readGraph(undefined, { cursor: craftCursor({ u: '2025-01-01', i: 1, n: 42, q: 'readGraph\0' }) })
			).rejects.toThrow(InvalidCursorError);
		});

		// Verifies that addObservations uses a single timestamp for both
		// observation.createdAt and entity.updatedAt (issue #41 fix)
		it('should use consistent timestamp for observation and entity update', async () => {
			await store.createEntities([
				{ name: 'TimestampTest', entityType: 'test', observations: ['initial'] },
			]);

			const results = await store.addObservations([
				{ entityName: 'TimestampTest', contents: ['new obs'] },
			]);

			// The added observation's createdAt should match the entity's updatedAt
			const graph = await store.readGraph(undefined, { limit: 100 });
			const entity = graph.entities.find(e => e.name === 'TimestampTest')!;
			const addedObs = results[0].addedObservations[0];
			expect(entity.updatedAt).toBe(addedObs.createdAt);
		});
	});

	// ----------------------------------------------------------
	// observation deduplication within createEntities
	// ----------------------------------------------------------
	describe('observation deduplication within createEntities', () => {
		it('should deduplicate observations within a single entity', async () => {
			// Previously this bug allowed ['a', 'a'] to create two identical observations
			const { created: entities } = await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['same', 'same', 'different'] },
			]);

			expect(entities[0].observations).toHaveLength(2);
			expect(entities[0].observations.map(o => o.content)).toEqual(['same', 'different']);
		});
	});

	// ----------------------------------------------------------
	// addObservations dedup within single contents array
	// ----------------------------------------------------------
	describe('addObservations dedup within single contents array', () => {
		it('should deduplicate within the contents array itself', async () => {
			// Previously addObservations(['foo', 'foo']) would add both because
			// the dedup Set was built from existing observations only
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
			]);

			const results = await store.addObservations([
				{ entityName: 'Alice', contents: ['foo', 'foo', 'bar'] },
			]);

			expect(results[0].addedObservations).toHaveLength(2);
			expect(results[0].addedObservations.map(o => o.content)).toEqual(['foo', 'bar']);

			const graph = await store.readGraph();
			const alice = graph.entities.find(e => e.name === 'Alice');
			expect(alice?.observations).toHaveLength(2);
		});
	});

	// ----------------------------------------------------------
	// within-batch deduplication
	// ----------------------------------------------------------
	describe('within-batch deduplication', () => {
		it('should deduplicate entities within the same createEntities call', async () => {
			// Two entities with the same name in one batch — only the first should be created
			const { created } = await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['first'] },
				{ name: 'Alice', entityType: 'robot', observations: ['second'] },
			]);

			expect(created).toHaveLength(1);
			expect(created[0].entityType).toBe('person');

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
		});

		it('should deduplicate relations within the same createRelations call', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);

			// Two identical relations in one batch — only one should be created
			const result = await store.createRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
			]);

			expect(result).toHaveLength(1);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(1);
		});
	});

	// ----------------------------------------------------------
	// composite key safety
	// ----------------------------------------------------------
	describe('composite key safety', () => {
		it('should not collide when entity names contain pipe characters', async () => {
			await store.createEntities([
				{ name: 'A|B', entityType: 'test', observations: [] },
				{ name: 'A', entityType: 'test', observations: [] },
				{ name: 'C', entityType: 'test', observations: [] },
				{ name: 'B|C', entityType: 'test', observations: [] },
			]);

			// These two relations have different from/to but would collide with a pipe separator:
			// "A|B" + "C" + "knows" vs "A" + "B|C" + "knows" both produce "A|B|C|knows"
			const result = await store.createRelations([
				{ from: 'A|B', to: 'C', relationType: 'knows' },
				{ from: 'A', to: 'B|C', relationType: 'knows' },
			]);

			// Both should be created since they are semantically different relations
			expect(result).toHaveLength(2);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(2);
		});

		it('should correctly delete relations with pipe characters in names', async () => {
			await store.createEntities([
				{ name: 'A|B', entityType: 'test', observations: [] },
				{ name: 'C', entityType: 'test', observations: [] },
				{ name: 'A', entityType: 'test', observations: [] },
				{ name: 'B|C', entityType: 'test', observations: [] },
			]);

			await store.createRelations([
				{ from: 'A|B', to: 'C', relationType: 'knows' },
				{ from: 'A', to: 'B|C', relationType: 'knows' },
			]);

			// Delete only the first relation — the second should remain
			await store.deleteRelations([
				{ from: 'A|B', to: 'C', relationType: 'knows' },
			]);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(1);
			expect(graph.relations[0].from).toBe('A');
			expect(graph.relations[0].to).toBe('B|C');
		});
	});

	// ----------------------------------------------------------
	// idempotent delete edge cases
	// ----------------------------------------------------------
	describe('idempotent delete edge cases', () => {
		it('should silently handle deleting observations that do not exist on entity', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: ['keep this'] },
			]);

			// Delete an observation that doesn't exist — should not throw or affect existing obs
			await store.deleteObservations([
				{ entityName: 'Alice', contents: ['nonexistent'] },
			]);

			const graph = await store.readGraph();
			const alice = graph.entities.find(e => e.name === 'Alice');
			expect(alice?.observations).toHaveLength(1);
			expect(alice?.observations[0].content).toBe('keep this');
		});

		it('should silently handle deleting relations that do not exist', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
				{ name: 'Bob', entityType: 'person', observations: [] },
			]);

			await store.createRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'knows' },
			]);

			// Delete a relation that doesn't exist — should not affect existing relations
			await store.deleteRelations([
				{ from: 'Alice', to: 'Bob', relationType: 'nonexistent' },
			]);

			const graph = await store.readGraph();
			expect(graph.relations).toHaveLength(1);
			expect(graph.relations[0].relationType).toBe('knows');
		});
	});
});

// ============================================================
// Section 2: JsonlStore-specific tests
// These test JSONL-only behaviors: file format, legacy migration,
// normalizeObservation, malformed lines, and atomic writes.
// ============================================================

describe('JsonlStore-specific', () => {
	// `store` here is always a JsonlStore — typed as such to access JSONL internals
	let store: JsonlStore;
	let storePath: string;

	beforeEach(async () => {
		storePath = path.join(testDir, `test-memory-${Date.now()}.jsonl`);
		store = new JsonlStore(storePath);
		await store.init();
	});

	afterEach(async () => {
		await store.close();
		try { await fs.unlink(storePath); } catch { /* file may not exist */ }
		try { await fs.unlink(storePath + '.tmp'); } catch { /* temp file may not exist */ }
	});

	// ----------------------------------------------------------
	// JSONL file format
	// ----------------------------------------------------------
	it('should handle JSONL format correctly', async () => {
		await store.createEntities([
			{ name: 'Alice', entityType: 'person', observations: [] },
		]);
		await store.createRelations([
			{ from: 'Alice', to: 'Alice', relationType: 'self' },
		]);

		// Read file directly to verify on-disk format
		const fileContent = await fs.readFile(storePath, 'utf-8');
		const lines = fileContent.split('\n').filter(line => line.trim());

		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toHaveProperty('type', 'entity');
		expect(JSON.parse(lines[1])).toHaveProperty('type', 'relation');
	});

	// ----------------------------------------------------------
	// strip type field
	// ----------------------------------------------------------
	it('should strip type field from entities when loading from file', async () => {
		// Create entities and relations (these get saved with type field)
		await store.createEntities([
			{ name: 'Alice', entityType: 'person', observations: ['test observation'] },
			{ name: 'Bob', entityType: 'person', observations: [] },
		]);
		await store.createRelations([
			{ from: 'Alice', to: 'Bob', relationType: 'knows' },
		]);

		// Verify file contains type field (order may vary)
		const fileContent = await fs.readFile(storePath, 'utf-8');
		const fileLines = fileContent.split('\n').filter(line => line.trim());
		const fileItems = fileLines.map(line => JSON.parse(line));
		const fileEntity = fileItems.find(item => item.type === 'entity');
		const fileRelation = fileItems.find(item => item.type === 'relation');
		expect(fileEntity).toBeDefined();
		expect(fileEntity).toHaveProperty('type', 'entity');
		expect(fileRelation).toBeDefined();
		expect(fileRelation).toHaveProperty('type', 'relation');

		// Create new store instance to force reload from file
		const store2 = new JsonlStore(storePath);
		const graph = await store2.readGraph();

		// Verify loaded entities don't have type field
		expect(graph.entities).toHaveLength(2);
		graph.entities.forEach(entity => {
			expect(entity).not.toHaveProperty('type');
			expect(entity).toHaveProperty('name');
			expect(entity).toHaveProperty('entityType');
			expect(entity).toHaveProperty('observations');
		});

		// Verify loaded relations don't have type field
		expect(graph.relations).toHaveLength(1);
		graph.relations.forEach(relation => {
			expect(relation).not.toHaveProperty('type');
			expect(relation).toHaveProperty('from');
			expect(relation).toHaveProperty('to');
			expect(relation).toHaveProperty('relationType');
		});
	});

	it('should strip type field from searchNodes results', async () => {
		await store.createEntities([
			{ name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
		]);
		await store.createRelations([
			{ from: 'Alice', to: 'Alice', relationType: 'self' },
		]);

		// Create new store instance to force reload from file
		const store2 = new JsonlStore(storePath);
		const result = await store2.searchNodes('Alice');

		// Verify search results don't have type field
		expect(result.entities).toHaveLength(1);
		expect(result.entities[0]).not.toHaveProperty('type');
		expect(result.entities[0].name).toBe('Alice');

		expect(result.relations).toHaveLength(1);
		expect(result.relations[0]).not.toHaveProperty('type');
		expect(result.relations[0].from).toBe('Alice');
	});

	it('should strip type field from openNodes results', async () => {
		await store.createEntities([
			{ name: 'Alice', entityType: 'person', observations: [] },
			{ name: 'Bob', entityType: 'person', observations: [] },
		]);
		await store.createRelations([
			{ from: 'Alice', to: 'Bob', relationType: 'knows' },
		]);

		// Create new store instance to force reload from file
		const store2 = new JsonlStore(storePath);
		const result = await store2.openNodes(['Alice', 'Bob']);

		// Verify open results don't have type field
		expect(result.entities).toHaveLength(2);
		result.entities.forEach(entity => {
			expect(entity).not.toHaveProperty('type');
		});

		expect(result.relations).toHaveLength(1);
		expect(result.relations[0]).not.toHaveProperty('type');
	});

	// ----------------------------------------------------------
	// legacy observation migration
	// ----------------------------------------------------------
	it('should migrate legacy string observations with createdAt "unknown"', async () => {
		// Write a legacy-format JSONL file directly (observations as plain strings)
		const legacyEntity = JSON.stringify({
			type: 'entity',
			name: 'LegacyAlice',
			entityType: 'person',
			observations: ['old observation'],
		});
		await fs.writeFile(storePath, legacyEntity);

		const graph = await store.readGraph();
		const alice = graph.entities[0];
		expect(alice.observations[0]).toEqual({
			content: 'old observation',
			createdAt: 'unknown',
		});
	});

	it('should handle mixed legacy and new observations in the same entity', async () => {
		// Write a file with legacy string observations
		const legacyEntity = JSON.stringify({
			type: 'entity',
			name: 'Alice',
			entityType: 'person',
			observations: ['old observation'],
		});
		await fs.writeFile(storePath, legacyEntity);

		// Add new observations through the store API
		await store.addObservations([
			{ entityName: 'Alice', contents: ['new observation'] },
		]);

		const graph = await store.readGraph();
		const alice = graph.entities[0];
		expect(alice.observations).toHaveLength(2);
		expect(alice.observations[0]).toEqual({ content: 'old observation', createdAt: 'unknown' });
		expect(alice.observations[1].content).toBe('new observation');
		expect(alice.observations[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(alice.observations[1].createdAt).not.toBe('unknown');
	});

	// ----------------------------------------------------------
	// normalizeObservation (JSONL-specific: reads/writes raw JSONL)
	// ----------------------------------------------------------
	describe('normalizeObservation validation', () => {
		it('should throw on invalid observation format during load', async () => {
			// Write a JSONL file with an entity that has an invalid observation (number instead of string/object)
			const badEntity = JSON.stringify({
				type: 'entity',
				name: 'Bad',
				entityType: 'test',
				observations: [42],
			});
			await fs.writeFile(storePath, badEntity + '\n');

			// loadGraph should skip malformed lines (the entity line itself will error
			// during normalizeObservation and be caught by the per-line try/catch)
			const graph = await store.readGraph();
			// The entity with invalid observations is skipped entirely
			expect(graph.entities).toHaveLength(0);
		});

		it('should handle objects missing the content field', async () => {
			const badEntity = JSON.stringify({
				type: 'entity',
				name: 'Bad',
				entityType: 'test',
				observations: [{ notContent: 'oops' }],
			});
			await fs.writeFile(storePath, badEntity + '\n');

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(0);
		});
	});

	// ----------------------------------------------------------
	// normalizeObservation edge cases
	// ----------------------------------------------------------
	describe('normalizeObservation edge cases', () => {
		it('should handle object with content but non-string createdAt', async () => {
			// An observation object where createdAt is a number — should fall back to 'unknown'
			const entity = JSON.stringify({
				type: 'entity',
				name: 'Test',
				entityType: 'test',
				observations: [{ content: 'hello', createdAt: 12345 }],
			});
			await fs.writeFile(storePath, entity + '\n');

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].observations[0]).toEqual({
				content: 'hello',
				createdAt: 'unknown',
			});
		});

		it('should handle entity with missing observations field', async () => {
			// JSONL line with no observations key — the || [] fallback should produce empty array
			const entity = JSON.stringify({
				type: 'entity',
				name: 'Bare',
				entityType: 'test',
			});
			await fs.writeFile(storePath, entity + '\n');

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].observations).toEqual([]);
		});
	});

	// ----------------------------------------------------------
	// malformed JSONL error isolation
	// ----------------------------------------------------------
	describe('malformed JSONL error isolation', () => {
		it('should skip malformed lines and load valid ones', async () => {
			const validEntity = JSON.stringify({
				type: 'entity',
				name: 'Valid',
				entityType: 'test',
				observations: ['good'],
			});
			const malformedLine = '{ this is not valid JSON }}';
			const validRelation = JSON.stringify({
				type: 'relation',
				from: 'Valid',
				to: 'Valid',
				relationType: 'self',
			});

			// Write file with a malformed line sandwiched between valid lines
			await fs.writeFile(storePath, [validEntity, malformedLine, validRelation].join('\n') + '\n');

			const graph = await store.readGraph();
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('Valid');
			expect(graph.relations).toHaveLength(1);
		});

		it('should skip lines with unrecognized type values', async () => {
			const futureType = JSON.stringify({
				type: 'tag',
				value: 'something-new',
			});
			const validEntity = JSON.stringify({
				type: 'entity',
				name: 'Present',
				entityType: 'test',
				observations: [],
			});

			await fs.writeFile(storePath, [futureType, validEntity].join('\n') + '\n');

			const graph = await store.readGraph();
			// Unrecognized types are silently ignored (forward compatibility)
			expect(graph.entities).toHaveLength(1);
			expect(graph.entities[0].name).toBe('Present');
		});
	});

	// ----------------------------------------------------------
	// atomic writes
	// ----------------------------------------------------------
	describe('atomic writes', () => {
		it('should write a trailing newline to the JSONL file', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
			]);

			const fileContent = await fs.readFile(storePath, 'utf-8');
			// JSONL files should end with a trailing newline
			expect(fileContent.endsWith('\n')).toBe(true);
		});

		it('should not leave temp files after successful write', async () => {
			await store.createEntities([
				{ name: 'Alice', entityType: 'person', observations: [] },
			]);

			// The .tmp file should be renamed to the real file, not left behind
			await expect(fs.access(storePath + '.tmp')).rejects.toThrow();
		});
	});
});

// ============================================================
// Section 3: SqliteStore-specific tests
// ============================================================

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
			const { created } = await store.createEntities([
				{ name: 'Alice', entityType: 'robot', observations: ['second'] },
			]);

			expect(created).toHaveLength(0);
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

	describe('project column migration', () => {
		it('should migrate existing database by adding project column', async () => {
			const migrationPath = path.join(testDir, `test-migration-project-${Date.now()}.db`);

			// Create a pre-Phase-3 database manually (no project column).
			// Imports better-sqlite3 directly to build a schema without the project column,
			// simulating a database created before Phase 3 was implemented.
			const Database = (await import('better-sqlite3')).default;
			const rawDb = new Database(migrationPath);
			rawDb.pragma('journal_mode = WAL');
			rawDb.pragma('foreign_keys = ON');
			rawDb.exec(`
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
			// Insert a legacy entity without a project column
			rawDb.prepare('INSERT INTO entities (name, entity_type) VALUES (?, ?)').run('OldEntity', 'test');
			const entityId = (rawDb.prepare('SELECT id FROM entities WHERE name = ?').get('OldEntity') as { id: number }).id;
			rawDb.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)').run(entityId, 'old data', new Date().toISOString());
			rawDb.close();

			// Re-open with SqliteStore -- init() should detect missing project column and add it
			const store2 = new SqliteStore(migrationPath);
			await store2.init();

			// Old entity should have null project after migration
			const graph = await store2.readGraph();
			expect(graph.entities[0].project).toBeNull();

			// Verify new entities can be created with a project
			await store2.createEntities(
				[{ name: 'NewEntity', entityType: 'test', observations: ['new data'] }],
				'test-project'
			);
			// readGraph with project filter returns project entities + global (null project) entities
			const graph2 = await store2.readGraph('test-project');
			const names = graph2.entities.map(e => e.name).sort();
			expect(names).toEqual(['NewEntity', 'OldEntity']); // OldEntity is global, included

			await store2.close();
			// Clean up all SQLite sidecar files
			for (const suffix of ['', '-wal', '-shm']) {
				try { await fs.unlink(migrationPath + suffix); } catch { /* ignore */ }
			}
		});
	});

	describe('timestamp column migration', () => {
		it('should migrate existing database by adding timestamp columns and backfilling', async () => {
			const migrationPath = path.join(testDir, `test-migration-timestamps-${Date.now()}.db`);

			// Create a pre-Phase-4 database (has project column but no timestamp columns).
			// Imports better-sqlite3 directly to build a schema matching Phase 3 state,
			// simulating a database created before Phase 4 was implemented.
			const Database = (await import('better-sqlite3')).default;
			const rawDb = new Database(migrationPath);
			rawDb.pragma('journal_mode = WAL');
			rawDb.pragma('foreign_keys = ON');
			rawDb.exec(`
				CREATE TABLE IF NOT EXISTS entities (
					id          INTEGER PRIMARY KEY AUTOINCREMENT,
					name        TEXT NOT NULL UNIQUE,
					entity_type TEXT NOT NULL,
					project     TEXT
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

			// Insert entity WITH observations (for backfill testing)
			rawDb.prepare('INSERT INTO entities (name, entity_type) VALUES (?, ?)').run('WithObs', 'test');
			const entityId = (rawDb.prepare('SELECT id FROM entities WHERE name = ?').get('WithObs') as { id: number }).id;
			rawDb.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)').run(entityId, 'obs1', '2026-03-15T10:00:00.000Z');
			rawDb.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)').run(entityId, 'obs2', '2026-04-01T15:30:00.000Z');

			// Insert entity WITHOUT valid observations (should keep sentinel)
			rawDb.prepare('INSERT INTO entities (name, entity_type) VALUES (?, ?)').run('NoObs', 'test');

			rawDb.close();

			// Re-open with SqliteStore — init() should detect missing columns and migrate
			const store2 = new SqliteStore(migrationPath);
			await store2.init();

			const graph = await store2.readGraph();

			// Entity with observations should have updatedAt backfilled from MAX(observations.created_at)
			const withObs = graph.entities.find(e => e.name === 'WithObs');
			expect(withObs).toBeDefined();
			expect(withObs!.updatedAt).toBe('2026-04-01T15:30:00.000Z');
			expect(withObs!.createdAt).toBe('2026-03-15T10:00:00.000Z');

			// Entity without observations should have sentinel timestamp
			const noObs = graph.entities.find(e => e.name === 'NoObs');
			expect(noObs).toBeDefined();
			expect(noObs!.updatedAt).toBe('0000-00-00T00:00:00.000Z');
			expect(noObs!.createdAt).toBe('0000-00-00T00:00:00.000Z');

			// Verify pagination works on migrated data (updatedAt should order correctly)
			const paginated = await store2.readGraph(undefined, { limit: 1 });
			// WithObs has a real timestamp, should come first in DESC order
			expect(paginated.entities[0].name).toBe('WithObs');
			expect(paginated.nextCursor).not.toBeNull();

			await store2.close();
			for (const suffix of ['', '-wal', '-shm']) {
				try { await fs.unlink(migrationPath + suffix); } catch { /* ignore */ }
			}
		});
	});
});
