import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KnowledgeGraphManager, Entity, Observation, Relation, KnowledgeGraph } from '../index.js';

describe('KnowledgeGraphManager', () => {
  let manager: KnowledgeGraphManager;
  let testFilePath: string;

  beforeEach(async () => {
    // Create a temporary test file path
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-memory-${Date.now()}.jsonl`
    );
    manager = new KnowledgeGraphManager(testFilePath);
  });

  afterEach(async () => {
    // Clean up test file
    try {
      await fs.unlink(testFilePath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  });

  describe('createEntities', () => {
    it('should create new entities', async () => {
      const newEntities = await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
        { name: 'Bob', entityType: 'person', observations: ['likes programming'] },
      ]);

      expect(newEntities).toHaveLength(2);
      expect(newEntities[0]).toEqual(expect.objectContaining({ name: 'Alice', entityType: 'person' }));
      expect(newEntities[0].observations).toHaveLength(1);
      expect(newEntities[0].observations[0]).toEqual(expect.objectContaining({ content: 'works at Acme Corp' }));
      expect(newEntities[0].observations[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(2);
    });

    it('should not create duplicate entities', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
      ]);
      const newEntities = await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
      ]);

      expect(newEntities).toHaveLength(0);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
    });

    it('should handle empty entity arrays', async () => {
      const newEntities = await manager.createEntities([]);
      expect(newEntities).toHaveLength(0);
    });
  });

  describe('createRelations', () => {
    it('should create new relations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);

      const relations: Relation[] = [
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ];

      const newRelations = await manager.createRelations(relations);
      expect(newRelations).toHaveLength(1);
      expect(newRelations).toEqual(relations);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
    });

    it('should not create duplicate relations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);

      const relations: Relation[] = [
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ];

      await manager.createRelations(relations);
      const newRelations = await manager.createRelations(relations);

      expect(newRelations).toHaveLength(0);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
    });

    it('should handle empty relation arrays', async () => {
      const newRelations = await manager.createRelations([]);
      expect(newRelations).toHaveLength(0);
    });
  });

  describe('addObservations', () => {
    it('should add observations to existing entities', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
      ]);

      const results = await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee', 'has a dog'] },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].entityName).toBe('Alice');
      expect(results[0].addedObservations).toHaveLength(2);

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.observations).toHaveLength(3);
    });

    it('should not add duplicate observations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
      ]);

      await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee'] },
      ]);

      const results = await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee', 'has a dog'] },
      ]);

      expect(results[0].addedObservations).toHaveLength(1);
      expect(results[0].addedObservations[0]).toEqual(expect.objectContaining({ content: 'has a dog' }));

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.observations).toHaveLength(3);
    });

    it('should throw error for non-existent entity', async () => {
      await expect(
        manager.addObservations([
          { entityName: 'NonExistent', contents: ['some observation'] },
        ])
      ).rejects.toThrow('Entity with name NonExistent not found');
    });
  });

  describe('deleteEntities', () => {
    it('should delete entities', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);

      await manager.deleteEntities(['Alice']);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe('Bob');
    });

    it('should cascade delete relations when deleting entities', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
        { name: 'Charlie', entityType: 'person', observations: [] },
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Bob', to: 'Charlie', relationType: 'knows' },
      ]);

      await manager.deleteEntities(['Bob']);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(2);
      expect(graph.relations).toHaveLength(0);
    });

    it('should handle deleting non-existent entities', async () => {
      await manager.deleteEntities(['NonExistent']);
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe('deleteObservations', () => {
    it('should delete observations from entities', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp', 'likes coffee'] },
      ]);

      await manager.deleteObservations([
        { entityName: 'Alice', observations: ['likes coffee'] },
      ]);

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.observations).toHaveLength(1);
      expect(alice?.observations[0]).toEqual(expect.objectContaining({ content: 'works at Acme Corp' }));
    });

    it('should handle deleting from non-existent entities', async () => {
      await manager.deleteObservations([
        { entityName: 'NonExistent', observations: ['some observation'] },
      ]);
      // Should not throw error
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe('deleteRelations', () => {
    it('should delete specific relations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Alice', to: 'Bob', relationType: 'works_with' },
      ]);

      await manager.deleteRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ]);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
      expect(graph.relations[0].relationType).toBe('works_with');
    });
  });

  describe('readGraph', () => {
    it('should return empty graph when file does not exist', async () => {
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
      expect(graph.relations).toHaveLength(0);
    });

    it('should return complete graph with entities and relations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Alice', relationType: 'self' },
      ]);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.relations).toHaveLength(1);
    });
  });

  describe('searchNodes', () => {
    beforeEach(async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp', 'likes programming'] },
        { name: 'Bob', entityType: 'person', observations: ['works at TechCo'] },
        { name: 'Acme Corp', entityType: 'company', observations: ['tech company'] },
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Acme Corp', relationType: 'works_at' },
        { from: 'Bob', to: 'Acme Corp', relationType: 'competitor' },
      ]);
    });

    it('should search by entity name', async () => {
      const result = await manager.searchNodes('Alice');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should search by entity type', async () => {
      const result = await manager.searchNodes('company');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Acme Corp');
    });

    it('should search by observation content', async () => {
      const result = await manager.searchNodes('programming');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should be case insensitive', async () => {
      const result = await manager.searchNodes('ALICE');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should include relations where at least one endpoint matches', async () => {
      const result = await manager.searchNodes('Acme');
      expect(result.entities).toHaveLength(2); // Alice and Acme Corp
      // Both relations included: Alice → Acme Corp (Alice matched) and Bob → Acme Corp (Acme Corp matched)
      expect(result.relations).toHaveLength(2);
    });

    it('should include outgoing relations to unmatched entities', async () => {
      const result = await manager.searchNodes('Alice');
      expect(result.entities).toHaveLength(1);
      // Alice → Acme Corp relation included because Alice is the source
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Alice');
      expect(result.relations[0].to).toBe('Acme Corp');
    });

    it('should return empty graph for no matches', async () => {
      const result = await manager.searchNodes('NonExistent');
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });
  });

  describe('openNodes', () => {
    beforeEach(async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
        { name: 'Charlie', entityType: 'person', observations: [] },
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Bob', to: 'Charlie', relationType: 'knows' },
      ]);
    });

    it('should open specific nodes by name', async () => {
      const result = await manager.openNodes(['Alice', 'Bob']);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map(e => e.name)).toContain('Alice');
      expect(result.entities.map(e => e.name)).toContain('Bob');
    });

    it('should include all relations connected to opened nodes', async () => {
      const result = await manager.openNodes(['Alice', 'Bob']);
      // Alice → Bob (both endpoints opened) and Bob → Charlie (Bob is opened)
      expect(result.relations).toHaveLength(2);
      expect(result.relations.some(r => r.from === 'Alice' && r.to === 'Bob')).toBe(true);
      expect(result.relations.some(r => r.from === 'Bob' && r.to === 'Charlie')).toBe(true);
    });

    it('should include relations connected to opened nodes', async () => {
      const result = await manager.openNodes(['Bob']);
      // Bob has two relations: Alice → Bob and Bob → Charlie
      expect(result.relations).toHaveLength(2);
      expect(result.relations.some(r => r.from === 'Alice' && r.to === 'Bob')).toBe(true);
      expect(result.relations.some(r => r.from === 'Bob' && r.to === 'Charlie')).toBe(true);
    });

    it('should include outgoing relations to nodes not in the open set', async () => {
      // This is the core bug fix for #3137: open_nodes should return
      // relations FROM the opened node, even if the target is not opened
      const result = await manager.openNodes(['Alice']);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
      // Alice → Bob relation is included because Alice is opened
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Alice');
      expect(result.relations[0].to).toBe('Bob');
    });

    it('should include incoming relations from nodes not in the open set', async () => {
      const result = await manager.openNodes(['Charlie']);
      expect(result.entities).toHaveLength(1);
      // Bob → Charlie relation is included because Charlie is opened
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Bob');
      expect(result.relations[0].to).toBe('Charlie');
    });

    it('should handle opening non-existent nodes', async () => {
      const result = await manager.openNodes(['NonExistent']);
      expect(result.entities).toHaveLength(0);
    });

    it('should handle empty node list', async () => {
      const result = await manager.openNodes([]);
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });
  });

  describe('file persistence', () => {
    it('should persist data across manager instances', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['persistent data'] },
      ]);

      // Create new manager instance with same file path
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe('Alice');
      expect(graph.entities[0].observations[0]).toEqual(expect.objectContaining({ content: 'persistent data' }));
      expect(graph.entities[0].observations[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle JSONL format correctly', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
      ]);
      await manager.createRelations([
        { from: 'Alice', to: 'Alice', relationType: 'self' },
      ]);

      // Read file directly
      const fileContent = await fs.readFile(testFilePath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim());

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toHaveProperty('type', 'entity');
      expect(JSON.parse(lines[1])).toHaveProperty('type', 'relation');
    });

    it('should strip type field from entities when loading from file', async () => {
      // Create entities and relations (these get saved with type field)
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['test observation'] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);
      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ]);

      // Verify file contains type field (order may vary)
      const fileContent = await fs.readFile(testFilePath, 'utf-8');
      const fileLines = fileContent.split('\n').filter(line => line.trim());
      const fileItems = fileLines.map(line => JSON.parse(line));
      const fileEntity = fileItems.find(item => item.type === 'entity');
      const fileRelation = fileItems.find(item => item.type === 'relation');
      expect(fileEntity).toBeDefined();
      expect(fileEntity).toHaveProperty('type', 'entity');
      expect(fileRelation).toBeDefined();
      expect(fileRelation).toHaveProperty('type', 'relation');

      // Create new manager instance to force reload from file
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

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
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
      ]);
      await manager.createRelations([
        { from: 'Alice', to: 'Alice', relationType: 'self' },
      ]);

      // Create new manager instance to force reload from file
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const result = await manager2.searchNodes('Alice');

      // Verify search results don't have type field
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).not.toHaveProperty('type');
      expect(result.entities[0].name).toBe('Alice');

      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]).not.toHaveProperty('type');
      expect(result.relations[0].from).toBe('Alice');
    });

    it('should strip type field from openNodes results', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
        { name: 'Bob', entityType: 'person', observations: [] },
      ]);
      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ]);

      // Create new manager instance to force reload from file
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const result = await manager2.openNodes(['Alice', 'Bob']);

      // Verify open results don't have type field
      expect(result.entities).toHaveLength(2);
      result.entities.forEach(entity => {
        expect(entity).not.toHaveProperty('type');
      });

      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]).not.toHaveProperty('type');
    });
  });

  describe('observation timestamps', () => {
    it('should assign ISO 8601 timestamps to observations created via createEntities', async () => {
      const before = new Date().toISOString();
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme'] },
      ]);
      const after = new Date().toISOString();

      const graph = await manager.readGraph();
      const obs = graph.entities[0].observations[0];
      expect(obs.content).toBe('works at Acme');
      expect(obs.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(obs.createdAt >= before).toBe(true);
      expect(obs.createdAt <= after).toBe(true);
    });

    it('should assign ISO 8601 timestamps to observations added via addObservations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: [] },
      ]);

      const before = new Date().toISOString();
      await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee'] },
      ]);
      const after = new Date().toISOString();

      const graph = await manager.readGraph();
      const obs = graph.entities[0].observations[0];
      expect(obs.content).toBe('likes coffee');
      expect(obs.createdAt >= before).toBe(true);
      expect(obs.createdAt <= after).toBe(true);
    });

    it('should migrate legacy string observations with createdAt "unknown"', async () => {
      // Write a legacy-format JSONL file directly (observations as plain strings)
      const legacyEntity = JSON.stringify({
        type: 'entity',
        name: 'LegacyAlice',
        entityType: 'person',
        observations: ['old observation'],
      });
      await fs.writeFile(testFilePath, legacyEntity);

      const graph = await manager.readGraph();
      const alice = graph.entities[0];
      expect(alice.observations[0]).toEqual({
        content: 'old observation',
        createdAt: 'unknown',
      });
    });

    it('should preserve timestamps across save/load cycles', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['test'] },
      ]);

      const graph1 = await manager.readGraph();
      const timestamp1 = graph1.entities[0].observations[0].createdAt;

      // Create a new manager instance to force re-read from disk
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph2 = await manager2.readGraph();
      const timestamp2 = graph2.entities[0].observations[0].createdAt;

      expect(timestamp2).toBe(timestamp1);
    });

    it('should handle mixed legacy and new observations in the same entity', async () => {
      // Write a file with legacy string observations
      const legacyEntity = JSON.stringify({
        type: 'entity',
        name: 'Alice',
        entityType: 'person',
        observations: ['old observation'],
      });
      await fs.writeFile(testFilePath, legacyEntity);

      // Add new observations through the manager API
      await manager.addObservations([
        { entityName: 'Alice', contents: ['new observation'] },
      ]);

      const graph = await manager.readGraph();
      const alice = graph.entities[0];
      expect(alice.observations).toHaveLength(2);
      expect(alice.observations[0]).toEqual({ content: 'old observation', createdAt: 'unknown' });
      expect(alice.observations[1].content).toBe('new observation');
      expect(alice.observations[1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(alice.observations[1].createdAt).not.toBe('unknown');
    });

    it('should deduplicate by content when adding to entities with timestamped observations', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['existing'] },
      ]);

      const results = await manager.addObservations([
        { entityName: 'Alice', contents: ['existing', 'new one'] },
      ]);

      expect(results[0].addedObservations).toHaveLength(1);
      expect(results[0].addedObservations[0].content).toBe('new one');
    });

    it('should delete observations by content string even with timestamps', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['keep this', 'delete this'] },
      ]);

      await manager.deleteObservations([
        { entityName: 'Alice', observations: ['delete this'] },
      ]);

      const graph = await manager.readGraph();
      const alice = graph.entities[0];
      expect(alice.observations).toHaveLength(1);
      expect(alice.observations[0].content).toBe('keep this');
    });

    it('should search observation content with timestamps', async () => {
      await manager.createEntities([
        { name: 'Alice', entityType: 'person', observations: ['works at Acme Corp'] },
        { name: 'Bob', entityType: 'person', observations: ['works at TechCo'] },
      ]);

      const result = await manager.searchNodes('Acme');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });
  });
});
