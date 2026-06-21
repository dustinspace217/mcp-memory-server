# Plan + Spec — Post-Competitive-Review Memory Enhancements

> **This doc is the plan AND spec pairing** for the enhancements approved after the 2026-06-04 competitive review (`../specs/2026-06-04-competitive-memory-systems-review.md`). It is the anti-drift anchor: a post-compaction session should be able to execute from here without re-deriving. Decisions made by Dustin 2026-06-04/05 are recorded inline.

## Status (updated 2026-06-05)
Phase: pre-implementation (spec written; NO code yet on these items)
Approved to BUILD (Dustin 2026-06-04): **#1 semantic-NN suggester, #3 FTS5 search, #4 provenance/verify, #5 retrieval-strengthening.**
Deferred (do eventually): **#6 relation rationale + valid-time.**
Pending decision: **#2 automatic capture** (mechanism specced below; Dustin evaluating "is the 3rd capture mechanism + per-session cost worth it?").
Resolved this session: **#7 Phase-6 decay = stay deferred, evidence-based** (freshness flags ~1.3% stale ≪ the 20% trigger; see Evidence below).
Suggested build order (by size/independence): **#3 → #5 → #4 → #1.** (#3/#4/#5 are mcp-memory-server server code; #1 is the viewer + needs embedding access.)
Next: pick the first item; write its own focused implementation sub-plan if it exceeds ~100 lines or trips the Architect scope-audit triggers (CLAUDE.md).
Blocked: nothing. Trivial stragglers outstanding: delete `test-probe-entity` (junk, Dustin's call); `ollama-installation` left isolated until identified.

Each item below carries: **Benefit** / **Why-not** (the recorded counter-frame, so we never re-litigate blind) / **Spec**.

---

## #1 — Semantic nearest-neighbour suggestion layer  [BUILD]
- **Benefit:** surfaces meaningful-but-unlinked entity pairs as a reviewable ranked list — scales the manual link-finding we did all session into a suggestion engine; catches the *non-obvious cross-cluster* links the structural Pass-E orphan-suggester can't.
- **Why-not (recorded):** embedding similarity is a noisy proxy for "should be linked" — most high-cosine pairs are merely topically similar, so it can generate review burden + over-linking temptation. → Mitigation baked into the spec: present as *ranked candidates with the score visible*, never auto-link; default to a high cosine floor.
- **Spec:**
  - Embeddings are **per-observation** in `vec_observations` (sqlite-vec, MiniLM-L6 384-dim). There are NO entity-level vectors. Build an **entity vector = mean of its active observations' vectors** (L2-normalize after).
  - **FEASIBILITY GATE (resolve first):** the generator is Python and must read the float vectors. Either (a) load the `sqlite-vec` extension in the Python `sqlite3` connection (`conn.enable_load_extension(True)` + load the vec0 `.so`) and query the vectors, or (b) if the vectors aren't readable as plain blobs without the extension, write a small Node sidecar (the server already has sqlite-vec in JS) that emits entity-vectors as JSON for the generator. Decide (a) vs (b) before building.
  - Compute pairwise cosine among entity vectors (≤~310 entities → trivial O(n²) in numpy), OR KNN per entity via sqlite-vec on the entity-vector set.
  - **Filter:** drop pairs that already have an active relation (either direction); drop self; apply a **cosine floor** (start ~0.55, tune); keep **top-N** (≈30) globally.
  - **Surface in the viewer:** a "Suggestions" panel + faint **dashed candidate edges** (visually distinct from link-mode's amber staged edges) with the cosine score; clicking a suggestion **pre-fills the link-mode composer** (source+target) so accept → stage → export → commit flows into the existing pipeline. This makes the viewer the suggestion engine described in the 2026-06-04 review.
  - Output is advisory only; the viewer never writes the DB (same invariant as link mode).

## #3 — FTS5 keyword search + fusion  [BUILD]  (GitHub issue #30)
- **Benefit:** replaces the weak ASCII-only LIKE with real ranked keyword search (exact terms, filenames, identifiers the embedding misses).
- **Why-not (recorded):** server code + schema migration + test surface, and at ~1,900 obs the current vector+LIKE rarely *fails*, so the recall gain may be marginal. → Accepted because it's small, bounded, and both competitors validated a lexical stream.
- **Spec (mcp-memory-server):**
  - New FTS5 virtual table `observations_fts(content)` with `tokenize='porter unicode61'`, `content='observations'` (external-content) keyed to `observations.id`.
  - Keep in sync via AFTER INSERT/UPDATE/DELETE triggers on `observations` (mirror the existing vec-sync discipline). Backfill existing active obs on migration.
  - New schema version bump in `sqlite-store.ts` migration sequence (currently v10) — idempotent, transaction-wrapped, with a migration-validation test.
  - `searchNodes()`: run FTS5 `MATCH` ranked by `bm25()` alongside the existing vector KNN; **fuse** by Reciprocal Rank Fusion (or simpler: union + dedupe, FTS-ranked first) — FTS replaces the LIKE arm, vector stays the semantic arm. Respect existing pagination + `memoryType` filter + cursor fingerprint.
  - Tests: FTS match correctness, fusion ordering, backward-compat (no query → unchanged), JSONL backend stub (FTS is SQLite-only; JSONL keeps LIKE).
  - Update CLAUDE.md tool docs + test counts.

## #4 — Provenance / verify  [BUILD]
- **Benefit:** trace any memory to its source session/turn — direct anti-hallucination (Goal A); also hardens the Phase-7 self-audit (which already cites sources).
- **Why-not (recorded):** observations already carry `created_at` + `source_instance`, and incident entities point to `feedback_*` files — so much of "verify" is already covered. → Therefore scope #4 to the **genuinely net-new** part only, not a big subsystem.
- **Spec (smallest-sufficient):**
  - **Write-time provenance:** capture a finer source ref than the current coarse `source_instance` ('fedora'). Add (or populate) a `source_ref` on observations = the `session_id` (and, where the hook has it, a turn/source marker). The SessionEnd/Stop/PreCompact save hooks and mid-session writes already run inside a session that has `session_id` — thread it through. (Schema: reuse `source_instance` or add `source_ref TEXT DEFAULT ''`; prefer a new nullable column to avoid overloading.)
  - **`verify` tool (thin):** given an entity (or observation), return its provenance chain — `created_at`, `source_ref`/`source_instance`, full supersession history (this largely *reuses* `entity_timeline`), and the entity's relations + any `CAUSED_BY`/incident-entity pointers. Output = "here is what supports this and where it came from," not a truth-judgement.
  - Explicitly DO NOT rebuild what `entity_timeline` already gives — `verify` composes it. Keep the tool surface minimal (anti-bloat gate).

## #5 — Retrieval-strengthening usage signal  [BUILD]  ("biomimicry" — Dustin)
- **Benefit:** importance self-tunes from what's actually retrieved — valuable memories rise, dead ones sink, without manual reclassification (Pillar 2). Mirrors Hebbian / use-it-or-lose-it consolidation (Dustin's framing).
- **Why-not (recorded):** "retrieved" ≠ "used in reasoning" — the signal is a crude proxy that could mis-rank. → Mitigation: treat it as a *weak prior* the weekly consolidation agent applies *conservatively*, never a hot-path importance rewrite.
- **Spec:**
  - The store already has `last_accessed_at` on entities, touched by `searchNodes`/`openNodes`/`entityTimeline` (NOT by bulk `readGraph` — intentional, the §12 observer-effect rule; preserve that). Add a **retrieval counter**: `access_count INTEGER DEFAULT 0` on entities (and/or observations), incremented in the same `touchEntities`/`touchEntitiesByName` paths (same access-discipline — never on bulk reads, never by the eviction sweep).
  - **Strengthening lives in the weekly consolidation agent, not the server hot path** (matches the overhaul plan's explicit "importance-tuning via the agent" decision): a new consolidation sub-step nudges `importance` up a notch for entities with high `access_count` relative to age, and flags never-accessed-in-a-long-window entities as demotion candidates. Bounded nudges (±1, clamped), conservative.
  - Honest proxy note in the consolidation prompt: count = "surfaced by a query," not "load-bearing in a decision."
  - Pairs with #7: retrieval-strengthening is the *positive* half; decay (#7) is the *negative* half — if #7 is ever built, they share this access signal.

## #6 — Relation rationale + valid-time  [DEFER — do eventually]
- **Benefit:** edges carry *why they exist* + *when they were true* → self-explaining causal structure, point-in-time queryable, fixes the verbose-verb workaround (`drove tech decisions for via stated criteria`).
- **Why-not (recorded):** schema change to `relations` for a property most edges don't need; the "why" usually already lives in the connected entities' observations.
- **Defer rationale + trigger to revisit:** build when a concrete need recurs — e.g. the verbose-verb workaround shows up again, or a point-in-time "what did the graph assert on date X" query is actually wanted. **Design sketch when picked up:** add `rationale TEXT DEFAULT ''` + `valid_from`/`valid_to TEXT DEFAULT ''` to `relations`; populate optionally; extend `create_relations` input + the causal-edge guidance. (agentmemory's bitemporal `EdgeContext` is the reference.)

---

## #2 — Automatic capture + compression  [DECISION PENDING — mechanism specced for Dustin's call]

**How it would happen (Dustin's question):** a **Stop / SessionEnd hook spawns an isolated `claude -p` agent** — the SAME isolation pattern already proven by the weekly consolidation agent and the Phase-7 audit (`--settings` stripped, `--strict-mcp-config` memory-server-only, read-only built-in tools + the memory MCP, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`). That agent:
1. reads the **transcript slice since a watermark** (`lastCapturedAt` on `claude-self`), never the whole transcript (the Phase-7 size-wall fix — bounded to ≤1 window);
2. extracts decisions / procedures / preferences / experiential moments from the slice;
3. **classifies** them (importance / memoryType / contextLayer per the write policy) and **links** them (the enforcement-locus structural edges + causal edges);
4. writes via MCP and advances the watermark.

This is literally the **Phase-7 "bounded backstop agent," productionized and run per-session** instead of as an occasional gap-filler.

**Why-not (recorded, and it's the crux of the decision):** it would make **three** overlapping capture mechanisms — (a) in-context Claude saving at checkpoints (current), (b) the weekly consolidation agent (maintenance), (c) this per-session auto-capture. Risks: duplicate writes (mitigated by the watermark + `check_duplicates`), per-session `claude -p` cost + latency, and the deeper question of whether automatic extraction matches the *fidelity* of in-context capture (the Phase-7 thesis was that the in-context witness captures best because it holds the live reasoning; an isolated post-hoc agent re-reads a transcript and loses the un-uttered reasoning).

**The decision for Dustin:** is automatic per-session capture worth the third mechanism + cost, GIVEN that (a) the enforcement-locus rule + Pass E already attack the orphan root cause, and (b) Phase-7 already captures experiential texture in-context? Or is auto-capture better scoped to ONLY the mechanical "what happened / files touched / decisions" layer (where in-context capture is weakest and most-skipped), leaving experiential capture in-context? **Recommended framing if we do it:** scope it to mechanical-activity capture only, as a backstop, NOT a replacement for in-context experiential authoring — that minimizes the overlap and plays to where automation actually beats the human-in-the-loop.

---

## #7 — Phase 6 confidence decay  [DEFERRED — evidence-based, 2026-06-05]

**Evidence gathered (correcting an earlier unverified "hasn't happened" assertion):**
- Tier-1 freshness flags: **~1.3% stale** (4 of 309 active entities) — far under the plan's **>20%-per-run** trigger (#3).
- Most recent readable consolidation run (2026-06-01): the dominant defect was **unclassified observations** (55 reclassified by type), **NOT staleness**; the freshness pass (Pass A) wasn't rigorously run, so the stale rate is *incompletely* measured but nothing pointed to >20%. (This was the ONLY surviving log because the runner logged to volatile `/tmp`. **FIXED 2026-06-05:** `run-consolidation.sh` now logs to persistent `~/Claude/consolidator/` (mode 700, 8-week rotation), so the multi-pass stale-rate tracking below is now actually possible. The 2026-06-01 log was migrated there.)
- Triggers #1/#2 (Claude re-reads files it has memory for / adds "let me verify" preambles): **behavioral, not log-measurable, AND confounded** — the verify-over-recall discipline makes re-verification the default *by rule*, independent of memory staleness.

**Verdict:** stay deferred; the evidence supports NOT building it. **To revisit on real evidence:** track the consolidation agent's stale-supersession rate across several *full* runs (Pass A included) and watch the freshness-flag percentage; build Phase 6 only if stale rate sustains >~20% or trust problems appear that the freshness system isn't catching. (Phase-6 design already exists in `2026-04-13-memory-usability-overhaul.md` §Phase 6; agentmemory's forgetting curve is a reference impl. Note #5's `access_count` would feed decay's negative half if built.)

---

## Cross-cutting notes
- **Anti-bloat gate (project CLAUDE.md):** each item above must still pass goal-trace (A/B/C) + practical-use + cost-proportionality at build time. #4 and #5 are the highest bloat-risk (keep them minimal — verify reuses `entity_timeline`; strengthening is a weak agent-applied prior, not a subsystem).
- **Model rule:** these are Opus-authored → Opus review.
- **The over-linking lesson (2026-06-04):** #1 especially must resist link-for-completeness — ranked candidates + score-visible + high floor, human approves. (See the `claude-self` introspective 2026-06-04 + the enforcement-locus rule's "never link for completeness".)
