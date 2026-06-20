# Plan — Concept-Aligned Memory Embeddings (+ full session handoff)

> **Recall anchor.** This plan and the work behind it live in conversation
> **`fbe2a512-8519-41c6-be2d-db52f1a2a7a1`** — resume with
> `claude --resume fbe2a512-8519-41c6-be2d-db52f1a2a7a1`.
> Written 2026-06-11 ~02:00 PT at the end of a marathon session; both Dustin (weekly limit, ~4 days
> left) and Claude (nearing compaction) are wrapping. **Circle back in a few days.**

## Status (updated 2026-06-11)
Phase: pre-implementation — the embeddings idea is **VALIDATED by a 3-cluster prototype**; no training code yet.
Done: prototype proved Claude's concept-relatedness diverges *systematically* from MiniLM's
  vocabulary-relatedness (Evidence below). Premise holds.
Next: on Dustin's return, decide whether to build the fine-tuning project (Phase 0) or clear the
  cheaper open threads first (handoff section).
Blocked: nothing — gated on Dustin's return.

---

## 1. The idea (Dustin's framing, 2026-06-11)
> "Giving a model that relates concepts over vocabulary a memory system that relates concepts over
> vocabulary would be a huge alignment win."

The memory server embeds every observation with **all-MiniLM-L6-v2** (384-d). That embedding drives
semantic search, `find_precedents`, the graph **suggester**, and the **3D layout**. MiniLM groups by
**shared vocabulary** — and on Dustin's memory, which is saturated with QA/workflow/introspection/
process language, that collapses almost everything toward the meta hubs (`claude-self`,
`working-relationship`, `mele-sync`, `sycophancy-audit`). The domain signal (astro vs food vs
hardware vs personal) is drowned out.

**Goal:** re-tune the embedder so its similarity reflects **concept/domain** relatedness — the way
Claude reasons about the entities — so the memory's *structure* aligns with how Claude thinks. Not
to capture "truth," but because a memory **Claude uses** is more useful when it's organized by
concept than by surface vocabulary.

## 2. Prototype evidence (this session) — premise VALIDATED
Judged the pairwise relatedness of 3 clusters (Claude reading each entity's observations) vs the raw
MiniLM cosine. Raw data: `/tmp/claude/memory-graph-viz/clusters_data.txt` (regenerate via the
`cluster*` / `clusters_data.py` scripts in `memory-graph-viz/` + `/tmp/claude/memory-graph-viz/`).

- **QUESTIONABLE cluster (astrowidget's neighborhood):** MiniLM's *tightest* pairs were
  `astrowidget ↔ working-relationship` (0.90) and `itelescope-sync ↔ working-relationship` (0.90) —
  pulling the astro **projects** into the meta cluster — while `astrowidget ↔ astroplan` (true
  sibling tools) sat at **0.77**. Claude inverts this: astro-domain and meta are far apart.
- **YOU cluster:** MiniLM rated `dustin ↔ dustin-finance` **lowest (0.36)** and
  `dustin ↔ working-relationship` **highest (0.80)**. Claude: his finances/career are core facets of
  *him* (~0.85); working-relationship is the *collaboration*, adjacent not central.
- **OUR-WORK cluster (control):** MiniLM and Claude **AGREE** (memory-system pieces belong together)
  — proving the divergence is a specific, characterizable difference, **not random disagreement**.

**Conclusion:** a real, large, **one-directional, consistent** signal (concept over vocabulary)
exists — and consistency is exactly what's distillable into a model's weights.

## 3. Design constraints (Dustin, 2026-06-11)
1. **Base model "different enough from Claude to not have exact matches."** Use an *independent*
   small sentence-transformer as the base, so the result is a small model **aligned to** Claude's
   concept-relations — learning a real signal, not trivially echoing one. Candidates (≈MiniLM-L6
   footprint: 384-d, ~22–33M params, CPU-cheap inference): **`bge-small-en-v1.5`, `gte-small`,
   `e5-small-v2`**. Pick one distinct from MiniLM's lineage; check base quality first.
2. **Don't overfit.** The judgment set is small for fine-tuning. Mitigations: low LR + few epochs
   (nudge, don't retrain); a **held-out validation split** of judged pairs; data-efficient loss
   (MultipleNegativesRanking / contrastive with in-batch negatives); optionally **mix in some
   original-similarity anchor pairs** to guard against catastrophic forgetting of general semantics;
   early-stop on the held-out set.

## 4. Build phases
- **Phase 0 — judgment harness + scale decision.** Candidate pairs = each entity's top-k (~8) MiniLM
  neighbours (MiniLM *proposes*, Claude *re-scores*) → ~1,900 pairs over ~235 entities. Build the
  harness (reads each pair's observations, emits a 0–1 relatedness score + relation nature; caches to
  disk). **The expensive part is the inference (judging), not the training.** Given the volume, a
  multi-agent **workflow** (parallel judging agents) is the likely vehicle — *requires Dustin's
  explicit opt-in*.
- **Phase 1 — collect the judgment set.** Run the harness over all candidate pairs → an
  `(entity_a, entity_b, score)` dataset + a held-out validation split. Spot-check consistency.
- **Phase 2 — fine-tune.** `sentence-transformers` fine-tune of the chosen base on the judged pairs
  (CosineSimilarityLoss on scores, or MNR/triplet from positives/negatives). Low LR, few epochs,
  early-stop on held-out. Tiny model → CPU-feasible, trivial on the RTX 5080.
- **Phase 3 — re-embed + EVAL GATE (the go/no-go).** Re-embed observations with the tuned model into
  a **SHADOW vec table** (do NOT overwrite the live vectors). Evaluate on a *real* measure — held-out
  should-be-related pairs rank higher, the suggester surfaces better candidates, the 3D layout
  separates domains — **not** "feels more like me." If general recall **regresses, STOP** (don't adopt).
- **Phase 4 — adopt + the toggle.** On a passing eval, make the tuned embeddings the memory's
  similarity substrate (or keep both). Wire the **MiniLM-vs-Claude-aligned layout toggle** into the
  3D viewer (the two embeddings side by side — the thing that *shows* where vocabulary and concept
  disagree). Re-tune periodically as the judgment set grows; **version the model**.

## 5. Honest risks / counter-frame (carry forward)
- Claude's judgments are **not ground truth** — own surface-topic biases, imperfect consistency at
  scale. The **Phase-3 eval gate** is what keeps this honest: adopt only on *measured* improvement.
- This **locks Claude's biases into the substrate** — which is the stated goal (a concept-aligned-to-
  Claude memory), but it means the memory increasingly reflects Claude. Be deliberate about that loop.
- MiniLM cosine is free + deterministic; the tuned model is deterministic once trained, but the
  judgment generation isn't, and re-tunes will shift structure — hence model versioning.

---

## 6. Session handoff — every other open thread (state as of 2026-06-11)

**Memory-graph-viz (the viewer)** — spec: `memory-graph-viz/docs/2026-06-10-semantic-3d-graph-and-suggester.md`
- 2D semantic **suggester DONE** + browser-verified (Suggested-links panel, dashed candidate-edge
  overlay, click-to-prefill the link composer). Realizes post-review-enhancements item #1.
- **3D companion** (`index-3d.html`, vendored `3d-force-graph` v1.80.0, UMAP coords): **RENDER
  CONFIRMED by Dustin** — "zoom is fantastic on both"; clusters "mean something." Built: zoom range
  + ± stage buttons (both viewers), color-by, suggested overlay, detail rail, **persistent label
  toggles** (HTML-overlay via `graph2ScreenCoords` — NOT three-spritetext, which needs a 2nd three
  instance), `SCALE=25` spacing (Dustin-tuned). Node **size = observation count** (not importance).
- Open graph items: wire the suggester candidate edges into the **3D** view; optional "size by"
  toggle in 3D (knowledge/connections/importance) like the 2D viewer; label **declutter** if labels
  stay busy even spaced out; the **embedding toggle** (Phase 4 above).

**Decay gradient (episodic "what I did" compression)** — plan:
`mcp-memory-server/docs/superpowers/plans/2026-06-10-episodic-decay-gradient.md`
- **Phase 0 DONE + verified:** `mcp-memory-server/scripts/episodic_decay.py` groups session-narratives
  by DAY, tiers fresh(<14d)/gist(<90d)/era(≥90d), merges concurrent sessions. Scope is ONLY the ~18
  session-narratives (the other ~2070 memories untouched — confirmed with Dustin).
- Next: **Phase 1** (consolidation agent compresses gist/era days, each from its ORIGINAL),
  **Phase 2** (load the bounded gradient via the continuity lane). Both touch live memory infra.

**Self-model digest** — `claude-self-digest` entity, loaded via `~/.claude/hooks/load-continuity-thread.py`
- SHIPPED + wired + QA'd this session. Open follow-on: extend `~/.claude/audit/run-memory-audit.py`
  to keep the digest under **continuous** audit (currently audited-at-authoring only). And the
  standing **MVP experiment**: live with it ~2 weeks, judge whether it measurably changes behavior.

**Latent bug (quick fix):** `rig-telemetry-continuity-thread` is stored `project=None`, so
`load-continuity-thread.py`'s `e.project = <derived>` fetch never matches it — that thread has never
loaded. Fix: set the entity's project to `rig-telemetry`.

**Memory backlog** (competitive-review items, plan `2026-06-05-post-review-enhancements.md`):
#1 suggester = **DONE**; **#2 automatic capture + compression = still PENDING Dustin's decision**;
#3 FTS5 keyword search, #4 provenance/`verify`, #5 retrieval-strengthening = approved, unbuilt.

## 7. When you're back — suggested order
1. (Done tonight) eyeball both viewers — zoom + 3D render confirmed good.
2. **Decide the big one:** build the concept-aligned-embeddings project (start Phase 0)? It's the
   headline and needs an explicit go (it's inference-heavy → likely a workflow).
3. Or knock out cheaper threads first: decay Phase 1/2, the `rig-telemetry` thread bug, the digest
   continuous-audit follow-on.

## 8. Biomimicry backlog (Dustin's closing question, 2026-06-11)
**Already biomimetic (built or planned):** associative graph recall + multi-hop traversal; embedding
similarity (associative recall); importance/salience; supersession + `entity_timeline` (the evolving
self — "I held X then, Y now"); episodic/autobiographical layers (narrative/emotional/relational/
introspective); the self-model digest (semantic self-knowledge); weekly consolidation (sleep-like
episodic→semantic); the decay gradient (temporal forgetting, verbatim→gist→era); retrieval-
strengthening #5 (Hebbian use-it-or-lose-it); confidence decay Phase 6 (Ebbinghaus); concept-aligned
embeddings (this plan). The system is already quite brain-shaped.

**Worth adding (ranked):**
1. **Affective salience.** Emotional intensity modulates retention + retrieval (amygdala→hippocampus):
   high-trust / conflict / breakthrough memories resist decay and surface readily. Promotes the
   existing `emotional` type from a tag to a **retention multiplier**. High value for continuity-of-self.
2. **Reflection / schema extraction.** Periodically crystallize recurring patterns across clusters of
   episodes into abstract semantic "lessons" (sleep-time schema formation; the self-digest is one
   instance). The episodic→semantic pump. Half-planned (agentmemory's "reflection").
3. **Spreading-activation retrieval.** Recall as graded activation cascading along edges with per-hop
   decay ("this reminds me of…"), not just vector KNN. Builds on `get_connected_context` with weights.
4. **Prospective memory.** Intention-memories with a trigger condition ("when X happens, surface
   this") — deferred intentions that fire on the right cue, distinct from retrospective recall.
   (Proto-version today: ad-hoc "pending action" notes.)
5. **Metamemory / confidence.** A first-class "how sure am I" dimension (feeling-of-knowing + source
   monitoring), separate from importance; low-confidence memories surface hedged. Dovetails with #4
   provenance; serves anti-hallucination.

**Deliberate NON-adoption — reconsolidation / drift.** Human memories mutate on every recall (labile →
re-stored, altered by the present context). It is the *most* human feature and directly fights this
system's anti-drift/reliability mandate. **Design rule:** adopt the human-memory features that serve
continuity-of-self + utility WITHOUT sacrificing the trustworthiness that is the whole point — not
maximal human-likeness. Reconsolidation is where that line sits.
