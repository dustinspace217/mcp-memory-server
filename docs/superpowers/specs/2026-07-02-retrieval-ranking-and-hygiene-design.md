# Design Spec — Retrieval Ranking & Hygiene Enhancements (v1.3.0)

> Origin: the 2026-07-02 full audit session (Fable). Dustin approved every audit recommendation
> verbatim ("I like every one you made") and commissioned this spec + plan pairing explicitly so
> **Opus can execute at the same quality**. This spec is the design anchor: every decision here is
> DECIDED — do not re-litigate during the build. If the code contradicts a "verified fact" below,
> the code wins and the discrepancy gets recorded in the plan doc's deviation log.
>
> Companion plan (task-level): `docs/superpowers/plans/2026-07-02-retrieval-ranking-and-hygiene.md`
> Audit evidence: conversation of 2026-07-02 ~01:49-02:30 PDT; external research reports summarized
> in §2; live-DB audit numbers in §3.

---

## 1. Goals and non-goals

Everything here traces to the project's three durable goals (project CLAUDE.md):

- **A (drift/hallucination):** valid-time fields (§8), relation-vocabulary hygiene (§6).
- **B (faithful recall):** FTS5+RRF relevance ranking (§4) — the headline; fixes "recent-but-
  tangential beats exactly-right-from-March". PPR graph-aware rerank (§9).
- **C (conversations & code quality):** retrieval strengthening (§5), memoryType-at-capture (§7),
  embedding eval (§10).

**Non-goals (explicitly rejected at audit; do NOT add):** LLM-in-the-server write adjudication
(mem0-style — the calling Claude session is the LLM); continuous background memory rewriting
(Letta sleep-time — weekly consolidation covers it; higher frequency mainly buys narrative-
laundering risk); reconsolidation / retrieval-triggered rewriting of old observations (A-MEM
"memory evolution" — this is the mechanism by which human memory becomes confidently FALSE;
our append+supersede audit trail is deliberately better than biology here); ontologies; Ebbinghaus
deletion (decay-gradient compression is safer); any new MCP tool (all changes ride existing tools).

## 2. Research inputs (for context, not re-verification)

- **Memory-systems survey (2026-07-02):** FTS5+BM25+RRF fusion ranked #1 adoptable idea;
  ACT-R base-level activation #2; write-time reconciliation advisory #3; valid-time bi-temporal-lite
  #4 (from Zep/Graphiti); PPR-lite rerank #5 (from HippoRAG 2, arXiv:2502.14802). mem0's 2026
  retreat to add-only extraction independently validates our supersede lifecycle.
- **Embedding survey (2026-07-02):** MiniLM-L6-v2 (2021) is behind the small-model frontier.
  Shortlist: `onnx-community/granite-embedding-small-english-r2-ONNX` (47M, **384-dim**,
  ModernBERT, technical-text focus), `Snowflake/snowflake-arctic-embed-s` (33M, **384-dim**, CLS
  pooling, query prefix "Represent this sentence for searching relevant passages: "),
  `onnx-community/embeddinggemma-300m-ONNX` (308M, 768-dim MRL, strict prompt prefixes, fp16
  forbidden, CPU-latency risk). MTEB is contaminated (its co-creator's public assessment) —
  **the only decision-grade evidence is our own in-domain blind panel** (§10).
- **Precedent inside this repo:** the 2026-06-19/20 server-adoption NO-GO
  (`docs/superpowers/plans/2026-06-19-embeddings-server-adoption.md`) — reuse its discipline:
  offline gate before any live retrieval-behavior change; measure at the deployment granularity.

## 3. Verified facts (checked against source 2026-07-02 — re-verify line numbers before editing)

All file references are in the repo root. Line numbers WILL drift as phases land — Opus MUST
re-locate each anchor with Grep before editing (Verify Over Recall; do not trust these numbers
after any phase has merged).

| Fact | Where verified |
|---|---|
| Schema version is **10**; migrations run sequentially in `init()`, each sets `UPDATE schema_version SET version = N` | `sqlite-store.ts:257-769` |
| `observations` PK is `id INTEGER PRIMARY KEY AUTOINCREMENT` (rowid alias → external-content FTS5 works) | `sqlite-store.ts:222-229` |
| `searchNodes(query, projectId?, pagination?, asOf?, memoryType?)` at `sqlite-store.ts:2349`; materialized CTE `matched_ids` (4 LIKE conditions: name, normalized_name, entity_type, obs content); outer query `ORDER BY updated_at DESC, id DESC`; keyset cursor `(u,i)`; `total_count` scalar subquery | `sqlite-store.ts:2349-2478` |
| `createRelations` at `sqlite-store.ts:1436` | grep |
| `findPrecedents` at `sqlite-store.ts:2984`; floor default 0.25 (raw cosine); ranking via pure helper `rankAndFloorPrecedents` (`sqlite-store.ts:125`) | grep |
| Dedup threshold **0.85** (`addObservations`, `sqlite-store.ts:1639`); advisory **0.80** (`checkDuplicates`, `sqlite-store.ts:3662`) | grep |
| `touchEntities(entityIds)` at `sqlite-store.ts:1012`; `touchEntitiesByName` at `:1032`; callers: searchNodes, openNodes, entityTimeline, all writes; NOT readGraph; eviction uses raw SQL and must never touch | `sqlite-store.ts` + CLAUDE.md access-discipline section |
| `vec_observations` vec0 virtual table created at `sqlite-store.ts:893` | grep |
| Embedding: `embedding.ts:14` `MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'` (hardcoded), `pooling:'mean'` at `:108`, via `@huggingface/transformers` ^4.0.1 | `embedding.ts`, `package.json` |
| Deps: better-sqlite3 ^12.8.0, sqlite-vec ^0.1.9 | `package.json` |
| Live graph (2026-07-02): 403 active entities, 3,125 active obs (2,106 superseded), 501 active relations across **128 distinct relation_type spellings**, 798 null-`memory_type` obs, 14 orphan entities | sqlite-ro queries this session |
| Phase D targets exist: `~/.claude/hooks/sessionend-prompt.md`, `~/.claude/hooks/precompact-prompt.md`, `~/.claude/hooks/periodic-memory-check.sh`; repo mirror `harness/prompts/` holds only `memory-consolidation.md` | ls this session |
| bge/ONNX precedent: CLS-vs-mean pooling is a silent ~4% drift; fidelity gates at cosine 1.0 are achievable in both onnxruntime and transformers.js | 2026-06-19 plan doc, Phase 1 RESULTS |

**Unverified assumption (probe in Phase A Task A1, first thing):** better-sqlite3's bundled SQLite
is compiled with FTS5. Expected true (it is the default build config), but the first test asserts it
empirically — if it fails, STOP Phase A and surface to Dustin (fallback would be a contentless
manual index, a different design).

## 4. Phase A — FTS5 + RRF relevance ranking for `search_nodes`

**Problem.** `search_nodes` orders by `updated_at DESC` — pure recency. Vector search improves
*recall* (candidates LIKE misses) but nothing ranks by *relevance*. At 3,125 observations the
practical symptom is recent-but-tangential results outranking the exactly-right older memory.

**Design decisions (DECIDED):**

1. **FTS5 external-content table over `observations.content`**, `content_rowid='id'`,
   tokenizer `unicode61 remove_diacritics 2`. Kept in sync by **SQL triggers** (INSERT / DELETE /
   UPDATE OF content), NOT code-level sync — triggers also cover the eviction sweep's raw-SQL
   writes (`evict.ts` bypasses GraphStore by design) and any future migration. Index contains ALL
   observations (supersede is an UPDATE of `superseded_at` only — no content trigger fires);
   **active-only filtering happens at query time** via `JOIN observations o ON o.id = obs_fts.rowid
   AND o.superseded_at = ''`. This keeps triggers trivial and makes correctness live in one place.
2. **Migration v11** creates table + triggers, then `INSERT INTO obs_fts(obs_fts) VALUES('rebuild')`
   to index existing rows. Single transaction, idempotent (`IF NOT EXISTS` everywhere).
3. **Query sanitization:** user input is NEVER passed raw to MATCH. `toFtsQuery()` wraps each
   whitespace-token in double quotes (embedded `"` doubled) — FTS5 operators (AND/OR/NOT/NEAR/
   `*`/`^`/`-`) become literals. Multiple quoted tokens = implicit AND (precision); the existing
   LIKE list provides substring recall, so AND is safe.
4. **Ranking = weighted Reciprocal Rank Fusion** in a new pure module `rank-fusion.ts`:
   `score(id) = Σ_lists weight_list / (60 + rank)`. Rank-based fusion deliberately sidesteps
   score-normalization across BM25/cosine/activation. k=60 is the literature default — hardcode it.
5. **Candidate lists (entity-level), Phase A:**
   - LIKE matches (the existing `matched_ids` CTE, unchanged) — weight **1.0**, ranked by
     `updated_at DESC` (its current implicit order);
   - FTS/BM25: `SELECT o.entity_id, MIN(bm25(obs_fts)) AS best FROM obs_fts JOIN observations o
     ON o.id = obs_fts.rowid AND o.superseded_at = '' WHERE obs_fts MATCH ? GROUP BY o.entity_id
     ORDER BY best LIMIT 200` (bm25() is lower-is-better) — weight **1.0**;
   - Vector KNN (existing hybrid path's entity set, ranked by best obs cosine) — weight **1.0**,
     present only when the model is ready (graceful degradation unchanged).
   Project scoping and memoryType filters apply to the FUSED result the same way they apply today
   (candidates outside scope are dropped before fusion via the same WHERE clauses).
6. **API surface:** `search_nodes` gains optional `orderBy: 'recency' | 'relevance'`
   (**default `'recency'`** — zero behavior change for existing callers, including the SessionStart
   hooks). Relevance mode returns the top-`limit` (clamped, max 100) fused results with
   `totalCount`, and **`nextCursor: null` always** — no cursor pagination for ranked results.
   Passing `cursor` together with `orderBy:'relevance'`, or `asOf` with `orderBy:'relevance'`,
   is a Zod-level validation error with a message naming the incompatibility. Rationale: keyset
   pagination needs a stable stored sort key; rank is query-relative and mutation-unstable. Top-k
   is what ranked search is for. (JSONL backend: `orderBy:'relevance'` falls back to recency order
   with a `rankingUnavailable: true` flag — same graceful-degradation pattern as vector search.)
7. **Tool description** must be updated to say relevance mode exists and when to use it — the tool
   description IS the UX for future Claude sessions (goal C).

## 5. Phase B — Retrieval strengthening (ACT-R-lite activation)

**Problem.** Human memory strengthens with retrieval (the testing effect); ours records
`last_accessed_at` but uses it only as an eviction shield. Frequently-useful memories should
surface more easily.

**Design decisions (DECIDED):**

1. **Migration v12:** `ALTER TABLE entities ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`.
2. `touchEntities` / `touchEntitiesByName` additionally do `access_count = access_count + 1`.
   The access-discipline boundary is UNCHANGED: readGraph doesn't touch; eviction's raw SQL never
   touches (the observer-effect rule in `evict.ts` header comments still holds verbatim).
3. **Activation formula** (pure function in `rank-fusion.ts`):
   `activation = ln(1 + access_count) − 0.5 · ln(1 + hours_since_last_access)`; entities with
   `access_count = 0` or sentinel `last_accessed_at` rank last. This is the standard two-parameter
   approximation of ACT-R base-level activation (we don't store per-access timestamps — YAGNI).
   Decay d = 0.5 is ACT-R's canonical default — hardcode, don't make it configurable.
4. **Activation NEVER nominates candidates — it only reranks them.** It joins RRF as a fourth list
   (weight **0.5**, half the relevance lists) computed over the union of candidates from §4.5.
   This is load-bearing: global activation ranking would let frequently-accessed-but-irrelevant
   entities flood every query.
5. Deliberately NOT done: per-access timestamp log (table growth for marginal fidelity), activation
   in `find_precedents` (obs-level; entity activation is the wrong granularity there), feeding
   `access_count` into eviction tiers (note as future option in code comment only).

## 6. Phase C — Relation-vocabulary hygiene

**Problem (measured).** 128 distinct `relation_type` spellings across 501 active edges. Mechanical
drift: `belongs_to`/`belongs to`/`belongs-to`; `contains_file`/`contains-file`; `part_of`/`PART_OF`/
`is part of`; one mangled causal edge `"PRECEDENT_FOR robust-build procedure on"`. A `relationTypes`
filter on `get_connected_context` silently misses same-verb-different-spelling edges.

**Design decisions (DECIDED):**

1. **Migration v13 — explicit reviewed map, not an algorithm.** Exact map (from the live audit;
   Dustin-approved via the audit sign-off):
   `belongs to`→`belongs_to`, `belongs-to`→`belongs_to`, `contains-file`→`contains_file`,
   `has_file`→`contains_file` (semantic merge, approved), `PART_OF`→`part_of`,
   `is part of`→`part_of`, `occurred in`→`occurred_in`, `occurred during`→`OCCURRED_DURING`,
   `PRECEDENT_FOR robust-build procedure on`→`PRECEDENT_FOR`.
   Do NOT merge anything else (e.g. `is tested by` vs `tests` differ in DIRECTION; `imports` vs
   `imports_from` is judgment — leave both). Only ACTIVE rows (`superseded_at = ''`) are rewritten.
2. **Collision handling:** if rewriting would violate `UNIQUE(from_entity, to_entity,
   relation_type, superseded_at)` (an active row with the target spelling already exists), the
   drifted duplicate is **soft-retired** (stamp `superseded_at`) instead of rewritten — never
   hard-deleted, never a constraint crash. Retire-then-rewrite order inside one transaction.
3. **Write-time canonicalization advisory in `createRelations`:** normalize the incoming type with
   `key = type.toLowerCase().replace(/[\s\-]+/g, '_')`; if the key matches a `CORE_RELATION_TYPES`
   member, use the core spelling; else if it matches exactly one existing DISTINCT active type's
   key, reuse that existing spelling; else store as given. Open vocabulary is PRESERVED (DEF-CG-03's
   decision stands) — this stops the same verb fragmenting, nothing more. The distinct-types lookup
   is one query per `createRelations` call (~128 rows — trivial).

## 7. Phase D — memoryType at capture (harness-side, no server code)

**Problem (measured).** 798 null-typed observations, up from ~423 in the June backlog — capture
paths write untyped faster than consolidation classifies. Untyped obs are invisible to every
`memoryType`-filtered query.

**Design decisions (DECIDED):** add an explicit classification directive to the three capture
prompts (`~/.claude/hooks/sessionend-prompt.md`, `~/.claude/hooks/precompact-prompt.md`, and the
checkpoint instruction text in `~/.claude/hooks/periodic-memory-check.sh`): every `add_observations`
call MUST set `memoryType` from the known list (decision, procedure, fact, status, preference,
problem, architecture, milestone, win, introspective, emotional, narrative, relational, feedback);
fallback `fact` when nothing fits. Also add one line to
`harness/prompts/memory-consolidation.md` (and its live copy) directing the weekly agent to
classify a batch (≤50/run) of the existing null-typed backlog, oldest first. These are prompt
edits — re-read each complete file after editing (Prompt & Config Editing rule); no server code,
no tests, but the plan's verification step greps the edited files for the directive text.

## 8. Phase F — Valid-time fields (bi-temporal-lite, from Graphiti)

**Problem.** The schema knows when the DATABASE learned/retired a fact (`created_at`/
`superseded_at` = transaction time) but not when the fact was true IN THE WORLD (valid time).
Goal A literally asks for "currently true vs was true at time T".

**Design decisions (DECIDED — smallest coherent version):**

1. **Migration v14:** `valid_from TEXT NOT NULL DEFAULT ''` + `valid_until TEXT NOT NULL DEFAULT ''`
   on BOTH `observations` and `relations`. Empty-string sentinel = unspecified (same convention as
   `superseded_at`).
2. **Write surface — NO shape break to `add_observations`** (its `contents` is a string array;
   changing it to objects breaks every caller). Instead: (a) `set_observation_metadata` gains
   optional `validFrom` / `validUntil` fields (it already updates metadata in place — perfect fit);
   (b) `RelationInput` gains optional `validFrom` / `validUntil` (already objects — clean).
   Zod validation mirrors the existing `asOf` ISO-8601-Z validation exactly.
3. **Read surface:** returned on relations and in `entity_timeline` / `open_nodes` observation
   output whenever non-empty. NO valid-time query filtering in v1 (`as_of_valid` param is
   explicitly DEFERRED — record as a deferment, target "when a real query need appears").
4. Caller supplies dates (no LLM date extraction — that's Graphiti's complexity, rejected).

## 9. Phase E — PPR-lite graph-aware rerank for `find_precedents`

**Problem.** `find_precedents` knows meaning (cosine), `get_connected_context` knows structure;
nothing combines them. HippoRAG 2's result: personalized-PageRank diffusion from semantic seeds
materially improves multi-hop retrieval.

**Design decisions (DECIDED):**

1. New pure module `pagerank.ts`: `personalizedPageRank(edges, seeds, {alpha: 0.5, iterations: 3})`
   over the ACTIVE relations (~501 edges — milliseconds). Edges treated as **undirected** for
   diffusion (relatedness, not direction), degree-normalized, seeds = parent entities of the vector
   top-k weighted by cosine.
2. `findPrecedents` gains `rerank?: boolean`, **default `false`**. When true: fetch 3× the usual
   KNN candidates, fuse (weighted RRF, `rank-fusion.ts`): vector rank weight **1.0**, parent-entity
   PPR rank weight **0.5**, obs-level BM25 rank (reuse Phase A's FTS, `MATCH` the query) weight
   **0.75**. Floor/limit/rounding still applied by `rankAndFloorPrecedents` semantics (floor gates
   on raw cosine BEFORE fusion — a fused score must never resurrect a below-floor match).
3. **Default stays `false` until an offline blind gate passes** — same discipline as the 2026-06-20
   NO-GO: ≥18 realistic queries, blind judged, flip default only on a clear win (≥12/18). The gate
   needs judge agents (usage-dependent); shipping the param without flipping the default is a
   complete, safe deliverable. Record the unflipped default as a deferment if the gate can't run.

## 10. Phase G — Embedding eval + CONDITIONAL migration

**Decision rule (DECIDED):** the server stays on MiniLM unless a candidate wins the in-domain blind
panel outright. From the 2026-06-20 precedent: tie → stay (no free win, no migration risk).

1. **Eval (unconditional):** adapt `memory-graph-viz/concept_embeddings/phase2_base.py` (its venv,
   NOT the server runtime) to run **granite-embedding-small-english-r2** and
   **snowflake-arctic-embed-s** vs MiniLM on the same obs-level blind-judge harness, n≥18 real
   queries, correct per-model query prefixes (arctic REQUIRES "Represent this sentence for
   searching relevant passages: " on queries only; granite per its model card — VERIFY on the card
   at build time). Judge panel needs agents — run when usage allows. Win threshold: ≥12/18.
2. **Prep (unconditional, safe, ships regardless):**
   - `embedding.ts`: `MODEL_NAME` → env `MEMORY_EMBED_MODEL` (default unchanged
     `Xenova/all-MiniLM-L6-v2`); pooling → env `MEMORY_EMBED_POOLING` (`'mean'` default, `'cls'`
     accepted); new env `MEMORY_EMBED_QUERY_PREFIX` (default '') prepended ONLY to query-side
     embeds. `embed(text)` → `embed(text, kind: 'query' | 'passage' = 'passage')`; call sites:
     findPrecedents + checkDuplicates + the addObservations dedup check embed QUERIES against
     stored passages — findPrecedents' query is `'query'`; stored-obs embedding is `'passage'`;
     checkDuplicates/dedup candidates compare passage-to-passage → `'passage'`.
   - **Migration v15:** ordinary table `vec_config (id INTEGER PRIMARY KEY CHECK (id = 1),
     model_name TEXT NOT NULL)` seeded with the current model. On startup, if configured model ≠
     stored `model_name`: log loudly, `DELETE FROM vec_observations`, update `vec_config`, let the
     existing background sweep re-embed everything. This makes a model switch a config flip with a
     self-healing index — and makes a mismatched index IMPOSSIBLE, which is the real risk today.
3. **Cutover (CONDITIONAL on a panel win + Dustin's explicit go):** flip the env vars, restart,
   verify the sweep completes, then **recalibrate the three thresholds empirically** (0.85 dedup /
   0.80 check_duplicates / 0.25 precedent floor): script embeds ~30 known-duplicate pairs and ~30
   known-distinct pairs from the live corpus under the new model, prints both cosine distributions,
   pick thresholds preserving the current separation percentiles. Cosine distributions are
   model-specific — skipping this silently breaks dedup.

## 11. Cross-cutting constraints (bind every phase)

- **Schema-bearing phases MUST land in order** A(v11) → B(v12) → C(v13) → F(v14) → G(v15) —
  migrations are sequential integers. D and E carry no schema change and can land any time after
  their dependencies (E needs A's FTS + rank-fusion module).
- **Every migration:** idempotent, wrapped in a transaction, tested in
  `__tests__/migration-validation.test.ts` (forward-migration test per version, pattern already
  in that file).
- **JSONL backend:** new query features degrade gracefully (`orderBy:'relevance'` → recency +
  flag; `rerank` → ignored + flag); valid-time fields serialize like other optional fields;
  vocabulary canonicalization applies (it's store-level logic — implement in both, or document
  JSONL divergence in CLAUDE.md Known Limitations). JSONL is deprecated — divergence + documentation
  is acceptable where implementation cost is real; say so explicitly in the Known Limitations list.
- **Test pools (hard rule, OOM history):** Pool 1
  `~/.local/bin/bounded-run env MEMORY_VECTOR_SEARCH=off SKIP_VECTOR_INTEGRATION=1 npx vitest run --exclude '**/vector-integration.test.ts'`;
  Pool 2 `~/.local/bin/bounded-run env MEMORY_VECTOR_SEARCH=on npx vitest run __tests__/vector-integration.test.ts --pool=forks --poolOptions.forks.singleFork=true`.
  New tests default to Pool 1 (mock/off); only true embedding-behavior tests go to Pool 2.
- **Docs:** every phase updates the project `CLAUDE.md` (architecture bullets + Known Limitations +
  test counts) and the plan doc's Status block in the SAME commit as the code.
- **Version:** bump package.json to **1.3.0** in the final phase's close-out, with a Version
  History entry in CLAUDE.md.

## 12. Execution playbook for Opus (quality contract — READ FIRST, apply to every task)

1. **Verify before citing.** Every `file:line` in this spec was correct on 2026-07-02 and WILL
   drift. Grep for the anchor text before every edit. If reality contradicts the spec's facts,
   reality wins — record the delta in the plan's deviation log.
2. **TDD, strictly.** Failing test → run to see the failure → minimal implementation → green →
   commit. The plan's tasks are structured this way; don't batch commits across tasks.
3. **Minimal diff.** Do not reformat, rename, or "improve" adjacent working code. `searchNodes`
   recency mode must be byte-for-byte behavior-identical after Phase A (the existing 412-test
   suite is the referee).
4. **Comments carry the why.** Dustin learns by reading code; comment density and teaching style
   must match the file you're in (this codebase is heavily commented — match it). Every new
   function gets a header comment: what/receives/returns + WHY this approach (e.g. why triggers
   over code-sync, why rank fusion over score fusion, why activation never nominates).
5. **No test that can't fail.** Do not test a helper against its own formula (documented past
   failure: circular centroid test). Ranking tests assert ORDER for hand-constructed inputs whose
   correct order is derived in the test comment, not by calling the function.
6. **Retrieval-behavior changes ship dark.** Defaults preserve current behavior (`orderBy` defaults
   recency, `rerank` defaults false); flipping a default requires the specified offline gate.
7. **Run the real artifact.** After each phase: `npm run build`, then exercise the changed tool
   against a THROWAWAY copy of the live DB (`cp` the db + `MEMORY_FILE_PATH` override) — never the
   live `memory.db`. The SessionStart backup exists, but don't lean on it.
8. **QA review per phase.** After each phase's code lands: three-phase review (Phase A/B/C process
   in workspace CLAUDE.md) with code-reviewer + test-analyzer minimum; add performance-analyst for
   Phases A/B/E (query-path changes). On low usage: code-reviewer + test-analyzer only, and say so
   in the plan's deviation log.
9. **Stop conditions.** FTS5 probe fails → stop Phase A, surface. Any migration test red → stop,
   never ship a half-migration. Blind-gate can't run (usage) → ship dark, record deferment, move on.
   Genuine spec/reality contradiction that changes a DESIGN decision (not a line number) → stop and
   surface to Dustin; do not silently redesign.
