# Retrieval Ranking & Hygiene (v1.3.0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.
>
> **READ FIRST:** the design spec
> `docs/superpowers/specs/2026-07-02-retrieval-ranking-and-hygiene-design.md` — §12 is the quality
> contract, §3 the verified facts, §4-§10 the DECIDED designs. Do not re-litigate decisions here.

## Status (updated 2026-07-02, ~03:50 PDT)
Phase: A of 7 — COMPLETE including full three-phase QA (Discussion #82) + stabilization fixes
Done: Tasks A1-A4 (commits 3c4ab71/a622cf4/1e1b899/c2f1cb5) + QA stabilization commit: 6-agent
  Phase A review, 30-reply Phase B cross-exam, Phase C synthesis all on Discussion #82; fixes
  applied (toFtsQuery zero-token/NUL hardening, rankingDegraded flag, JSONL cursor guard,
  migration IMMEDIATE + in-txn recheck, clampLimit floor, wrong-comment fix, 17 new tests).
  Both pools green (627 + 12 = 639). Pre-existing eviction bug found by review → Issue #83.
Next: Phase B Task B1 (migration v12 access_count + touch increments)
Blocked: nothing

**Goal:** Relevance-ranked hybrid search, retrieval strengthening, graph hygiene, valid-time
fields, graph-aware precedent rerank, and a gated embedding-model eval — the full approved output
of the 2026-07-02 audit.

**Architecture:** All server phases extend `SqliteStore` + `index.ts` tool schemas; two new pure
modules (`rank-fusion.ts`, `pagerank.ts`) carry the testable math; schema migrations v11-v15 in
strict order; harness Phase D touches only `~/.claude/hooks/` prompt files.

**Tech Stack:** TypeScript/Node 22, better-sqlite3 (bundled SQLite FTS5), sqlite-vec,
@huggingface/transformers, Zod, Vitest.

## Global Constraints
- Schema order is LAW: v11(A) → v12(B) → v13(C) → v14(F) → v15(G). D and E have no migrations.
- Defaults preserve current behavior: `orderBy` defaults `'recency'`, `rerank` defaults `false`.
- Pool 1 test command: `~/.local/bin/bounded-run env MEMORY_VECTOR_SEARCH=off SKIP_VECTOR_INTEGRATION=1 npx vitest run --exclude '**/vector-integration.test.ts'`
- Pool 2 test command: `~/.local/bin/bounded-run env MEMORY_VECTOR_SEARCH=on npx vitest run __tests__/vector-integration.test.ts --pool=forks --poolOptions.forks.singleFork=true`
- Build: `npm run build` must be clean (tsc strict) before every commit. Zero warnings (P10 rule 10).
- Never touch the live `~/.claude/.../memory.db` in tests or manual probes — copy it and point
  `MEMORY_FILE_PATH` at the copy.
- Every phase closes with: project CLAUDE.md updated + this Status block updated + deviation
  summary appended below + per-phase QA review (spec §12.8).
- Commit style: existing repo convention (`feat:`/`fix:`/`test:`/`docs:` + Claude trailer).

## Deferments register
| ID | Sev | Title | Target | Status |
|---|---|---|---|---|
| DEF-RR-01 | MED | `as_of_valid` query filtering on valid-time fields | when a real query need appears | open (by design, spec §8.3) |
| DEF-RR-02 | MED | Flip `rerank` default after blind gate | Phase E gate | open |
| DEF-RR-03 | LOW | `access_count` as eviction-tier signal | indefinite | open (comment-only note) |
| DEF-RR-04 | LOW | Two-connection migration race test (child-process harness) | indefinite | open (Phase A QA #9) |

---

# Phase A — FTS5 + weighted RRF for `search_nodes` (spec §4)

### Task A1: FTS5 probe + migration v11 (table, triggers, rebuild)

**Files:**
- Modify: `sqlite-store.ts` (migration chain — grep `version = 10` for the v10 block, add v11 after it)
- Test: `__tests__/migration-validation.test.ts` (append), `__tests__/fts-search.test.ts` (create)

**Interfaces:**
- Produces: `obs_fts` FTS5 table (external content on `observations`, rowid=`observations.id`) +
  three sync triggers `obs_fts_ai` / `obs_fts_ad` / `obs_fts_au`. Later tasks rely on these names.

- [ ] **Step 1: Write the failing tests** in `__tests__/fts-search.test.ts`:

```typescript
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

describe('FTS5 availability + v11 migration', () => {
	// Probe FIRST (spec §3 "unverified assumption"): better-sqlite3's bundled SQLite must have
	// FTS5 compiled in. If this one test fails, STOP Phase A and surface to Dustin.
	it('bundled SQLite has FTS5', () => {
		const db = new Database(':memory:');
		expect(() => db.exec("CREATE VIRTUAL TABLE t USING fts5(c)")).not.toThrow();
		db.close();
	});

	it('v11 creates obs_fts, indexes existing rows, and triggers keep it in sync', async () => {
		// Use the standard SqliteStore test fixture pattern from knowledge-graph.test.ts
		// (temp-dir store). After init(): schema_version === 11 (or later), and:
		const store = await makeTempSqliteStore(); // reuse/extract the existing helper
		await store.createEntities([{ name: 'FtsProbe', entityType: 'test', observations: ['the zebra crossed the qualifier'] }]);
		const hit = rawDb(store).prepare(
			`SELECT o.entity_id FROM obs_fts JOIN observations o ON o.id = obs_fts.rowid
			 WHERE obs_fts MATCH '"zebra"'`).all();
		expect(hit.length).toBe(1);
		// supersede leaves the row IN the index (filtered at query time by superseded_at join):
		await store.deleteObservations([{ entityName: 'FtsProbe', contents: ['the zebra crossed the qualifier'] }]);
		const stillIndexed = rawDb(store).prepare(`SELECT rowid FROM obs_fts WHERE obs_fts MATCH '"zebra"'`).all();
		expect(stillIndexed.length).toBe(1); // index unchanged — the JOIN filter is the correctness layer
	});
});
```
(`rawDb` = the pattern eviction tests already use to reach the Database handle; reuse it.
If no such helper is exported, add a test-only accessor the way `eviction.test.ts` does — check
that file first and copy its approach exactly.)

- [ ] **Step 2: Run Pool 1, verify the new tests FAIL** (no obs_fts table yet). Expected: probe
  test PASSES (FTS5 present), migration test FAILS. If the probe FAILS: stop, report (spec §12.9).

- [ ] **Step 3: Implement migration v11** after the v10 block in `sqlite-store.ts` (match the
  existing migration commenting style — say WHY triggers, WHY index-everything):

```typescript
// ── v10 → v11: FTS5 full-text index over observation content ─────────────────
// External-content FTS5 table + sync TRIGGERS (not code-level sync): triggers also
// cover evict.ts's raw-SQL writes, which bypass GraphStore by design. The index holds
// ALL observations — supersede only UPDATEs superseded_at (no content trigger fires) —
// so active-only filtering lives in ONE place: the query-time JOIN ... superseded_at = ''.
// tokenize: unicode61 with diacritic folding — improves on LIKE's ASCII-only case folding.
if (version < 11) {
	const migrateV11 = this.db.transaction(() => {
		this.db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts USING fts5(
				content,
				content='observations',
				content_rowid='id',
				tokenize='unicode61 remove_diacritics 2'
			);
			CREATE TRIGGER IF NOT EXISTS obs_fts_ai AFTER INSERT ON observations BEGIN
				INSERT INTO obs_fts(rowid, content) VALUES (new.id, new.content);
			END;
			CREATE TRIGGER IF NOT EXISTS obs_fts_ad AFTER DELETE ON observations BEGIN
				INSERT INTO obs_fts(obs_fts, rowid, content) VALUES ('delete', old.id, old.content);
			END;
			CREATE TRIGGER IF NOT EXISTS obs_fts_au AFTER UPDATE OF content ON observations BEGIN
				INSERT INTO obs_fts(obs_fts, rowid, content) VALUES ('delete', old.id, old.content);
				INSERT INTO obs_fts(rowid, content) VALUES (new.id, new.content);
			END;
		`);
		// Rebuild pulls every existing observations row into the index in one statement.
		this.db.exec(`INSERT INTO obs_fts(obs_fts) VALUES ('rebuild')`);
		this.db.prepare('UPDATE schema_version SET version = 11').run();
	});
	migrateV11();
}
```

- [ ] **Step 4: Add the forward-migration test** in `migration-validation.test.ts` following that
  file's existing per-version pattern (build a v10 db, init, assert version 11 + `obs_fts` exists +
  a pre-existing row matches).
- [ ] **Step 5: Pool 1 green** (expect full suite green — v11 is additive). **Commit**
  `feat: add FTS5 observation index (schema v11)`.

### Task A2: `rank-fusion.ts` — pure fusion + sanitizer + activation math

**Files:**
- Create: `rank-fusion.ts`
- Test: `__tests__/rank-fusion.test.ts` (create; Pool 1, model-free — same rationale as
  `precedent-ranking.test.ts`)

**Interfaces:**
- Produces (later tasks import these exact signatures):
  - `toFtsQuery(raw: string): string`
  - `interface RankedList<K> { weight: number; ids: K[] }`
  - `fuseRanks<K>(lists: RankedList<K>[]): Map<K, number>` (k=60 internal constant)
  - `activationScore(accessCount: number, lastAccessedAt: string, nowMs: number): number`

- [ ] **Step 1: Failing tests.** Assert (order derived by hand in test comments — never by calling
  the function; spec §12.5):

```typescript
describe('fuseRanks', () => {
	it('ranks an id on two lists above an id on one list (equal weights)', () => {
		// A: rank0 both lists → 2 × 1/61 ≈ 0.0328;  B: rank0 one list → 1/61 ≈ 0.0164
		const s = fuseRanks([{ weight: 1, ids: ['A', 'B'] }, { weight: 1, ids: ['A'] }]);
		expect(s.get('A')!).toBeGreaterThan(s.get('B')!);
	});
	it('weight scales a list contribution linearly', () => {
		const s = fuseRanks([{ weight: 0.5, ids: ['A'] }]);
		expect(s.get('A')!).toBeCloseTo(0.5 / 61, 10);
	});
});
describe('toFtsQuery', () => {
	it('quotes tokens so operators are literal', () => {
		expect(toFtsQuery('hook AND memory*')).toBe('"hook" "AND" "memory*"');
	});
	it('doubles embedded quotes', () => { expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""'); });
	it('empty/whitespace input yields a no-match query', () => { expect(toFtsQuery('  ')).toBe('""'); });
});
describe('activationScore', () => {
	it('more accesses at equal recency scores higher', () => {
		const now = Date.parse('2026-07-02T00:00:00Z');
		const t = '2026-07-01T00:00:00Z';
		expect(activationScore(10, t, now)).toBeGreaterThan(activationScore(2, t, now));
	});
	it('never-accessed ranks below any accessed', () => {
		const now = Date.parse('2026-07-02T00:00:00Z');
		expect(activationScore(0, '', now)).toBe(-Infinity);
		expect(activationScore(1, '2026-01-01T00:00:00Z', now)).toBeGreaterThan(-Infinity);
	});
});
```

- [ ] **Step 2: Run, verify FAIL** (module missing).
- [ ] **Step 3: Implement** (comment the WHY per spec §12.4 — rank fusion over score fusion,
  k=60 literature default, activation-never-nominates lives at the CALLER):

```typescript
// rank-fusion.ts — pure ranking math for hybrid search. No DB, no model: everything here
// is unit-testable in Pool 1 (same design rationale as rankAndFloorPrecedents).
const RRF_K = 60; // standard damping constant from the RRF literature; not configurable (YAGNI)

export interface RankedList<K> { weight: number; ids: K[] } // ids best-first

// Weighted Reciprocal Rank Fusion. WHY ranks, not scores: BM25, cosine, and activation live
// on incomparable scales; rank-based fusion needs no normalization and is robust to outliers.
export function fuseRanks<K>(lists: RankedList<K>[]): Map<K, number> {
	const scores = new Map<K, number>();
	for (const list of lists) {
		list.ids.forEach((id, idx) => {
			scores.set(id, (scores.get(id) ?? 0) + list.weight / (RRF_K + idx + 1));
		});
	}
	return scores;
}

// Wrap every whitespace token in double quotes (embedded " doubled) so FTS5 operator
// syntax in user input (AND/OR/NOT/NEAR/*/^/-) is matched literally, never executed.
export function toFtsQuery(raw: string): string {
	const tokens = raw.split(/\s+/).filter(t => t.length > 0);
	if (tokens.length === 0) return '""';
	return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// ACT-R base-level activation, two-parameter approximation: ln(1+n) − d·ln(1+hours since
// last access), d=0.5 (ACT-R canonical). We don't store per-access timestamps — YAGNI.
// Returns -Infinity for never-accessed so callers can rank them last deterministically.
export function activationScore(accessCount: number, lastAccessedAt: string, nowMs: number): number {
	if (accessCount <= 0 || !lastAccessedAt) return -Infinity;
	const last = Date.parse(lastAccessedAt);
	if (Number.isNaN(last)) return -Infinity; // sentinel '0000-00-00…' parses NaN — rank last
	const hours = Math.max(0, (nowMs - last) / 3_600_000);
	return Math.log(1 + accessCount) - 0.5 * Math.log(1 + hours);
}
```

- [ ] **Step 4: Pool 1 green. Commit** `feat: add rank-fusion module (RRF, FTS sanitizer, ACT-R activation)`.

### Task A3: `searchNodes` relevance mode (store layer)

**Files:**
- Modify: `sqlite-store.ts` — `searchNodes` (grep `async searchNodes`), signature gains
  `orderBy?: 'recency' | 'relevance'`; `types.ts` `GraphStore.searchNodes` signature +
  `PaginatedKnowledgeGraph` gains optional `rankingUnavailable?: boolean`
- Modify: `jsonl-store.ts` — accept the param, always return recency order + `rankingUnavailable: true` when `'relevance'` requested
- Test: `__tests__/fts-search.test.ts` (extend)

**Interfaces:**
- Consumes: `fuseRanks`, `toFtsQuery` from Task A2; `obs_fts` from Task A1.
- Produces: `searchNodes(query, projectId?, pagination?, asOf?, memoryType?, orderBy?)`.

- [ ] **Step 1: Failing tests** (Pool 1 — vectors OFF, so fusion runs on LIKE+FTS lists only;
  that degradation path is itself worth the test):

```typescript
it('relevance mode ranks a dense-match entity above a recency winner', async () => {
	// Ent A: one old observation matching BOTH tokens strongly (FTS rank 1 + LIKE hit).
	// Ent B: recent but matches only via a weak single-token LIKE hit.
	// Recency mode returns B first (newer updated_at); relevance mode must return A first.
	// (Construct A's obs = 'vector search threshold calibration for vector search', B's obs =
	// 'unrelated note that mentions vector once', then bump B's updated_at by re-adding an obs.)
	const rel = await store.searchNodes('vector search', undefined, { limit: 10 }, undefined, undefined, 'relevance');
	expect(rel.entities[0].name).toBe('EntA');
	const rec = await store.searchNodes('vector search', undefined, { limit: 10 });
	expect(rec.entities[0].name).toBe('EntB'); // guards recency mode unchanged
});
it('relevance mode returns nextCursor null and honors limit', async () => { /* top-k contract */ });
it('relevance mode respects projectId and memoryType filters', async () => { /* reuse existing filter fixtures */ });
it('superseded observations do not contribute FTS rank', async () => { /* supersede A's obs, rank drops */ });
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Inside `searchNodes`, after the existing `matched_ids` CTE machinery
  (KEEP IT — minimal diff; it stays the LIKE candidate list AND the filter authority): when
  `orderBy === 'relevance'`:
  1. Run the existing CTE query WITHOUT the cursor condition, `ORDER BY updated_at DESC, id DESC`,
     no LIMIT → LIKE-ranked candidate id list + `totalCount`.
  2. FTS entity list (same project/memoryType/active filters applied via joins):
     ```sql
     SELECT o.entity_id AS id, MIN(bm25(obs_fts)) AS best
     FROM obs_fts
     JOIN observations o ON o.id = obs_fts.rowid AND o.superseded_at = ''
     JOIN entities e ON e.id = o.entity_id AND e.superseded_at = ''
     WHERE obs_fts MATCH ?            -- toFtsQuery(query)
       [AND o.memory_type = ?]        -- when memoryType set
       [AND (e.project = ? OR e.project IS NULL)]  -- when projectId set
     GROUP BY o.entity_id ORDER BY best ASC LIMIT 200
     ```
     (bm25() is lower-is-better — ASC. Wrap the MATCH in try/catch; a sanitizer bug must degrade
     to no-FTS-list, not throw — log to stderr like other best-effort paths.)
  3. Vector entity list: reuse the EXACT existing hybrid-KNN augmentation code path that
     `searchNodes` already runs (grep for the vector-augmentation block inside searchNodes; it
     produces vector-matched entities best-cosine-first) — refactor its output into a ranked id
     list rather than duplicating the query. Skip when the pipeline isn't ready (status ≠ ready),
     exactly as today.
  4. `fuseRanks([{weight: 1, ids: likeIds}, {weight: 1, ids: ftsIds}, {weight: 1, ids: vecIds}])`,
     sort ids by fused score DESC (tie-break: id DESC for determinism), slice to `limit`
     (clamped default 40), hydrate through the SAME entity/observation/relation hydration the
     recency path uses (extract shared hydration into a private helper ONLY if the code is
     verbatim-identical; otherwise duplicate the small mapping — minimal diff beats DRY here).
  5. Return `nextCursor: null`, `totalCount` from step 1.
- [ ] **Step 4: Pool 1 green** — including the FULL existing suite untouched (recency behavior
  frozen). **Step 5: Commit** `feat: relevance-ranked hybrid search (FTS5+RRF) in searchNodes`.

### Task A4: tool surface (`index.ts`) + docs

**Files:**
- Modify: `index.ts` — `search_nodes` registration (grep `search_nodes`): add
  `orderBy: z.enum(['recency','relevance']).optional()` with a description that says WHEN to use
  relevance (goal-C: the description is the UX); add the Zod `.superRefine` rejecting
  `cursor`+relevance and `asOf`+relevance with explicit messages; pass through to the store.
- Modify: `CLAUDE.md` — architecture bullet (index.ts + sqlite-store.ts sections), Known
  Limitations (relevance mode: no cursor, no asOf, JSONL falls back), test counts.
- Test: `__tests__/mcp-tools.test.ts` — schema validation cases (valid enum, cursor+relevance
  rejected, asOf+relevance rejected).

- [ ] Steps: failing schema tests → implement → Pool 1 green → `npm run build` →
  **manual real-artifact probe (spec §12.7):** copy the live db to the scratchpad, run the built
  server against the copy, call `search_nodes {query:"vector search threshold", orderBy:"relevance"}`
  and eyeball that the top hits beat recency mode's → commit
  `feat: expose orderBy on search_nodes tool + docs`.
- [ ] **Phase close:** QA review (spec §12.8) → deviation summary appended here → Status block
  updated → CLAUDE.md test counts refreshed.

---

# Phase B — Retrieval strengthening (spec §5)

### Task B1: migration v12 + touch increments

**Files:** `sqlite-store.ts` (v12 after v11; `touchEntities` `:1012` / `touchEntitiesByName`
`:1032` — re-grep), tests in `__tests__/eviction.test.ts` (access-discipline block) +
`migration-validation.test.ts`.

- [ ] **Failing tests:** (1) forward v12: `access_count` exists, default 0; (2) `searchNodes` /
  `openNodes` / writes increment it; `readGraph` does NOT (extend the existing access-discipline
  tests — they already enumerate exactly these paths); (3) eviction sweep leaves it untouched.
- [ ] **Implement:**

```typescript
// ── v11 → v12: access_count for retrieval strengthening ──────────────────────
// WHY: last_accessed_at alone can't distinguish "touched once last week" from "reached for
// 40 times" — the ACT-R activation term (rank-fusion.ts) needs the count. Same access-
// discipline boundary as last_accessed_at: readGraph and evict.ts never write it.
if (version < 12) {
	const migrateV12 = this.db.transaction(() => {
		this.db.exec(`ALTER TABLE entities ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
		this.db.prepare('UPDATE schema_version SET version = 12').run();
	});
	migrateV12();
}
```
  and in BOTH touch helpers change the UPDATE to
  `SET last_accessed_at = ?, access_count = access_count + 1`. Add the DEF-RR-03 comment
  ("could feed eviction tiers later; deliberately not wired") at the column's migration.
- [ ] Pool 1 green → commit `feat: track entity access_count (schema v12)`.

### Task B2: activation as fourth RRF list

**Files:** `sqlite-store.ts` (relevance branch from A3), `__tests__/fts-search.test.ts`.

- [ ] **Failing test:** two entities with identical LIKE+FTS rank profiles (same obs content,
  different names); touch one via `openNodes` several times; relevance search ranks the touched
  one first. Plus the guard test: an entity with HIGH activation but NO relevance-list membership
  never appears (activation cannot nominate — construct by touching an unrelated entity).
- [ ] **Implement:** in the relevance branch, after building the candidate union: one query
  `SELECT id, access_count, last_accessed_at FROM entities WHERE id IN (…candidate ids…)`
  (chunk by 900 like `openNodes` does), rank by `activationScore(…, Date.now())` DESC, append
  `{weight: 0.5, ids: activationRanked}` to the fusion. Comment WHY weight 0.5 and why it only
  reranks (spec §5.4 verbatim reference).
- [ ] Pool 1 green → `npm run build` → commit `feat: blend ACT-R activation into relevance ranking`.
- [ ] **Phase close** (QA, deviation summary, Status, CLAUDE.md — access-discipline section gains
  the access_count sentence).

---

# Phase C — Relation-vocabulary hygiene (spec §6)

### Task C1: migration v13 (data fix, explicit map)

**Files:** `sqlite-store.ts` (v13), `relation-types.ts` (export the map),
`__tests__/migration-validation.test.ts` + `__tests__/relation-types.test.ts`.

- [ ] **Failing tests:** build a store; insert relations with drifted spellings (via raw SQL at
  v12 fixture or through createRelations BEFORE C2 lands); run v13; assert: `belongs to` →
  `belongs_to`; collision case (both `has_file` AND `contains_file` active between same pair) →
  the drifted row is soft-retired (superseded_at set), target row intact, no UNIQUE crash;
  superseded rows untouched.
- [ ] **Implement** in `relation-types.ts`:

```typescript
// One-time v13 vocabulary repairs, from the 2026-07-02 live-graph audit (128 distinct
// spellings across 501 edges). EXPLICIT REVIEWED MAP, not an algorithm: every entry was
// individually approved. Direction-differing verbs (tests / is tested by) are deliberately
// NOT merged. Also consumed by nothing else — createRelations canonicalization (C2) uses
// live lookups, not this frozen list.
export const RELATION_VOCAB_FIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
	['belongs to', 'belongs_to'], ['belongs-to', 'belongs_to'],
	['contains-file', 'contains_file'], ['has_file', 'contains_file'], // semantic merge, approved
	['PART_OF', 'part_of'], ['is part of', 'part_of'],
	['occurred in', 'occurred_in'], ['occurred during', 'OCCURRED_DURING'],
	['PRECEDENT_FOR robust-build procedure on', 'PRECEDENT_FOR'],
]);
```
  and in the migration, per mapping inside ONE transaction — retire-then-rewrite (spec §6.2):

```typescript
if (version < 13) {
	const now = new Date().toISOString();
	const migrateV13 = this.db.transaction(() => {
		for (const [from, to] of RELATION_VOCAB_FIXES) {
			// Retire drifted rows whose rewrite would collide with an existing active row
			// (UNIQUE(from,to,type,superseded_at)) — soft-retire, never delete, never crash.
			this.db.prepare(
				`UPDATE relations SET superseded_at = ? WHERE relation_type = ? AND superseded_at = ''
				 AND EXISTS (SELECT 1 FROM relations r2 WHERE r2.from_entity = relations.from_entity
				   AND r2.to_entity = relations.to_entity AND r2.relation_type = ? AND r2.superseded_at = '')`
			).run(now, from, to);
			this.db.prepare(
				`UPDATE relations SET relation_type = ? WHERE relation_type = ? AND superseded_at = ''`
			).run(to, from);
		}
		this.db.prepare('UPDATE schema_version SET version = 13').run();
	});
	migrateV13();
}
```
- [ ] Pool 1 green → commit `fix: normalize drifted relation-type spellings (schema v13)`.

### Task C2: write-time canonicalization in `createRelations`

**Files:** `sqlite-store.ts` (`createRelations`, grep it), `jsonl-store.ts` (same logic — it's
~15 lines; implement in both, sharing the key-normalizer via `relation-types.ts`),
`__tests__/knowledge-graph.test.ts` (parameterized block → runs against both backends).

- [ ] **Failing tests:** (1) `caused_by` / `Caused-By` input → stored as `CAUSED_BY` (core vocab
  canonical); (2) input `belongs-to` when `belongs_to` exists active → stored `belongs_to`;
  (3) genuinely novel type `orbits` → stored verbatim (open vocabulary preserved); (4) ambiguous
  key matching TWO existing spellings → stored verbatim (never guess).
- [ ] **Implement:** in `relation-types.ts` add
  `export const relationTypeKey = (t: string) => t.toLowerCase().replace(/[\s\-]+/g, '_');`
  In `createRelations`, before insert: build `Map(key → spelling)` from `CORE_RELATION_TYPES`
  first, then `SELECT DISTINCT relation_type FROM relations WHERE superseded_at = ''` (core wins
  on key collision; a key mapping to >1 existing spelling → leave input as-is). Comment: this is
  an ADVISORY that stops same-verb fragmentation; open vocabulary is a standing decision
  (DEF-CG-03) — do not turn this into an enum.
- [ ] Pool 1 green → `npm run build` → **Phase close** (QA slim, deviation summary, Status,
  CLAUDE.md relation-types section + Known Limitations note that JSONL shares this behavior).

---

# Phase D — memoryType at capture (harness prompts; no server code)

**Files (live, outside repo — Prompt & Config Editing rule applies: state intent, edit, re-read
each COMPLETE file, check internal consistency):**
- Modify: `~/.claude/hooks/sessionend-prompt.md`, `~/.claude/hooks/precompact-prompt.md`,
  `~/.claude/hooks/periodic-memory-check.sh` (the checkpoint instruction text inside it),
  `harness/prompts/memory-consolidation.md` AND its live deployed copy (locate via the path
  referenced in `consolidation-settings.json` / the consolidator service — verify, don't assume).

- [ ] **Step 1:** In each capture prompt, in the section instructing `add_observations` writes,
  insert this directive (adapt surrounding voice; keep it ONE tight block):

```
Every add_observations call MUST set memoryType. Pick the closest: decision, procedure, fact,
status, preference, problem, architecture, milestone, win, introspective, emotional, narrative,
relational, feedback. If genuinely none fits, use 'fact'. Untyped observations are invisible to
every memoryType-filtered query — an untyped memory is a half-lost memory.
```
- [ ] **Step 2:** In the consolidation prompt add one pass instruction: "Each run, classify up to
  50 of the oldest observations with memory_type NULL into the list above (set_observation_metadata);
  skip any whose type is genuinely ambiguous rather than guessing." (Respect the existing
  experiential-protection rules in that prompt — classification only, never content edits.)
- [ ] **Step 3:** Re-read all four complete files; `grep -l "MUST set memoryType"` across them to
  verify. No tests (prompt files); verification is the re-read + grep.
- [ ] **Step 4:** Commit repo mirror change; note live-file edits in the deviation summary (live
  `~/.claude` files aren't in this repo — the mirror + this plan are the record).

---

# Phase E — PPR-lite rerank for `find_precedents` (spec §9; needs A)

### Task E1: `pagerank.ts`

**Files:** Create `pagerank.ts`; test `__tests__/pagerank.test.ts` (Pool 1, pure).

- [ ] **Failing tests** (hand-derived expectations in comments): (1) star graph seeded at center:
  center > leaves > non-connected; (2) two-hop chain A-B-C seeded at A: B > C > D(isolated);
  (3) empty edges → returns seeds only; (4) determinism (two runs identical).
- [ ] **Implement:**

```typescript
// pagerank.ts — bounded personalized PageRank over the ACTIVE relation edges (~500 rows:
// this is milliseconds of pure JS; no need for sparse-matrix machinery). Edges are treated
// as UNDIRECTED for diffusion — relatedness flows both ways even when the verb is directed.
// alpha = restart probability mass returned to seeds each iteration; 3 iterations reaches
// ~3 hops, matching get_connected_context's default horizon.
export function personalizedPageRank(
	edges: ReadonlyArray<readonly [string, string]>,
	seeds: ReadonlyMap<string, number>,          // node → seed weight (e.g. cosine), need not be normalized
	opts: { alpha?: number; iterations?: number } = {},
): Map<string, number> {
	const alpha = opts.alpha ?? 0.5;
	const iterations = opts.iterations ?? 3;     // bounded loop (P10 rule 2): fixed small cap
	const neighbors = new Map<string, string[]>();
	for (const [a, b] of edges) {
		if (a === b) continue;                    // self-loops add nothing to diffusion
		(neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
		(neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
	}
	const seedTotal = [...seeds.values()].reduce((s, v) => s + v, 0) || 1;
	const seedProb = new Map([...seeds].map(([k, v]) => [k, v / seedTotal]));
	let rank = new Map(seedProb);
	for (let i = 0; i < iterations; i++) {
		const next = new Map<string, number>();
		for (const [node, r] of rank) {
			const ns = neighbors.get(node);
			if (!ns || ns.length === 0) continue;  // dangling mass restarts via the seed term below
			const share = ((1 - alpha) * r) / ns.length;
			for (const n of ns) next.set(n, (next.get(n) ?? 0) + share);
		}
		for (const [k, v] of seedProb) next.set(k, (next.get(k) ?? 0) + alpha * v);
		rank = next;
	}
	return rank;
}
```
- [ ] Green → commit `feat: add bounded personalized-PageRank module`.

### Task E2: wire into `findPrecedents` behind `rerank` (default false)

**Files:** `sqlite-store.ts` (`findPrecedents` — re-grep), `types.ts` (`FindPrecedentsOptions` +
result flag `rerankApplied?: boolean`), `index.ts` (`find_precedents` schema: `rerank:
z.boolean().optional()` with a description saying it's experimental and what it does),
`jsonl-store.ts` (throws already — unchanged), tests in `__tests__/fts-search.test.ts` (Pool 1
degraded path: vectors off → rerank no-ops with flags) + one Pool 2 case in
`__tests__/vector-integration.test.ts` (graph-connected obs outranks isolated equal-cosine obs).

- [ ] **Failing tests first**, per pool as above.
- [ ] **Implement:** when `rerank === true` and vector path is live: fetch `3 × limit` KNN
  candidates (before flooring); floor on raw cosine FIRST (a fused score must never resurrect a
  below-floor match — spec §9.2); build seeds = parent entities of surviving candidates
  (weight = best cosine); edges = `SELECT from_entity, to_entity FROM relations WHERE
  superseded_at = ''`; PPR; fuse per spec weights (vector 1.0 / PPR-of-parent 0.5 / obs-BM25 0.75
  via `toFtsQuery`); take top `limit`; `similarity` shown stays the RAW cosine (rounded for
  display as today) — fusion reorders, it does not fabricate similarity numbers.
- [ ] Green (both pools) → `npm run build` → commit `feat: optional graph-aware rerank for find_precedents`.
- [ ] **Gate (usage-permitting):** blind panel ≥18 real queries × rerank-on vs rerank-off, judges
  blinded per the 2026-06-20 harness pattern; flip default ONLY on ≥12/18 (separate commit). If
  usage is too low to run the panel: leave default false, mark DEF-RR-02 with date + reason.
- [ ] **Phase close** (QA incl. performance-analyst, deviation summary, Status, CLAUDE.md).

---

# Phase F — Valid-time fields (spec §8)

### Task F1: migration v14 + types

**Files:** `sqlite-store.ts` (v14: the two ALTERs on observations + the two on relations —
`valid_from`/`valid_until`, `TEXT NOT NULL DEFAULT ''`), `types.ts` (`Observation` +`Relation`
gain optional `validFrom?`/`validUntil?`; `SetObservationMetadataInput` + `RelationInput` gain the
same as optional inputs), `migration-validation.test.ts` forward test.

- [ ] Failing forward-migration test → implement (pattern identical to v12's ALTER block; one
  transaction, four ALTERs) → green → commit `feat: valid-time columns (schema v14)`.

### Task F2: write/read surface

**Files:** `sqlite-store.ts` (`setObservationMetadata` — add the two fields to its `'key in
object'` update pattern; `createRelations` + relation hydration in `readGraph`/`searchNodes`/
`openNodes`/`entityTimeline` — populate when non-empty), `index.ts` (Zod: same ISO-8601-Z
validation as `asOf` — copy its exact zod chain; add to `set_observation_metadata` +
`create_relations` schemas + output schemas), `jsonl-store.ts` (serialize/deserialize the two
optional fields with backward-compat defaulting, same pattern as temporal relation fields),
tests in `knowledge-graph.test.ts` (both backends: set → read back; omitted → absent;
entity_timeline shows them) + `mcp-tools.test.ts` (Zod rejects non-Z timestamps).

- [ ] Failing tests → implement → both pools green → `npm run build` → real-artifact probe
  (set a validFrom on a scratch-copy observation, read it back via entity_timeline) → commit
  `feat: expose valid-time on set_observation_metadata and create_relations`.
- [ ] **Phase close** (QA slim, deviation summary, Status, CLAUDE.md: architecture + Known
  Limitations "valid-time is caller-supplied, no query filtering yet — DEF-RR-01").

---

# Phase G — Embedding eval + conditional migration (spec §10)

### Task G1 (unconditional): prefix-aware, env-configurable embedder + vec_config (v15)

**Files:** `embedding.ts` (env `MEMORY_EMBED_MODEL` / `MEMORY_EMBED_POOLING` /
`MEMORY_EMBED_QUERY_PREFIX`; `embed(text, kind: 'query' | 'passage' = 'passage')` — prefix applied
ONLY when `kind === 'query'` and prefix non-empty), `sqlite-store.ts` (v15 `vec_config` single-row
table + startup mismatch check: log + `DELETE FROM vec_observations` + update row + let the sweep
re-embed; call-site kinds: findPrecedents query → `'query'`; ALL others → `'passage'`),
`__tests__/vector-search.test.ts` (env plumbing, default unchanged) + `migration-validation.test.ts`
(v15 forward) + one Pool 2 test (model-switch simulation: write vec_config with a fake old name,
restart store, assert vec table cleared and re-swept).

- [ ] Failing tests → implement (comment WHY: model-switch = config flip with self-healing index;
  mismatched vectors are silently garbage, which is the risk this kills) → both pools green →
  commit `feat: env-configurable prefix-aware embedder + vec_config guard (schema v15)`.

### Task G2 (unconditional, python side): in-domain blind eval

**Files:** `~/Claude/memory-graph-viz/concept_embeddings/phase3_candidates.py` (new; adapt
`phase2_base.py` — same harness, same blind-judge protocol).

- [ ] Adapt the harness to run `ibm-granite/granite-embedding-small-english-r2` and
  `Snowflake/snowflake-arctic-embed-s` vs MiniLM (sentence-transformers, the viz venv). VERIFY
  each model card's query-prefix requirement AT BUILD TIME before running (arctic: "Represent
  this sentence for searching relevant passages: " on queries only; granite: check the card —
  do not assume). n ≥ 18 real queries against the current obs corpus.
- [ ] Run the blind judge panel when usage allows (this is the expensive step — agents as judges,
  same protocol as 2026-06-20: identity hidden, A/B order seeded-random, concept-match scoring).
- [ ] **Decision (Dustin in the loop, spec §10.3):** candidate ≥12/18 → propose cutover with the
  measured evidence; tie or loss → server stays MiniLM, record the result in the plan + backlog,
  DONE. Either way the result gets written into this plan doc under "Phase G RESULTS" —
  the 2026-06-19 doc's format is the template.

### Task G3 (CONDITIONAL — only on G2 win + Dustin's explicit go): cutover

- [ ] Back up `memory.db` (the SessionStart backup exists; take a manual one anyway —
  data-preserving before data-destructive). Flip env vars in the MCP server config
  (model + pooling per the winner's card + query prefix). Restart; verify sweep completion
  (`vec_observations` row count returns to active-obs count).
- [ ] **Threshold recalibration (MANDATORY with any model change):** script
  `scripts/recalibrate-thresholds.py` (new, repo `scripts/`): sample ~30 known-near-duplicate
  pairs (query `observations` for same-entity supersede chains — old/new content pairs are
  natural near-dupes) + ~30 random cross-entity pairs; print both cosine distributions under the
  new model; choose thresholds at the same separation percentiles as MiniLM's 0.85/0.80/0.25;
  apply via the constants (grep `0.85` / `0.80` / `0.25` per spec §3) with a comment recording
  the calibration run date + script.
- [ ] Bake-in: keep the backup; rollback = flip env back (vec_config self-heals the re-embed).
- [ ] **Final close-out:** package.json → 1.3.0; CLAUDE.md Version History entry; Status block
  → COMPLETE; full deferment register reconciliation; final QA pass.

---

# Deviation log (append per phase — what changed from plan, why, effect; classify
# deferment / behavioral-change / scope-change / other)

## Phase A (2026-07-02, same session as plan authoring)
1. **[other — implementation detail]** `bm25()` cannot run in an aggregate context, and SQLite's
   query flattener re-breaks a joined subquery ("unable to use function bm25 in the requested
   context" — both forms failed empirically). Final form: per-row scores in a MATERIALIZED
   full-text CTE, joins/aggregation outside. No behavioral effect; documented in the v11
   CLAUDE.md migration entry and a code comment.
2. **[behavioral-change — validation locus]** The plan said Zod-level rejection for
   cursor+relevance / asOf+relevance; `registerTool` takes a per-field ZodRawShape with no
   cross-field refinement hook, so the rejection lives in the store guard (searchNodes throws a
   caller-readable message; handler comment explains why). Caller-visible behavior identical.
3. **[other — test hygiene, small scope add]** Two pre-existing tests pinned the exact end-state
   schema version and broke on v11. Established convention: per-migration tests assert
   "at least N"; ONE exact pin (knowledge-graph.test.ts fresh-database test) is bumped
   deliberately per migration. Documented in the CLAUDE.md tests section.
4. **[deferment — process, RESOLVED same session]** Phase A QA review not yet run at code-complete
   (usage budget); ran in full after ultracode was enabled — six-agent Phase A + 30-reply Phase B
   cross-exam + Phase C synthesis, all on GitHub Discussion #82.

### Phase A QA stabilization (2026-07-02 ~03:50, post-review fixes)
5. **[behavioral-change — hardening]** `toFtsQuery` now strips NUL bytes and drops tokens with no
   letter/digit. My empirical probe PARTIALLY REFUTED the adversarial finding's headline (current
   SQLite treats an empty phrase in an AND chain as a no-op — it does NOT zero the list), so this
   shipped as version-robustness hardening, not a bug fix; lone-punctuation queries and the NUL
   truncation case were real. Probe result recorded in the function comment + round-trip tests.
6. **[behavioral-change — new response field]** `rankingDegraded?: ('fts'|'vector')[]` per
   silent-failure F1 (goal A: degradation changes result membership and must surface). Configured-
   off vector search deliberately NOT flagged (cross-exam consensus: chronic noise trains callers
   to ignore the flag).
7. **[behavioral-change]** JSONL now mirrors the cursor+relevance throw (F2, contract symmetry);
   `clampLimit` floors fractional input; migration v11 runs IMMEDIATE with an in-transaction
   version re-check (the naive deferred re-check would trade a redundant rebuild for a
   SQLITE_BUSY_SNAPSHOT startup crash — caught by three cross-exam lenses independently).
8. **[other — accepted-as-is, with rationale]** relevance-mode totalCount stays candidate-union
   size (documented; subtraction is racy and off-page-blind — adversarial refuted the proposed
   fix); fingerprint-before-branch dead work left (sub-microsecond); 2893/2902 normalize
   inconsistency left (unreachable post-v8, pre-existing pattern); the recency path's silent
   vector-skip left (pre-existing in kind, out of Phase A scope).
9. **[deferment]** DEF-RR-04: two-connection migration race test (single-threaded better-sqlite3
   makes an in-process race a deadlock; needs a child-process harness). Severity LOW — the
   IMMEDIATE+recheck fix is verified by trace from three independent lenses; forward-migration
   tests cover the non-race path. Fix direction: spawn a second connection in a child process,
   assert the loser skips the rebuild. Obsolete if migrations ever move to a single-writer lock file.
10. **[other — pre-existing bug found by review]** Eviction Tier-2 UNIQUE collision → filed as
   Issue #83 (not Phase A scope; multi-agent-verified).
