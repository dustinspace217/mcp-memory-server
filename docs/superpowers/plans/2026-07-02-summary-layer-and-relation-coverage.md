# Summary Layer + Relation Coverage (v1.4.0) — Implementation Plan

> Dustin's directive (2026-07-02 ~23:16): "Let's do the top two items that have a real
> effect. Summary layer and one other." Item 2 chosen per the roadmap sweep: the
> read_graph/search_nodes relation AND-filter — the standing open decision from the
> 2026-06-23 verification session (474 true relations, read_graph returns 156), resolved
> here as FIX (goal B: the canonical record should be readable in full; the directive's
> "real effect" criterion rules out keeping the warning-only mitigation).

## Status (updated 2026-07-04, ~01:50 PDT)
Phase: COMPLETE — both features built + two QA rounds applied; merged/pushed on main
  (d6c8f48 → a1b5533). QA was interrupted mid-flight by the 2026-07-03 usage outage
  (12/13 workflow verifiers + the contract finder + the Phase B cross-exam all died);
  the completed finders' findings were recovered from the workflow journal and fully
  dispositioned, and the lost lenses (contract dimension, cross-exam) were re-run
  fresh on 2026-07-04. Synthesis on Discussion #89.
Done: v16 summary column + two-tier get_context_layers (featured 12k + index 4k,
  shared context-layers.ts); either-endpoint relation coverage (496/496 union on a
  live-DB copy); JSONL parity (self-caught divergence); QA rounds: schema-contract
  rewrite, recency-search pin, JSONL summary round-trip, tokenEstimate exactness,
  migrateFromJsonl summary carry, context-layers unit tests, ranked-scoped pin.
  716 tests (701 + 15) across 15 files.
Next: nothing — deploys with the granite cutover on the next MCP restart.
Blocked: nothing.

## Task 1 — Summary layer (spec: docs/superpowers/specs/2026-04-16-summary-layer-design.md)

The spec is DECIDED and complete; only re-target from its "v10" (April) to **v16** (now).
Adaptations to current reality, verified 2026-07-02:
- Migration v16 follows the house pattern (race-tolerant ALTER, IMMEDIATE txn,
  in-transaction version re-check — Issue #78 lineage), not the spec's bare try/catch.
- `summary TEXT DEFAULT NULL` — the ONE nullable-sentinel column (spec-explicit: NULL =
  no explicit summary → auto-fallback to first 100 chars). Deliberate exception to the
  '' sentinel convention; documented at the migration.
- Budget split: L1_FEATURED_CHAR_BUDGET = 12000, L1_INDEX_CHAR_BUDGET = 4000 (replaces
  the single 16000). Featured behavior identical to today at the reduced budget.
- `getContextLayers` SELECT gains `o.summary` + `e.entity_type` (for index entries).
- Honest-effect note (flagged in the delivery report): the SessionStart hook reads the
  DB directly and already surfaces its own overflow loudly, so this feature's daily
  effect lands on MID-SESSION `get_context_layers` calls, lifecycle agents, and
  external adopters — not the session-start path.

- [ ] Failing tests first (both backends): index appears on overflow / absent when all
  fit / entity grouping + counts / summary override vs 100-char fallback / index budget
  drops lowest-importance entities / set+clear summary via set_observation_metadata.
- [ ] v16 migration + forward test; exact-version pin bump (knowledge-graph.test.ts).
- [ ] Implement store methods (sqlite + jsonl), types, Zod (summary .max(200) nullable;
  L1Index in output schema; tool descriptions).

## Task 2 — Either-endpoint relation coverage

Smallest sufficient fix: DROP the both-endpoints post-filter at the paginated/scoped
call sites (readGraph, searchNodes recency + ranked) in both stores —
`getConnectedRelations` already fetches the OR set, so the fix is removing the narrowing
filter, not adding a query. `open_nodes` (no projectId) is the existing OR precedent;
its dual semantics is untouched.

New contract (documented on both tools + CLAUDE.md): returned relations touch AT LEAST
ONE returned entity; the partner endpoint may not be in the same page (it's a name —
open_nodes it if needed). A relation with both endpoints on-page appears once; across
pages a relation can appear on each endpoint's page (union = complete for read_graph;
dedup on (from,to,relationType) if unioning).

- [ ] Flip the existing page-local pins; add a union-across-pages = full-active-set
  completeness test (the 474-vs-156 shape, in miniature); ranked-mode edge test.
- [ ] Both stores + both tool descriptions + Known Limitations rewrite.

## Deviation log
1. [scope/consistency] searchNodesRanked's AND filter (written this morning with a
   "curated set" rationale) flipped along with the recency path — one relation semantic
   across all search/read surfaces beats per-mode semantics; the "half-dangling edge"
   concern is answered by endpoints being self-describing names.
2. [test-fidelity] JSONL two-tier getContextLayers shares the featured/index budgets via
   exported constants rather than magic numbers, so the parity tests pin one source.
3. [QA rounds, incl. outage recovery — see Discussion #89 for the full ledger]
   - Self-caught mid-QA by an empirical parity probe: JSONL project-scoped searchNodes
     AND-filtered against the MATCHED set (dropped matched→unmatched-in-project
     relations SQLite keeps) — fixed 724d5ac + shared parity pin. Independently found
     by both the workflow's correctness finder AND the bespoke code-reviewer.
   - Bespoke Phase A fixes (e9527d9): PaginatedOutputSchema still shipped the OLD
     page-local contract in the same tool as the new descriptions (HIGH);
     recency-search either-endpoint pin (HIGH); JSONL summary round-trip;
     tokenEstimate exactness; stale comments.
   - Workflow-journal recovery fixes (a1b5533): migrateFromJsonl DROPPED file-resident
     summaries (real bug — the column was missing from insertObs); context-layers
     pure-unit tests (the hint cap had NO binding test — a reviewer mutation probe
     proved it); ranked+scoped relation filter pin.
   - INCIDENT, process: a workflow finder left a live mutation in the working tree
     ('REVERT-EXPERIMENT': indexCharCost → return 0) — caught via the diagnostics
     stream, restored from HEAD before any commit. Mutation-probing reviewers must
     revert; future review prompts should say so explicitly, or reviews should run
     in worktree isolation.
   - Accepted without change: asOf+scoped+deleted-recreated-entity relation edge
     (historical-read tail, disproportionate to close); asOf-plumb-through coverage
     (verified by inspection at all three call sites); McpServer-layer schema gaps
     folded into Issue #81.
