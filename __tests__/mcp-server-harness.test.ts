/**
 * In-process McpServer harness tests (Issue #81)
 *
 * WHY THIS FILE EXISTS: every other MCP-tool test (mcp-tools.test.ts) validates
 * hand-copied MIRROR schemas, not the production Zod chains, and NEVER
 * instantiates an McpServer. That leaves two things with zero CI coverage:
 *   1. the REAL tool handlers registered in index.ts (they close over the
 *      module-level `store`), and
 *   2. the outputSchema DECLARATIONS the server advertises via tools/list —
 *      the contract clients discover fields through.
 * The class this guards against has bitten repeatedly (#58, #86, #87): an
 * output key the store produces but the schema never declares, invisible to
 * all 700+ store-level tests.
 *
 * WHAT THE SDK'S OUTPUT VALIDATION ACTUALLY DOES (verified empirically
 * 2026-07-04 against the installed SDK, correcting this file's original
 * premise): validateToolOutput THROWS when structuredContent fails the
 * declared schema (e.g. a declared-required field is missing), but it does
 * NOT strip undeclared keys — the original result object is forwarded to the
 * client unmodified (mcp.js validates then `return result`; the parse's
 * stripped copy is discarded). So "delete a declaration and the key vanishes
 * from responses" is FALSE; what deleting a declaration DOES change is the
 * tools/list-advertised outputSchema JSON. The schema-drift guard in case (a)
 * therefore asserts against tools/list, and the end-to-end structuredContent
 * assertions pin the handler WIRING (store → handler → client), not stripping
 * behavior.
 *
 * HOW: index.ts exports a TEST-ONLY seam, wireForTesting(store), that points
 * the module-level `store` at a test instance and returns the already-registered
 * McpServer. We drive that server through a linked in-memory transport with a
 * real MCP Client, so requests traverse the exact production path — Zod input
 * validation, handler, Zod output validation — end to end.
 *
 * CONNECT-ONCE PATTERN (documented SDK constraint): the module-level server can
 * only connect once per process. So beforeAll connects it once; each test swaps
 * the underlying store via wireForTesting (handlers read `store` per-call, so the
 * swap takes effect without reconnecting). This is the pattern the Issue #81
 * design anticipated.
 *
 * Pool 1 (vectors off): inherits MEMORY_VECTOR_SEARCH=off / SKIP_VECTOR_INTEGRATION
 * from the suite env. None of these cases needs the embedding model.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { GraphStore } from '../types.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

// Sidecar suffixes SQLite leaves next to the .db (WAL/SHM); '.tmp' is a harmless
// defensive leftover — the same cleanup set knowledge-graph.test.ts uses.
const SIDECARS = ['', '.tmp', '-wal', '-shm'];
async function unlinkAll(basePath: string): Promise<void> {
	for (const suffix of SIDECARS) {
		try { await fs.unlink(basePath + suffix); } catch { /* ignore missing */ }
	}
}

describe('in-process McpServer harness (Issue #81)', () => {
	// The dynamically-imported index module — imported inside beforeAll so we can
	// set MEMORY_SKIP_MAIN before the module's top-level code runs (that guard is
	// what stops the import from booting stdio + opening the default DB).
	let mod: typeof import('../index.js');
	let client: Client;
	// The store the server was CONNECTED with. Only exists to give beforeAll a
	// store to obtain the server from; per-test stores replace it via
	// wireForTesting. Closed in afterAll.
	let bootStore: GraphStore;
	let bootPath: string;
	// The active per-test store and its temp path.
	let store: GraphStore;
	let storePath: string;

	beforeAll(async () => {
		// MUST be set before importing index.ts — its module scope invokes main()
		// unless this is '1' (the guard added for Issue #81).
		process.env.MEMORY_SKIP_MAIN = '1';
		mod = await import('../index.js');

		// Boot a store solely to acquire and connect the server once. Handlers read
		// the module-level `store` per-call, so the connection is store-agnostic —
		// later per-test wireForTesting swaps are picked up without reconnecting.
		bootPath = path.join(testDir, `harness-boot-${Date.now()}.db`);
		bootStore = new mod.SqliteStore(bootPath);
		await bootStore.init();
		const server = mod.wireForTesting(bootStore);

		const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTx);
		client = new Client({ name: 'harness', version: '0' });
		await client.connect(clientTx);
	});

	afterAll(async () => {
		await client.close();
		await bootStore.close();
		await unlinkAll(bootPath);
		// Restore the env so no later code in this worker inherits the guard.
		// (Vitest's default forks pool isolates per file, so this is belt-and-
		// suspenders — but env mutations should be symmetric on principle.)
		delete process.env.MEMORY_SKIP_MAIN;
	});

	beforeEach(async () => {
		// Fresh SqliteStore per test (unique path via Date.now(), same convention as
		// the existing SQLite test section). wireForTesting repoints the connected
		// server's handlers at it.
		storePath = path.join(testDir, `harness-${Date.now()}.db`);
		store = new mod.SqliteStore(storePath);
		await store.init();
		mod.wireForTesting(store);
	});

	afterEach(async () => {
		await store.close();
		await unlinkAll(storePath);
	});

	// callTool for cases we expect to FAIL input validation. On the installed SDK
	// version, an inputSchema violation comes back as a RESULT with isError:true
	// (a text-content error message) — NOT a rejected promise. We still catch, so
	// a future SDK that rejects instead would keep passing; the helper normalizes
	// both paths to one boolean and the tests don't depend on which one fires.
	async function callExpectingError(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ isError: boolean; threw: boolean }> {
		try {
			const res = await client.callTool({ name, arguments: args });
			return { isError: res.isError === true, threw: false };
		} catch {
			return { isError: true, threw: true };
		}
	}

	// ------------------------------------------------------------------
	// (a) L1Index: declared in the advertised schema AND wired end-to-end
	// ------------------------------------------------------------------
	// Two independent pins. (1) DECLARATION GUARD: the v16 L1Index key must appear
	// in get_context_layers' tools/list-advertised outputSchema — deleting the
	// declaration changes that JSON, so this assertion fails on schema drift (the
	// SDK does NOT strip undeclared keys from responses, so a response-side check
	// alone cannot catch drift — see the header comment). (2) WIRING: seed enough
	// featured L1 content to overflow the 12000-char featured budget, plus a
	// low-importance overflow entity, and assert L1Index comes back through the
	// CLIENT with its four fields.
	it('(a) declares L1Index in the advertised schema and surfaces it on featured-budget overflow', async () => {
		// (1) Declaration guard against tools/list.
		const tools = await client.listTools();
		const gcl = tools.tools.find((t) => t.name === 'get_context_layers');
		expect(gcl).toBeDefined();
		const gclProps = (gcl!.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
		expect('L1Index' in gclProps).toBe(true);
		// 13 unique ~1000-char L1 observations at importance 5 on one entity.
		// charCost = entityName.length + content.length ≈ 1015 each; 13 × ≈1015
		// exceeds the 12000-char featured budget, forcing overflow into the index.
		const fillerName = 'featured-filler';
		const fillerContents = Array.from({ length: 13 }, (_, i) =>
			`filler-${i}-${'x'.repeat(990)}`);
		await store.createEntities([
			{ name: fillerName, entityType: 'note', observations: fillerContents },
		]);
		await store.setObservationMetadata(
			fillerContents.map((content) => ({
				entityName: fillerName, content, importance: 5, contextLayer: 'L1' as const,
			})),
		);

		// A separate low-importance L1 entity whose single observation is guaranteed
		// to be unfeatured (importance 1 sorts last) → it lands in L1Index.
		const overflowName = 'overflow-entity';
		const overflowContent = 'this overflow observation is definitely longer than one hundred characters so the auto-hint gets truncated with an ellipsis';
		await store.createEntities([
			{ name: overflowName, entityType: 'topic', observations: [overflowContent] },
		]);
		await store.setObservationMetadata([
			{ entityName: overflowName, content: overflowContent, importance: 1, contextLayer: 'L1' },
		]);

		const res = await client.callTool({ name: 'get_context_layers', arguments: {} });
		const sc = res.structuredContent as {
			L1Index?: Array<{ entityName: string; entityType: string; observationCount: number; hint: string }>;
		};

		expect(sc.L1Index).toBeDefined();
		const overflowEntry = sc.L1Index!.find((e) => e.entityName === overflowName);
		expect(overflowEntry).toBeDefined();
		expect(overflowEntry!.entityType).toBe('topic');
		expect(overflowEntry!.observationCount).toBe(1);
		expect(typeof overflowEntry!.hint).toBe('string');
		expect(overflowEntry!.hint.length).toBeGreaterThan(0);
	});

	// ------------------------------------------------------------------
	// (b) summary Zod binds on the production schema
	// ------------------------------------------------------------------
	// set_observation_metadata's summary field is .min(1).max(200).nullable(). This
	// exercises the real chain through the SDK: 201 chars rejected, '' rejected, a
	// valid summary accepted AND reflected as the L1Index hint on the next read.
	it('(b) enforces summary bounds and reflects a valid summary in the L1Index hint', async () => {
		// One overflow L1 entity (importance 1) that will appear in L1Index — plus
		// featured filler so the featured budget overflows and the index is built.
		const fillerName = 'summary-filler';
		const fillerContents = Array.from({ length: 13 }, (_, i) =>
			`sfiller-${i}-${'x'.repeat(990)}`);
		await store.createEntities([
			{ name: fillerName, entityType: 'note', observations: fillerContents },
		]);
		await store.setObservationMetadata(
			fillerContents.map((content) => ({
				entityName: fillerName, content, importance: 5, contextLayer: 'L1' as const,
			})),
		);

		const targetName = 'summary-target';
		const targetContent = 'original content that is comfortably longer than one hundred characters so its auto-hint differs from the explicit summary we will set';
		await store.createEntities([
			{ name: targetName, entityType: 'topic', observations: [targetContent] },
		]);
		await store.setObservationMetadata([
			{ entityName: targetName, content: targetContent, importance: 1, contextLayer: 'L1' },
		]);

		// 201 chars → over the .max(200) bound → rejected.
		const tooLong = await callExpectingError('set_observation_metadata', {
			updates: [{ entityName: targetName, content: targetContent, summary: 'y'.repeat(201) }],
		});
		expect(tooLong.isError).toBe(true);

		// '' → under the .min(1) bound → rejected.
		const empty = await callExpectingError('set_observation_metadata', {
			updates: [{ entityName: targetName, content: targetContent, summary: '' }],
		});
		expect(empty.isError).toBe(true);

		// A valid ≤200 summary → success (updated:1).
		const validSummary = 'concise hand-written summary override';
		const ok = await client.callTool({
			name: 'set_observation_metadata',
			arguments: { updates: [{ entityName: targetName, content: targetContent, summary: validSummary }] },
		});
		expect((ok.structuredContent as { updated: number }).updated).toBe(1);

		// The next get_context_layers must show the summary as this entity's hint
		// (buildL1Index uses `summary ?? first-100-chars`, and this entity has one obs).
		const res = await client.callTool({ name: 'get_context_layers', arguments: {} });
		const sc = res.structuredContent as {
			L1Index?: Array<{ entityName: string; hint: string }>;
		};
		const entry = sc.L1Index!.find((e) => e.entityName === targetName);
		expect(entry).toBeDefined();
		expect(entry!.hint).toBe(validSummary);
	});

	// (Case (c) — rankingUnavailable surfaced from a JSONL store — was removed in
	// the v1.6.0 JSONL retirement: the backend and the flag both no longer exist.
	// Case (a) still covers the tools/list declaration-guard pattern.)

	// ------------------------------------------------------------------
	// (d) read_graph relation contract fields survive; unset validFrom is absent
	// ------------------------------------------------------------------
	// RelationOutputSchema declares from/to/relationType/createdAt (always present)
	// and validFrom/validUntil (present only when the caller set them). This pins
	// both: the declared fields come through, and an unset optional is ABSENT rather
	// than emitted as '' or null.
	it('(d) returns relation contract fields and omits unset validFrom', async () => {
		await client.callTool({
			name: 'create_entities',
			arguments: { entities: [
				{ name: 'Alice', entityType: 'person', observations: ['a'] },
				{ name: 'Bob', entityType: 'person', observations: ['b'] },
			] },
		});
		await client.callTool({
			name: 'create_relations',
			arguments: { relations: [{ from: 'Alice', to: 'Bob', relationType: 'knows' }] },
		});

		const res = await client.callTool({ name: 'read_graph', arguments: {} });
		const sc = res.structuredContent as {
			relations: Array<Record<string, unknown>>;
		};
		expect(sc.relations.length).toBeGreaterThanOrEqual(1);
		const rel = sc.relations[0];
		expect(rel.from).toBe('Alice');
		expect(rel.to).toBe('Bob');
		expect(rel.relationType).toBe('knows');
		expect(typeof rel.createdAt).toBe('string');
		// Optional-absent contract: no valid-time was set, so the key must not appear.
		expect('validFrom' in rel).toBe(false);
	});

	// ------------------------------------------------------------------
	// (e) create_entities reports a skipped collision through the output schema
	// ------------------------------------------------------------------
	// CreateEntitiesResult's `skipped` array (SkippedEntitySchema) is how a
	// name-collision is surfaced (#58). Creating the same entity twice must report
	// the second as skipped through the SDK-validated structuredContent.
	it('(e) reports a name-collision as skipped in create_entities output', async () => {
		const args = { entities: [{ name: 'Dup', entityType: 'thing', observations: ['x'] }] };
		await client.callTool({ name: 'create_entities', arguments: args });
		const second = await client.callTool({ name: 'create_entities', arguments: args });

		const sc = second.structuredContent as {
			created: Array<unknown>;
			skipped: Array<{ name: string }>;
		};
		expect(sc.created).toHaveLength(0);
		expect(sc.skipped).toHaveLength(1);
		expect(sc.skipped[0].name).toBe('Dup');
	});

	// ------------------------------------------------------------------
	// (f) rerank stays REMOVED from find_precedents' advertised surface
	// ------------------------------------------------------------------
	// The DEF-RR-02 blind gate failed permanently (rerank-on won 3/18), so the
	// param was removed from the MCP boundary on 2026-07-04 (Dustin-approved).
	// This pins the ADVERTISED inputSchema — the binding surface (see the header
	// comment) — so the param can't silently reappear in a refactor. The
	// store-level option remains for programmatic experiments; only the tool
	// surface is closed.
	it('(f) does not advertise a rerank parameter on find_precedents', async () => {
		const tools = await client.listTools();
		const fp = tools.tools.find((t) => t.name === 'find_precedents');
		expect(fp).toBeDefined();
		const inProps = (fp!.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
		expect('rerank' in inProps).toBe(false);
		// Positive control: a real param is present, so an empty/missing properties
		// object can't vacuously pass the absence check above.
		expect('minSimilarity' in inProps).toBe(true);
		const outProps = (fp!.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
		expect('rerankApplied' in outProps).toBe(false);
		expect('precedents' in outProps).toBe(true);
	});

	// (g) prospective-memory tools are advertised (v1.7.0)
	// ------------------------------------------------------------------
	// The four new tools must appear in tools/list, and
	// check_prospective_triggers must DECLARE vectorSearchEnabled in its
	// advertised outputSchema — that flag is the caller's only signal that an
	// empty `fired` came from a degraded run rather than "no matches", so it has
	// to be part of the discovered contract (the SDK does not add undeclared keys
	// for the client, so an undeclared flag would be invisible at discovery).
	it('(g) advertises the four prospective-memory tools with their output contracts', async () => {
		const tools = await client.listTools();
		const names = tools.tools.map((t) => t.name);
		for (const n of ['set_prospective_trigger', 'check_prospective_triggers', 'list_prospective_triggers', 'delete_prospective_triggers']) {
			expect(names).toContain(n);
		}
		const check = tools.tools.find((t) => t.name === 'check_prospective_triggers');
		const checkOut = (check!.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
		expect('vectorSearchEnabled' in checkOut).toBe(true);
		expect('fired' in checkOut).toBe(true);
		// set_prospective_trigger advertises the trigger output object.
		const set = tools.tools.find((t) => t.name === 'set_prospective_trigger');
		const setOut = (set!.outputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
		expect('trigger' in setOut).toBe(true);
	});
});
