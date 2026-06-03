# Causal/Precedent Relations + Ranked Precedent Retrieval — Design Spec

## Status (updated 2026-06-03)
Phase: 1 of 1 — **IMPLEMENTED** (folded into the codebase; committed 2026-06-03).
Done: Enh1 (causal/precedent vocab — new `relation-types.ts` + `create_relations` guidance) and Enh2 (`find_precedents` ranked retrieval) shipped. ALSO built beyond this spec at Dustin's direction: `get_connected_context` (bounded multi-hop traversal) + mechanical directed-cycle detection ("D4") — see §9 for why this §2-out-of-scope item was added. Two adversarial review rounds (10 + 5 confirmed findings) addressed under TDD; full suite green (Pool 1 = 583, Pool 2 = 10; tsc clean). No schema change (still v10).
Next: §3.3 usage protocol still pending on Dustin (separate track). Then the experiential-texture effort (Phase 7) resumes — incl. task 7.1 L2 rendering, which `find_precedents`'s raw `contextLayer` must reconcile with (see §9 / DEF-CG-02).
Blocked: nothing. Both enhancements stayed non-schema-changing (no migration, no `schema_version` bump).

---

## §0 Coordination & provenance (READ FIRST — this is a fold-in, not a fresh build)

**Authored by:** a separate Claude session (workspace `~/Claude`, not the memory-server working session), 2026-06-02, as a handoff. It was written *because* another session (you) is actively working on `mcp-memory-server` and Dustin wants to avoid a collision by having you fold this in rather than running it in parallel.

**Authored against a code snapshot taken 2026-06-02 ~14:40 PDT.** Line numbers below are anchors *as of that snapshot*. Your live tree may have moved them (you may have uncommitted changes). **Re-verify every `file:line` anchor against live source before editing** — match by symbol name / behavior, not by line number. Appendix A lists every anchor with its symbol so you can re-locate.

**Collision assessment (verified, not assumed):**
- The active plan dated today — `docs/superpowers/plans/2026-05-30-experiential-texture-continuity.md` (Phase 7/7) — is **mostly behavioral/hooks and explicitly "No schema change."** It does **not** touch the relations path or the search/ranking path. **One** overlap with this spec: its task **7.1 "L2 legibility"** renders `context_layer` `null → "L2"` in MCP tool *outputs* and adds a named `L2` constant. Enhancement 2 (`find_precedents`) returns observations carrying `contextLayer`, so it must render that field the **same** way. See §4.4 — use that change's shared helper/constant if it exists; do not invent a second rendering.
- `delete_observations` was converted hard-`DELETE` → soft-delete (`UPDATE superseded_at`) and is **implemented but pending-commit** (`sqlite-store.ts` ~`1707`, `softDeleteObs`). Expect `sqlite-store.ts` + delete tests to be **dirty** in the working tree. This spec also edits `sqlite-store.ts` (the `createRelations` insert ~`1430`, and a new `findPrecedents` method) — different regions, but the **same large file**, so rebase/stage carefully.
- No `TODO`/`WIP`/`FIXME` markers exist in the relations or search-KNN paths. Phase 6 "Confidence Decay" is unstarted (no half-applied code).
- Project `CLAUDE.md` counts are **stale** (says 17 tools / schema v1–9 / 545 tests; live is **schema v10**, ~541 tests). Trust source over the doc for counts; update the doc when you add the tool.

**If, since this snapshot, you have begun reworking `searchNodes` ranking** (adding relevance/similarity ordering): do **not** add a parallel KNN path. Fold Enhancement 2 in as a *ranking mode* of that work instead of a separate `find_precedents` tool. See §4.1 "Reconciliation."

---

## §1 Background & rationale

### Why these two (and nothing more)
This spec is the actionable residue of evaluating the Neo4j "Context Graph" concept (decision-tracing knowledge graphs: causal chains, precedent matching, graph-data-science) against this memory system. Conclusion: the system is **already ~80% a context graph** — entities/observations/relations, MiniLM text embeddings, full event-clock temporality (`superseded_at`/`tombstoned_at`/`entity_timeline`/`as_of`). The genuinely *missing* pieces that pass this project's anti-bloat gate are exactly two:

1. **Make causal/precedent links first-class** so "why does this rule exist / what incident caused it" is a relation lookup instead of a full-text grep through prose cross-references.
2. **Rank precedent retrieval by similarity** — the system *computes* cosine similarity today (for dedup) but never *ranks* by it, so "find the most similar past decision" is unsupported.

Everything else from the Context Graph thesis (Neo4j migration, FastRP structural embeddings, Louvain community detection, node-similarity fraud detection, multi-hop traversal tooling, graph visualization) is **out of scope** — it needs enterprise-scale density to produce signal and would fail this project's cost-proportionality gate at a single-user store's scale. See §2.

### Anti-bloat gate (per this project's rule: goal-trace + practical-use + cost-proportionality)
| Enhancement | Goal trace | Practical use | Cost | Verdict |
|---|---|---|---|---|
| #1 Causal/precedent vocab | Goal B (recall the *why*) | Turns prose xrefs into queryable edges | No schema change; constants + tool-desc + optional 1-line normalize | **PASS** |
| #2 Ranked `find_precedents` | Goal B (recall similar prior decisions) | Enables "most similar precedent" — currently impossible | No schema change; reuses existing KNN path | **PASS** |

Goals referenced (project `CLAUDE.md` "Project Goals"): **A** reduce drift/hallucination; **B** faithful recall of who/what/when/where/**why**/how incl. actions & decisions; **C** better conversations + code. Both enhancements target **B**.

---

## §2 Scope

**In scope:**
- §3 A small documented causal/precedent relation vocabulary + (optional) light normalization.
- §4 A new read-only `find_precedents` MCP tool: similarity-ranked retrieval of observations.

**Explicitly out of scope (do not build):**
- Neo4j or any graph-DB backend. SQLite + sqlite-vec stays.
- Graph-data-science algorithms (FastRP, Louvain, node similarity, centrality, PageRank).
- Structural/topology node embeddings or hybrid semantic+structural ranking. (Semantic-only.)
- A multi-hop / recursive traversal tool. Single-hop via existing `open_nodes` is sufficient at this scale. (`WITH RECURSIVE` is *possible* in SQLite if ever needed, but not now.)
- Graph visualization UI.
- Any schema/migration change. If you find yourself adding a column or bumping `schema_version`, you've left this spec's scope — stop and reconsider.

---

## §3 Enhancement 1 — Causal/precedent relation vocabulary

### 3.1 Design
`relations.relation_type` is already free-form `TEXT NOT NULL` (`sqlite-store.ts:203`); the tool input is `relationType: z.string().min(1).max(500)` with **no enum** (`RelationInputSchema`, `index.ts:151-155`). So causal/precedent edges are **expressible today** — the gap is that nothing *guides* their use, so they're never created and the corpus relies on prose ("see `feedback_X.md` for incident context"). This enhancement is **non-breaking**: the field stays free-form; we add a documented core vocabulary, expose it as constants, surface it in the tool description, and (optionally) canonicalize case.

**Core vocabulary — exactly three.** Keep it minimal (anti-bloat). Free-form remains allowed for anything else.

| Type | Direction (`from` → `to`) | Meaning | Example |
|---|---|---|---|
| `CAUSED_BY` | effect/dependent → cause/origin | "this exists/happened because of that" | `rule:minimal-diff` —CAUSED_BY→ `incident:opus-4.7-thrash` |
| `PRECEDENT_FOR` | earlier decision → later decision it informs | "this prior decision is a precedent for that one" | `decision:sqlite-backend` —PRECEDENT_FOR→ `decision:vec-search` |
| `SUPERSEDES` | newer → older it replaces | entity/decision-level replacement (distinct from observation-level `superseded_at`) | `decision:2-name-catalog` —SUPERSEDES→ `decision:3-name-catalog` |

**Directionality is a convention the server does not enforce** — it must be documented so every caller (the consumer is Claude itself) reads edges consistently. The table above is the canonical direction. Pick it and never invert.

### 3.2 Code changes

**(a) New constants module** — `src/relation-types.ts` (new file, no collision):
```ts
// src/relation-types.ts
// Core causal/precedent relation vocabulary for the knowledge graph.
//
// WHY a constants module rather than just documentation: it gives find_precedents,
// the create_relations tool description, and any future traversal code a single
// source of truth for the vocabulary, instead of magic strings scattered across files.
// relation_type stays free-form in the schema — these are RECOMMENDED types, not an enum.
export const CORE_RELATION_TYPES = {
  // from = the effect/dependent thing, to = the cause/origin.
  // Read as: "<from> CAUSED_BY <to>"  ("this rule exists because of that incident").
  CAUSED_BY: 'CAUSED_BY',
  // from = the earlier precedent decision, to = the later decision it informs.
  PRECEDENT_FOR: 'PRECEDENT_FOR',
  // from = the newer thing, to = the older thing it replaces (entity/decision level).
  SUPERSEDES: 'SUPERSEDES',
} as const;

export type CoreRelationType = typeof CORE_RELATION_TYPES[keyof typeof CORE_RELATION_TYPES];

// Human-readable directionality, surfaced in the create_relations tool description
// so the calling agent always orients edges the same way.
export const RELATION_TYPE_GUIDANCE =
  'Recommended causal/precedent relation types (relation_type is free-form; these are conventions): ' +
  'CAUSED_BY (from=effect → to=cause, e.g. a rule CAUSED_BY the incident that motivated it); ' +
  'PRECEDENT_FOR (from=earlier decision → to=later decision it informs); ' +
  'SUPERSEDES (from=newer → to=older it replaces). Use UPPER_SNAKE_CASE.';
```

**(b) Surface the vocabulary in the `create_relations` tool description** (`index.ts`, the `registerTool("create_relations", …)` block — re-locate by name). Append `RELATION_TYPE_GUIDANCE` to the existing `description` string, and/or to the `relationType` field's `.describe(...)`. This is the load-bearing change: the consumer is an LLM, so the tool description is where behavior actually changes.

**(c) OPTIONAL light normalization** — canonicalize case so `caused_by` and `CAUSED_BY` don't fork. Single chokepoint is the insert in `createRelations` (`sqlite-store.ts:1430`, currently passes `r.relationType` raw):
```ts
// Canonicalize relation_type to UPPER form so vocabulary variants unify under the
// UNIQUE(from_entity,to_entity,relation_type,superseded_at) constraint.
// Minimal by design: trim + uppercase ONLY. We deliberately do NOT touch separators
// or spaces — that would surprise callers who use intentionally-spaced custom types.
// NOTE: not retroactive — only new inserts are normalized. Existing mixed-case rows stay.
const relType = r.relationType.trim().toUpperCase();
const info = insert.run(fromNorm, toNorm, relType, now);
```
**Decision for you (§8 Q1):** include (c) or not. It's genuinely optional. Trade-off: (c) prevents case-drift and unifies dedup, but introduces a (small) behavior change and a retroactive inconsistency (old rows un-normalized). If you skip it, keep (a)+(b) — the convention + guidance alone is the true smallest-sufficient version. Default recommendation: **include (c)**, it's one line and the UNIQUE-constraint unification is worth it; but it is not load-bearing.

### 3.3 Usage protocol — PENDING addition to workspace `~/Claude/CLAUDE.md` (NOT yet applied)

> ⚠️ **Status: NOT YET APPLIED as of 2026-06-02.** This is the *behavioral* half of Enhancement #1 — *when* the agent should actually create these edges. It belongs in the workspace memory-write policy (`~/Claude/CLAUDE.md`), **not** in the server. It is **Dustin's action item, intentionally deferred** — do **not** edit `CLAUDE.md` from this spec, and the receiving memory-server session should **not** encode usage policy in server code. It's recorded here in full so the behavioral half isn't lost when the server-side tooling ships (without it, the vocab tooling ships but rarely gets exercised).

**Proposed `CLAUDE.md` block (draft — Dustin to review before applying):**

> **Causal/precedent memory relations.** Pairs with the mcp-memory-server `CAUSED_BY` / `PRECEDENT_FOR` / `SUPERSEDES` relation vocabulary. When saving decision/feedback memories, also create the causal/precedent *edge* — turning prose cross-references ("see `feedback_X.md` for incident context") into queryable links that answer "why does this rule exist / what informed this decision":
> - **`CAUSED_BY`** (rule/decision → originating incident): when a memory's justification names a specific incident, link the rule entity → the incident entity instead of only citing it in prose.
> - **`PRECEDENT_FOR`** (earlier decision → the new one it informs): when the Mid-Session "search memory for prior decisions" trigger surfaces a decision that shapes the current one, link them.
> - **`SUPERSEDES`** (newer → older, entity/decision level): when a new decision reverses or replaces a recorded one. Distinct from observation-level `superseded_at`.
>
> **Constraint that governs when this is worth doing:** relations connect *entities*, not observations. Most incidents/decisions currently live as observations on broad entities (`working-relationship`, `dustin`, a project entity), and you cannot edge an observation to an observation. So a causal edge is only expressible when both endpoints are their own entities. Practical rule: when an incident or decision is significant enough that you'd want to trace causality to/from it, record it as its **own entity** (e.g. `incident:opus-4.7-thrash`, `decision:sqlite-backend`) rather than only as an observation buried on a broad entity. Don't force it for trivia — apply where "why"-traceability has clear recall value. This is a modest entity-granularity shift, not a mandate to promote every incident.

**Why this is deferred, not applied now (rationale for the reviewer):**
1. It's *workspace* policy, decoupled from the server fold-in — different file, different owner, no reason to couple their timelines.
2. The entity-granularity implication (promoting significant incidents/decisions to their own entities so they can be edge endpoints) is a real behavioral change Dustin should opt into deliberately, not absorb as a side effect of a tooling change.
3. It composes best *after* `find_precedents` (§4) exists, so `PRECEDENT_FOR` edges have a retrieval path that actually uses them — applying the write-policy before the read-path exists would create edges nothing consumes.

**Receiving session: this subsection is informational only — do not implement it in server code.**

### 3.4 Tests
- Unit (Pool 1, no model): `create_relations` with each core type round-trips and is retrievable via `open_nodes`/`read_graph`; if (c) included, assert `caused_by` and `CAUSED_BY` collapse to one row under the UNIQUE constraint.
- Add a tiny test asserting `RELATION_TYPE_GUIDANCE` is present in the `create_relations` tool description (guards against the doc silently dropping).
- No model needed → these run in Pool 1 (`MEMORY_VECTOR_SEARCH=off`).

---

## §4 Enhancement 2 — `find_precedents` ranked retrieval

### 4.1 Design
A new **read-only** MCP tool returning observations **ranked by cosine similarity** to a query, reusing the *existing* vec-KNN path (the one already powering dedup) but ranking + returning instead of threshold-gating.

**Why it's needed:** `search_nodes` augments recall with vectors but **orders output by `updated_at DESC`** (recency), not similarity (`sqlite-store.ts:2414`; CLAUDE.md "Known Limitations"). Cosine *is* computed for dedup (`check_duplicates` >0.80, `add_observations` similarExisting >0.85) but never surfaced as ranked retrieval. So "find the most similar prior decision to this situation" is currently impossible. This tool fills exactly that gap and nothing more.

**Inputs** (zod, mirror `search_nodes`/`check_duplicates` styles):
```
query:         z.string().min(1).max(5000)        // the scenario/situation to find precedents for
projectId:     ProjectIdSchema                    // optional scope (reuse existing schema + normalizeProjectId)
memoryType:    z.string().min(1).max(50).optional()   // recommend 'decision' for precedent recall; omit = all types
limit:         z.number().int().min(1).max(50).optional().default(5)
minSimilarity: z.number().min(0).max(1).optional().default(0.25)  // floor; LOWER than dedup (0.8+) because
                                                                  // precedents are semantically RELATED, not duplicates
```

**Output** (return scores — that's the whole point):
```
{
  precedents: Array<{
    entityName: string,
    observationId: string,
    content: string,
    similarity: number,      // cosine, 0..1
    importance: number,
    memoryType: string | null,
    contextLayer: string,    // rendered — see §4.4 (null → "L2")
    createdAt: string
  }>,
  modelReady: boolean,           // embedding pipeline ready?
  vectorSearchEnabled: boolean   // vec table present (MEMORY_VECTOR_SEARCH !== 'off')?
}
```

**Degraded behavior (no throw):** if `MEMORY_VECTOR_SEARCH=off` (no vec table) or the model isn't ready or `embed()` returns null → return `{ precedents: [], modelReady, vectorSearchEnabled }`. The flags tell the caller why it's empty; the tool description should say "if `vectorSearchEnabled` is false, fall back to `search_nodes` for recency-recall." Do **not** silently fall back to LIKE search — that would return *recency*-ordered results mislabeled as *similarity* precedents (a silent-failure footgun).

**Reconciliation (if you're reworking `searchNodes` ranking):** if your in-flight work already adds similarity ranking to `search_nodes`, implement this as a **mode** of that (e.g., `searchNodes(..., { rank: 'similarity' })`) and make `find_precedents` a thin wrapper, OR drop the separate tool and expose a `rankBy` param. Do not ship two KNN code paths. As of the snapshot, no such rework exists, so the default plan is a standalone tool.

### 4.2 Store method — `findPrecedents` (reference implementation)
Mirror the dedup KNN at `sqlite-store.ts:3270-3284` (and `1575-1596`). Add to the store class:
```ts
// findPrecedents: similarity-RANKED retrieval of observations most semantically similar
// to `query`. Reuses the same sqlite-vec KNN path as dedup, but ranks by cosine and
// returns results instead of gating on a near-duplicate threshold.
//
// Returns [] (with flags) when vector search is unavailable rather than throwing —
// similarity ranking is impossible without the model, and a recency fallback would be
// a silent failure (results mislabeled as "precedents").
async findPrecedents(
  query: string,
  projectId: string | null,
  opts: { memoryType?: string; limit?: number; minSimilarity?: number } = {}
): Promise<{ precedents: PrecedentRow[]; modelReady: boolean; vectorSearchEnabled: boolean }> {
  const limit = opts.limit ?? 5;
  const minSimilarity = opts.minSimilarity ?? 0.25;
  const modelReady = this.embeddingPipeline.state.status === 'ready';
  const vectorSearchEnabled = this.vecTableExists;          // false when MEMORY_VECTOR_SEARCH=off (sqlite-store.ts:835)

  if (!vectorSearchEnabled || !modelReady) {
    return { precedents: [], modelReady, vectorSearchEnabled };
  }

  const embedding = await this.embeddingPipeline.embed(query);   // Float32Array | null (embedding.ts:100)
  if (!embedding) return { precedents: [], modelReady, vectorSearchEnabled };

  // Over-fetch: KNN ranks over ALL observations; we then filter by project/memoryType/active,
  // so fetch more candidates than `limit` to still have enough after filtering.
  // k MUST be a validated integer interpolated into the query (mirror the existing dedup
  // calls, which use a literal `k = 50` — sqlite-vec is version-pinned to that syntax here).
  const k = Math.min(Math.max(limit * 5, 50), 200);
  const knnRows = this.db.prepare(`
    SELECT v.observation_id, v.distance
    FROM vec_observations v
    WHERE v.embedding MATCH ? AND k = ${k}
  `).all(
    Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
  ) as { observation_id: string; distance: number }[];

  if (knnRows.length === 0) return { precedents: [], modelReady, vectorSearchEnabled };

  // L2 distance → cosine similarity for unit-normalized vectors (embeddings are L2-normalized,
  // embedding.ts:107-110). Same formula as the dedup paths.
  const simById = new Map<number, number>();
  for (const r of knnRows) {
    const sim = 1 - (r.distance * r.distance) / 2;
    simById.set(parseInt(r.observation_id, 10), sim);        // observation_id is TEXT in vec table
  }

  // Hydrate only ACTIVE observations on ACTIVE entities, applying project/memoryType filters.
  const ids = [...simById.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const filters: string[] = [];
  const params: unknown[] = [...ids];
  if (projectId) { filters.push('e.project = ?'); params.push(projectId); }
  if (opts.memoryType) { filters.push("o.memory_type = ?"); params.push(opts.memoryType); }
  const rows = this.db.prepare(`
    SELECT o.id, o.content, o.importance, o.memory_type, o.context_layer, o.created_at,
           e.name AS entity_name
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE o.id IN (${placeholders})
      AND o.superseded_at = '' AND o.tombstoned_at = ''
      AND e.superseded_at = '' AND e.tombstoned_at = ''
      ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
  `).all(...params) as Array<{
    id: number; content: string; importance: number; memory_type: string | null;
    context_layer: string | null; created_at: string; entity_name: string;
  }>;

  const precedents = rows
    .map(r => ({
      entityName: r.entity_name,
      observationId: String(r.id),
      content: r.content,
      similarity: simById.get(r.id) ?? 0,
      importance: r.importance,
      memoryType: r.memory_type,
      contextLayer: renderContextLayer(r.context_layer),   // §4.4 — null → "L2"
      createdAt: r.created_at,
    }))
    .filter(p => p.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return { precedents, modelReady, vectorSearchEnabled };
}
```
Notes:
- `this.vecTableExists` and `this.embeddingPipeline.state.status` are the exact gates the dedup paths use — re-verify the property names against live code (the inventory cites both as the active guards).
- The empty-string sentinel (`''` = active) for `superseded_at`/`tombstoned_at` matches this codebase's convention.
- If `delete_observations` soft-delete (uncommitted) changes how "active" is expressed, align this method's active-filter with whatever it standardizes on.

### 4.3 Tool registration (`index.ts`)
This server uses the high-level `McpServer.registerTool(name, {config}, handler)` API — **no ListTools/CallTool split**. One block, modeled on `check_duplicates` (`index.ts:752-789`, which already returns a `similarity` + `modelReady` shape):
```ts
server.registerTool(
  "find_precedents",
  {
    title: "Find Precedents",
    description:
      "Retrieve past observations RANKED by semantic similarity to `query` (cosine). " +
      "Use to find the most similar prior decisions/precedents to a current situation — " +
      "pass memoryType:'decision' for decision precedents. Unlike search_nodes (which returns " +
      "recency-ordered recall), this ranks by similarity and returns a score per result. " +
      "If vectorSearchEnabled is false, the model is unavailable — fall back to search_nodes.",
    inputSchema: {
      query: z.string().min(1).max(5000).describe("Situation/scenario text to find precedents for"),
      projectId: ProjectIdSchema,
      memoryType: z.string().min(1).max(50).optional()
        .describe("Optional filter; recommend 'decision' for precedent recall. Omit for all types."),
      limit: z.number().int().min(1).max(50).optional().default(5),
      minSimilarity: z.number().min(0).max(1).optional().default(0.25)
        .describe("Cosine floor; lower than dedup thresholds because precedents are related, not duplicates"),
    },
    outputSchema: {
      precedents: z.array(z.object({
        entityName: z.string(), observationId: z.string(), content: z.string(),
        similarity: z.number(), importance: z.number(),
        memoryType: z.string().nullable(), contextLayer: z.string(), createdAt: z.string(),
      })),
      modelReady: z.boolean(),
      vectorSearchEnabled: z.boolean(),
    },
  },
  async ({ query, projectId, memoryType, limit, minSimilarity }) => {
    const result = await store.findPrecedents(
      query, normalizeProjectId(projectId), { memoryType, limit, minSimilarity }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }
);
```

### 4.4 contextLayer rendering — coordinate with experiential-texture task 7.1
That in-flight task adds null→"L2" rendering of `context_layer` in tool outputs + a named `L2` constant (plan line ~50). **Use its helper/constant**, do not duplicate:
- If a shared `renderContextLayer(value)` (or an `L2` constant) already exists from 7.1, import and use it in `findPrecedents`.
- If 7.1 hasn't landed when you implement this, define `renderContextLayer = (v: string | null) => v ?? "L2"` locally and leave a `// TODO: dedupe with experiential-texture 7.1 L2 helper` note so it gets unified.
This is the single code-level overlap between this spec and the active plan — resolving it = one import.

### 4.5 Tests — MANDATORY model-load isolation
**This is the repo whose embedding-model load OOM-rebooted the machine across vitest forks.** Do not reintroduce it. Test isolation here is command-level (not in `vitest.config.ts`), per CLAUDE.md "Test pool discipline":

- **Pool 1 — logic tests, NO model** (`MEMORY_VECTOR_SEARCH=off`): assert the degraded path — `find_precedents` returns `{ precedents: [], vectorSearchEnabled: false, modelReady: <bool> }` and never throws. Assert input validation (limit/minSimilarity bounds), and that with vectors off it does **not** silently recency-fall-back. Put these in `__tests__/mcp-tools.test.ts`.
  Command: `MEMORY_VECTOR_SEARCH=off SKIP_VECTOR_INTEGRATION=1 npx vitest run --exclude '**/vector-integration.test.ts'`
- **Pool 2 — real-model ranking test, SINGLE FORK ONLY**: seed a few decision observations, call `find_precedents`, assert results are similarity-DESC ordered, scores in [0,1], `memoryType`/`projectId` filters honored, `minSimilarity` floor respected. Put in `__tests__/vector-integration.test.ts`.
  Command: `MEMORY_VECTOR_SEARCH=on npx vitest run __tests__/vector-integration.test.ts --pool=forks --poolOptions.forks.singleFork=true`
- **Never** let a real-model `find_precedents` assertion run in the multi-file/multi-fork Pool 1 sweep. `singleFork=true` + isolating to the one vector file is the exact mitigation.

---

## §5 Consolidated test commands
```
# Pool 1 — fast, no model, parallel-safe (everything except the vector integration file)
MEMORY_VECTOR_SEARCH=off SKIP_VECTOR_INTEGRATION=1 npx vitest run --exclude '**/vector-integration.test.ts'

# Pool 2 — real MiniLM model, SINGLE FORK (vector tests only)
MEMORY_VECTOR_SEARCH=on npx vitest run __tests__/vector-integration.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

---

## §6 Acceptance criteria
**Enhancement 1:**
- [x] `relation-types.ts` (repo root, not `src/`) exports `CORE_RELATION_TYPES` + `RELATION_TYPE_GUIDANCE` (+ `CoreRelationType` type). Unit-tested in `__tests__/relation-types.test.ts`.
- [x] `create_relations` tool description includes the vocabulary + directionality guidance (imported `RELATION_TYPE_GUIDANCE`, appended to the description).
- [ ] (Q1 decision — DEFERRED) `relation_type` trim+UPPER canonicalization at the insert was NOT added. Stayed pure-convention (a)+(b). Rationale: the smallest-sufficient choice — the guidance documents the casing, and canonicalizing existing data would be a retroactive change with no reported need. Tracked as DEF-CG-03.
- [x] Pool-1 tests pass; relation round-trips retrievable via `open_nodes`.

**Enhancement 2:**
- [x] `find_precedents` registered; returns similarity-DESC ranked observations with scores.
- [x] Degrades to `{ precedents: [], vectorSearchEnabled: false }` (no throw) when `MEMORY_VECTOR_SEARCH=off`; no silent recency fallback.
- [x] `projectId` + `memoryType` filters + `minSimilarity` floor honored (projectId scoping locked by a Pool-2 test; floor gates on RAW cosine, see `rankAndFloorPrecedents` + `__tests__/precedent-ranking.test.ts`).
- [~] `contextLayer` — `find_precedents` returns the **RAW** value (L0/L1/null), NOT L2-rendered. The §4.4 coordination with experiential-texture task 7.1 is DEFERRED because 7.1 (and its shared L2 helper) does not exist yet. Tracked as DEF-CG-02; reconcile when 7.1 lands.
- [x] Pool-1 degraded-path test + Pool-2 single-fork ranking test pass.
- [x] No schema/migration change; `schema_version` untouched (still v10).

**Both:**
- [x] Updated project `CLAUDE.md` tool count/list (17 → 19) and added `find_precedents` + `get_connected_context`.
- [x] Comments follow the workspace commenting rules (explain *what* and *why*; the consumer is also a human reading to learn).

---

## §7 Fold-in instructions (recommended order)
1. **Re-verify anchors** in Appendix A against live source (your tree may differ). Re-locate by symbol, not line.
2. Do **Enhancement 1** first — it's isolated from your active work (no relations/search overlap) and lowest-risk. Files: new `src/relation-types.ts`; `index.ts` (create_relations description); optionally `sqlite-store.ts:~1430`.
3. Do **Enhancement 2** second. Files: `sqlite-store.ts` (new `findPrecedents` method — keep it clear of the dirty `delete_observations` region ~1707); `index.ts` (new `registerTool` block). Resolve the §4.4 `contextLayer` rendering against your 7.1 work.
4. Run **both** test pools (§5). Confirm Pool 2 is single-fork.
5. Update `CLAUDE.md` counts.
6. Commit **only when Dustin asks** (this project's commit-only-when-asked rule). Expect `sqlite-store.ts` to already be dirty from `delete_observations`; stage your hunks deliberately.

## §8 Open decisions for the receiving session
- **Q1 — relation_type normalization (§3.2c):** include the trim+UPPER canonicalization, or stay pure-convention (a)+(b) only? Spec recommends including it (one line); your call given the retroactive-inconsistency note.
- **Q2 — separate tool vs. ranking mode (§4.1):** if you have search-ranking rework in flight, fold `find_precedents` in as a mode rather than a parallel path. As of snapshot, standalone tool is correct.
- **Q3 — `minSimilarity` default (0.25):** tune if your corpus's cosine distribution suggests a different floor. The dedup paths use 0.80/0.85 (near-duplicate); precedent floor should be much lower.

---

## Appendix A — Verified anchors (snapshot 2026-06-02 ~14:40 PDT; re-verify by symbol)
| What | Symbol | Anchor |
|---|---|---|
| Tool API | `McpServer.registerTool(name,{config},handler)` (no ListTools/CallTool split) | `index.ts:211-214` (v1.1.1) |
| Template tool (recall) | `search_nodes` registration+handler | `index.ts:422-453` |
| Template tool (scored) | `check_duplicates` registration+handler | `index.ts:752-789` |
| Relation input schema | `RelationInputSchema` (`relationType` free-form, no enum) | `index.ts:151-155` |
| Relation insert chokepoint | `createRelations`, raw `relationType` insert | `sqlite-store.ts:1393,1411-1430` |
| Embedding | `EmbeddingPipeline.embed(text)→Float32Array\|null`; `EMBEDDING_DIM=384`; model `Xenova/all-MiniLM-L6-v2` | `embedding.ts:14,17,41,100` |
| Vector gate | `MEMORY_VECTOR_SEARCH==='off'` skips vec table | `sqlite-store.ts:835` |
| Dedup KNN to mirror | `vec_observations … MATCH ? AND k=50`; `sim = 1-(dist²)/2` | `sqlite-store.ts:3270-3284` (also `1575-1596`) |
| Search return shape | `PaginatedKnowledgeGraph {entities,relations,nextCursor,totalCount}` (no score field) | `index.ts:204-209` |
| vec table (idempotent, not version-gated) | `vec_observations(embedding float[384], +observation_id TEXT)` | `sqlite-store.ts:850` |
| Schema version | single-row `schema_version` CHECK(id=1); live = **v10** | `sqlite-store.ts:226-230` |
| Test config | Vitest, minimal `vitest.config.ts`; isolation is command-level | `vitest.config.ts`, `package.json` |

## Appendix B — Directionality quick reference (memorize this, the server won't enforce it)
```
<from> —CAUSED_BY→    <to>     # effect → cause      ("X exists because of Y")
<from> —PRECEDENT_FOR→ <to>    # earlier → later     ("X is a precedent for Y")
<from> —SUPERSEDES→   <to>     # newer → older       ("X replaces Y")
```

---

## §9 Implementation status & deviations (added 2026-06-03 by the receiving session)

Implemented in the 2026-06-03 causal-graph build (branch `fix/delete-observations-soft-delete`). The work matched §3/§4 with three intentional deviations, plus one **scope expansion** Dustin directed.

**Scope expansion — `get_connected_context` + directed-cycle detection ("D4").** §2 marks "a multi-hop / recursive traversal tool" explicitly out of scope. It was nonetheless built because Dustin directed it directly in-session (the "Joanna → sanctioned company → bank loan" multi-hop example, and his question about a realistic `maxHops` depth for this hardware). Per the workspace resolution hierarchy, direct user direction is dispositive over a spec's scope marking. The tool is a bounded `WITH RECURSIVE` walk (the spec's own "possible if ever needed" note), structure-only (no observation content), capped by `maxHops` (≤6) and `maxNodes`, with mechanical directed-cycle reporting so circular logic is flagged rather than left for the caller. It is **non-schema-changing** (it only adds an index, `idx_relations_from_entity_active`, to make the out-arm hop seekable). Classified: **scope-change**, user-directed.

**Deviation 1 — Q1 relation_type canonicalization NOT added** (deferment / smallest-sufficient). See §6 / DEF-CG-03.

**Deviation 2 — `contextLayer` returned RAW, not L2-rendered** (deferment). The §4.4 coordination target (experiential-texture task 7.1's null→"L2" rendering + shared helper) does not exist yet, so `find_precedents` returns the raw `contextLayer` and the type comment explicitly disclaims L2-render coupling. See DEF-CG-02. Classified: **deferment**.

**Review hardening.** Two adversarial review rounds ran before commit. Round 1 (10 confirmed findings) drove the projectId scoping implementation, the C0-control-char strip in the normalizer (so `char(31)` — the traversal path delimiter — can never enter a normalized name), the raw-cosine floor fix in `find_precedents`, and several comment corrections. Round 2 (5 confirmed) found one real bug — an out-of-project **seed** addressed by a surface variant silently dropped its edges — fixed by resolving the seed's display name project-independently (the seed is the anchor, not a scoped neighbor); the other four were regression-test gaps, now locked. Eight further concerns were adversarially **refuted** (notably: the cycle-dedup key cannot collapse two distinct same-node-set cycles, because back-edge DFS structurally cannot produce them). One recurring trap is worth recording: an invisible `\x01` control byte in source reads as `.join('')` in every textual view (review output, summaries, the model's own context), so a delimiter that *was* present looked absent — fixed by switching the cycle-dedup key to `JSON.stringify(sorted-set)` (collision-proof AND legible) and adding a byte-level control-char scan to the verification loop.

---

## Appendix C — Deferment register (originated in this build)

| ID | Severity | Title | Defer target | Fix direction |
|---|---|---|---|---|
| DEF-CG-01 | MEDIUM | `get_connected_context` deep-walk materializes every simple path before the `GROUP BY` collapse; `maxNodes` caps returned rows, not CTE work. From a high-degree hub at large `maxHops` with `direction:'both'`, intermediate path count grows ~d·(d-1)^(h-1) and the synchronous `.all()` can block the server. | indefinite (profile-before-fix) | If a hubby corpus makes it hot, switch to a global visited-set / closure-table walk. Decide with `EXPLAIN QUERY PLAN` + a synthetic degree-30 fixture, NOT a reflexive rewrite. Bounded today by `maxHops≤6` + low avg degree. Documented in the `getConnectedContext` JSDoc. |
| DEF-CG-02 | LOW | `find_precedents` returns RAW `contextLayer`; the §4.4 null→"L2" rendering coordination with experiential-texture task 7.1 is unmet because 7.1 doesn't exist yet. | experiential-texture Phase 7 (task 7.1) | When 7.1 lands its shared L2-rendering helper/constant, route `PrecedentMatch.contextLayer` through it instead of returning raw. Until then raw is correct (no second rendering to drift from). |
| DEF-CG-03 | LOW | `relation_type` is stored as-supplied (pure convention); `caused_by` and `CAUSED_BY` do not collapse under the UNIQUE constraint. | indefinite | If casing inconsistency ever shows up in real data, add a trim+UPPER canonicalization at the `createRelations` insert chokepoint. No reported need today; the vocab guidance documents the canonical casing. |

**Obsolescence conditions:** DEF-CG-01 → irrelevant if traversal is ever replaced by a closure-table design. DEF-CG-02 → resolved when task 7.1 ships (move its register row to a Resolved subsection then). DEF-CG-03 → irrelevant if a future migration normalizes `relation_type` corpus-wide.
