# Memory-system backlog — open items

> Living open-items ledger for the memory system (mcp-memory-server + memory-graph-viz + the
> ~/.claude hooks). Update this file as items close (check the box, add the resolving date/commit).
> Last updated **2026-06-21** (orphaned 06-09 work landed to main; embeddings investigation closed —
> MiniLM for retrieval, bge for the suggester — the coarseness tradeoff is now measured + understood)
> (conversation `fbe2a512-8519-41c6-be2d-db52f1a2a7a1`). Narrative/decision context lives in MCP:
> entities `concept-aligned-embeddings`, `memory-graph-viz-continuity-thread`, `claude-self`.

**Shipped that session (context, not backlog):** decay gradient (built/QA'd/branch pushed);
concept-aligned embeddings Phases 0-4 (idea → validated → corrected → measured win +0.20 Spearman /
2.4× domain-sep → viewer-adopted → Dustin visually confirmed); project-mapping backfill (93 entities
re-scoped, rig-telemetry unblocked, weekly automation); L0 "22 chunks" diagnosed + stale flag cleared.

---

## Embeddings follow-ons
- [x] **Server-side adoption — RESOLVED NO-GO (2026-06-20).** Phases 0-2 ran (mechanism map, ONNX
  export + fidelity PASS at cosine 1.0, offline search-quality gate). The gate found our concept-tuned
  bge **regresses** the server's obs-level `find_precedents` retrieval (blind 54-judge panel: MiniLM
  16/18 vs bge 1/18). bge wins ENTITY-level clustering (→ the viewer) but loses OBS-level query
  retrieval (→ the server). **Server stays on MiniLM; viewer keeps bge.** Full evidence + steelman in
  `docs/superpowers/plans/2026-06-19-embeddings-server-adoption.md` ("Phase 2 RESULTS").
- [ ] **(Optional, NEW) Retrieval-preserving server embedder** — separate project: test whether a
  DIFFERENT model (bge-base untuned, or a retrieval-specialized model) beats MiniLM at *obs-level*
  retrieval. Our concept-tuned bge does not. Only worth it if MiniLM's obs retrieval proves a real
  bottleneck — no evidence it does yet.
- [ ] **More/better training data** — judge a sample of *far* pairs as hard negatives (the candidate
  set is only MiniLM-near pairs). Was the lever for a bigger *entity*-clustering win; the NO-GO above
  means it would only help the viewer, not the server. Optional, viewer-only now.
- [ ] **Viewer refresh** — re-run `concept_embeddings/bge_vectors.py` (venv) + `generate.py` to keep
  the concept-aligned viewer current as memory grows (currently a manual snapshot).
- [ ] **Model versioning / periodic re-tune** as the judged dataset grows (vec table should record
  which model wrote each vector).
- [ ] **Viewer: split layout/suggester controls + fix labels** — make the 3D `#layout` dropdown two
  independent controls (layout = MiniLM faithful / suggestion = bge); fix the "MiniLM — vocabulary"
  labels (MiniLM is semantic, not vocabulary). GATED on whether Dustin uses the edge suggester (the
  label fix is worth doing regardless).

## L0 / memory hygiene — pick ONE
- [ ] **Curate dishpipe's L1** (demote stale → `null`) — it's the lone L0 overflow (23 chunks). *or*
- [ ] **Add ~4 headroom `load-l0` entries** in settings.json (max_entries → 24) — the quick alternative.

## Decay follow-ons
- [ ] **First weekly Pass F run** — VERIFIED ready 2026-06-21: fires **Mon 06:00 PDT**; the first run
  does 1 real compression (`2026-06-08` → gist), the first true end-to-end agent-side Pass F. Fixed two
  stale-path doc bugs while verifying. Still TODO: glance at the first run's log (`~/Claude/consolidator/`).
- [ ] **Statusline autobiography-overflow flag** (deferred, MED) — port `load-l0`'s overflow flag to
  `load-episodic-autobiography.py`.
- [ ] **`verify_schema` parity** in `load-episodic-autobiography.py` (deferred, LOW).

## SessionStart hook detection
- [ ] **Load-receipt audit** (hard-hang detection) — deferred; slow-WARN covers creeping slowness and
  the 75-300× headroom made hard-hang low-value. Revisit only if a real timeout ever bites.

## Carryover (predates the marathon session, still open)
- [ ] **Digest continuous-audit** — extend `~/.claude/audit/run-memory-audit.py` to keep the
  self-model digest under *ongoing* audit (currently audited at authoring only).
- [ ] **Digest MVP behavior check** — the ~2-week "does the auto-loaded self-digest measurably change
  behavior" experiment (from 2026-06-10). Observational.

## mcp-memory-server code
- [x] **A.5 — `open_nodes` escape-hatch wording DONE (2026-06-21)** — index.ts read_graph/search_nodes +
  PaginatedOutputSchema descriptions now say "open_nodes WITHOUT a projectId" (project-scoped open_nodes
  applies the same both-endpoints AND-filter, dropping cross-project edges — **11+ confirmed in the live
  graph** via the new `sqlite-ro` MCP server, its first test-run). Doc-string only; build green.

## Version control
- [x] **memory-graph-viz git-inited (2026-06-20)** — `git init` + initial commit `7586e08` (code only;
  weights/data/HTML-snapshots gitignored for size + privacy). Phase 1/2 server-adoption tooling
  committed (`087efe1`, `e33721d`). `scripts/backfill_project.py` committed earlier (`a577a57`).
- [x] **Decay branch merged to main (2026-06-21)** — `episodic-decay-gradient` fast-forwarded into
  `main` (now `c555406`, pushed to origin). Bundled in the same landing: the orphaned 2026-06-09
  workspace-review work that had never been committed (test-pool OOM-safety `42c5e18`,
  page-local-relations API doc `69c23f2`) + the 06-04/05 design docs `c555406`. Rollback anchor: tag
  `pre-land-0609` → `39245de`.
