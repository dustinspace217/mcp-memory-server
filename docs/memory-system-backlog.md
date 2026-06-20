# Memory-system backlog — open items

> Living open-items ledger for the memory system (mcp-memory-server + memory-graph-viz + the
> ~/.claude hooks). Update this file as items close (check the box, add the resolving date/commit).
> Last updated **2026-06-19** at the close of the decay + concept-aligned-embeddings marathon
> (conversation `fbe2a512-8519-41c6-be2d-db52f1a2a7a1`). Narrative/decision context lives in MCP:
> entities `concept-aligned-embeddings`, `memory-graph-viz-continuity-thread`, `claude-self`.

**Shipped that session (context, not backlog):** decay gradient (built/QA'd/branch pushed);
concept-aligned embeddings Phases 0-4 (idea → validated → corrected → measured win +0.20 Spearman /
2.4× domain-sep → viewer-adopted → Dustin visually confirmed); project-mapping backfill (93 entities
re-scoped, rig-telemetry unblocked, weekly automation); L0 "22 chunks" diagnosed + stale flag cleared.

---

## Embeddings follow-ons
- [ ] **Server-side adoption** — switch the live server's similarity substrate from MiniLM to
  `bge-tuned-obs` (so `search`/`find_precedents`/recall use concept-alignment, not just the viewer).
  **Deliberate build, not overnight** (touches the live server). Full spec:
  `docs/superpowers/plans/2026-06-19-embeddings-server-adoption.md`. *Most substantive open item.*
- [ ] **More/better training data** — judge a sample of *far* pairs as hard negatives (the candidate
  set is only MiniLM-near pairs). The lever for an even bigger model win; costs another judging
  workflow. Optional — only if server-search proves it's worth more.
- [ ] **Viewer refresh** — re-run `concept_embeddings/bge_vectors.py` (venv) + `generate.py` to keep
  the concept-aligned viewer current as memory grows (currently a manual snapshot).
- [ ] **Model versioning / periodic re-tune** as the judged dataset grows (vec table should record
  which model wrote each vector).

## L0 / memory hygiene — pick ONE
- [ ] **Curate dishpipe's L1** (demote stale → `null`) — it's the lone L0 overflow (23 chunks). *or*
- [ ] **Add ~4 headroom `load-l0` entries** in settings.json (max_entries → 24) — the quick alternative.

## Decay follow-ons
- [ ] **First weekly Pass F run** — autobiography compression is wired but only fires on the **Monday**
  consolidation timer; glance at that first run's log (`~/Claude/consolidator/`) to confirm it works
  in production.
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

## Version control
- [ ] **Commit/merge** — the decay branch `episodic-decay-gradient` is pushed but **not merged**; the
  embeddings code (memory-graph-viz, unversioned) + `scripts/backfill_project.py` (untracked in
  mcp-memory-server) are **uncommitted**.
