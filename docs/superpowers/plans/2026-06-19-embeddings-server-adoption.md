# Plan — Adopt concept-aligned embeddings in the LIVE memory server

> Switch the memory server's similarity substrate from MiniLM to the concept-aligned
> `bge-tuned-obs` model, so `search` / `find_precedents` / session recall use concept-over-
> vocabulary similarity — not just the viewer. Written 2026-06-19 at the close of the marathon
> session that built + validated the embedder (Phases 0-4). Resume conversation:
> `fbe2a512-8519-41c6-be2d-db52f1a2a7a1`. Full project detail on MCP entity
> `concept-aligned-embeddings` (project=memory-graph-viz).

## Status (updated 2026-06-20) — CONCLUDED: NO-GO, STOP AT VIEWER
Phase: 2 DONE → **GATE VERDICT: NO-GO.** The offline search-quality gate found bge REGRESSES the
  server's obs-level retrieval (blind panel: MiniLM 16/18 vs bge 1/18). Do NOT proceed to Phase 3
  cutover. The live server stays on MiniLM. The viewer keeps bge (its entity-clustering win is real
  and independent). See "Phase 2 RESULTS" at the bottom. Phases 1's export tooling is kept for the
  record / a possible future re-test with a different (retrieval-preserving) model.
Done: `model-concept-aligned-obs/` (384-d) eval-gate-passed + viewer-adopted (Dustin: "makes a LOT
  more sense"). NOW ALSO: exported to transformers.js-loadable ONNX (`concept_embeddings/onnx-export/
  bge-concept-aligned-obs/`, gitignored), fidelity-verified TWICE — Python onnxruntime AND the server's
  own transformers.js runtime both reproduce the PyTorch reference at cosine 1.000000 (5 texts, varied
  length, padded batch). Local-path loading works → NO HF Hub upload needed (model stays private).
Next: NOTHING on the server. The plan is concluded NO-GO. (Optional future, separate project: test
  whether a DIFFERENT model — bge-base untuned, or a retrieval-specialized model — beats MiniLM at
  obs-level retrieval; our concept-tuned bge does not.)
KEY CORRECTION (carried-forward error fixed): bge uses **CLS pooling**, the server hardcodes
  `pooling:'mean'` (right for MiniLM). Proven: cls→cosine 1.0, mean→~0.96 (silent ~4% drift). So Phase 3
  must flip pooling 'mean'→'cls' TOGETHER with the model — it is NOT a pure model-id swap.
Blocked: nothing — gated on Dustin starting this as a deliberate (not overnight-autonomous) build,
  because it touches the live running server (high blast radius).

## Why this is its own deliberate build (read before starting)
This modifies the LIVE memory server every session depends on. It is explicitly NOT a
"kick-off-and-go-to-bed" task. It wants: a shadow-table-first migration (never overwrite the live
MiniLM vectors until cutover), a measured eval before cutover (same discipline as the Phase-3
gate — adopt only on measured improvement), a rollback flag, and Dustin in the loop at cutover.
The viewer already banked the win; the server is upside, not urgency.

## The challenge
The server embeds observations with **all-MiniLM-L6-v2** via ONNX (384-d) on WRITE (each new obs)
and embeds the QUERY on search. `bge-tuned-obs` is a PyTorch sentence-transformers model. To use it
in the server we must export it to ONNX and match the server's tokenization/pooling/normalization.
Both models are **384-d**, so the vec-table schema is drop-in (no dimension change).

## Phases
- **Phase 0 — VERIFY the server's embedding mechanism (do NOT assume).** Read `index.ts` (and any
  embedding module) to confirm: which ONNX runtime (onnxruntime-node? transformers.js?), where the
  MiniLM model file lives, the pooling (mean? CLS?), whether vectors are L2-normalized, and the
  write-path + query-path embedding call sites. This dictates everything below. Record findings here.
- **Phase 1 — Export `bge-tuned-obs` to ONNX + FIDELITY CHECK.** Use `optimum`/`sentence-transformers`
  ONNX export. Then VERIFY: embed a sample of texts with both the PyTorch model and the exported ONNX
  (via the server's runtime), assert cosine ≈ 1.0 (within ~1e-3). bge-small-en-v1.5 is symmetric (no
  query prefix needed for s2s); confirm pooling = mean + normalize to match training. A failed
  fidelity check STOPS here — a mis-exported model silently degrades every embedding.
- **Phase 2 — Shadow vec table (no overwrite).** Back up memory.db (online-backup API). Re-embed all
  active observations with the ONNX bge into a SECOND vec table (e.g. `vec_observations_bge`),
  leaving the live MiniLM `vec_observations` untouched. Reuse the per-obs → entity-mean pattern.
- **Phase 3 — Server read-path behind a flag + EVAL GATE.** Add a config flag (env or settings) that
  routes `search` / `find_precedents` to the bge shadow table (query embedded with bge ONNX). Default
  OFF. Re-run `concept_embeddings/eval.py` against the shadow vectors + spot-check real queries
  ("find precedents for X") MiniLM-vs-bge. Adopt ONLY on measured improvement + Dustin's spot-check.
- **Phase 4 — Cutover + rollback.** On a passing gate: make bge the default substrate; the WRITE path
  embeds new obs with bge ONNX (keep writing MiniLM too during a bake-in, OR accept MiniLM-table
  staleness). Keep a flag to revert to MiniLM and keep BOTH vec tables for a bake-in period. Document
  the rollback one-liner.

## Risks / guards
- **ONNX fidelity** (Phase 1 gate) — the #1 silent-failure risk. Verify before anything downstream.
- **Pooling/normalization mismatch** — bge mean-pools + normalizes; the server's MiniLM path must be
  matched exactly or similarities are garbage. Verify in Phase 0/1.
- **Write-path drift** — after cutover, new obs must embed with bge or the shadow table goes stale.
- **Concurrency** — the server runs during the Phase-2 migration; use the same busy_timeout +
  backup-first discipline as `backfill_project.py`. Prefer migrating during an idle window.
- **Re-tune cadence** — as the judged dataset grows, the model can be re-tuned; VERSION the model
  (the vec table should know which model wrote it) so a re-embed is unambiguous.

## Smaller-win alternative (if full server adoption isn't worth it)
The VIEWER adoption (done) already delivers the suggester + 3D benefit. If server-search improvement
proves marginal in the Phase-3 spot-check, STOP at the viewer — the headline win is already banked.
The eval gate's job is to make that call honestly, not to justify the migration.

---

## Phase 0 FINDINGS (verified 2026-06-20) — these REVISE the phases above
The server embeds via **`@huggingface/transformers` (transformers.js v4.0.1)**, NOT raw onnxruntime:
`pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {dtype:'fp32'})` then
`pipe(text, {pooling:'mean', normalize:true})` (in `embedding.ts`). This is a GIFT — transformers.js
loads ONNX models by HF model-id (or local path), so adoption is "hand it a transformers.js-format
ONNX of bge-tuned-obs + change the model id," not a custom onnxruntime build.

- **Model id**: hardcoded `MODEL_NAME` (`embedding.ts:14`). **Recommend making it an ENV VAR** so
  rollback is a config flip, not a code revert + rebuild.
- **Dim**: `EMBEDDING_DIM=384` (`embedding.ts:17`), baked into the `vec_observations` vec0 schema
  (`sqlite-store.ts ~894`). bge-small-en-v1.5 is **also 384 → drop-in, NO schema migration.**
- **Pooling/normalize**: server hardcodes mean-pool + L2-normalize (right for MiniLM). ⚠️ **CORRECTED
  IN PHASE 1**: bge uses **CLS pooling**, NOT mean (`1_Pooling/config.json` → `"cls"`). Proven by the
  fidelity check: cls→cosine 1.0 vs PyTorch, mean→~0.96 (a silent ~4% drift, not a crash). So the swap
  must flip `pooling:'mean'`→`'cls'` in `embedding.ts` TOGETHER with the model — NOT a pure id swap.
  normalize:true is unchanged (bge normalizes too).
- **Query instruction**: CONFIRMED in Phase 1 — no prefix needed. Embedding raw text (no "Represent
  this sentence…") reproduces the PyTorch reference at cosine 1.0, so the symmetric-use assumption holds.
- **Call sites** (all call the same `embeddingPipeline.embed()`): WRITE = addObservations →
  syncEmbedding → insert `vec_observations` (`sqlite-store.ts ~1213/1220`); QUERY = findPrecedents
  (`~2996`) + the add_observations dedup check (`~1608`) + check_duplicates.
- **Existing vectors**: the startup embedding sweep only embeds obs MISSING a vector — it will NOT
  re-embed the existing MiniLM vectors. So migration = **CLEAR `vec_observations` + re-sweep.**
- **Thresholds to re-tune** (bge's similarity distribution differs from MiniLM's): dedup `>0.85`
  (`~1639`), check_duplicates `>0.80` (`~1662`), find_precedents floor `0.25` (`~2986`).

### Revised phases (supersede the originals above)
- **Phase 0 — DONE** (above).
- **Phase 1 — DONE ✅** (see "Phase 1 RESULTS" at the very bottom). Exported via `torch.onnx.export`
  (not optimum — avoids a transformers-version conflict on the bleeding-edge venv), loaded from a LOCAL
  path (no HF Hub upload), fidelity PASSED at cosine 1.0 in BOTH Python onnxruntime and the server's
  transformers.js. Tooling: `concept_embeddings/{export_onnx,py_fidelity,dump_ref}.py`.
- **Phase 2 — OFFLINE search-quality gate (no live change).** Simulate the server's obs-level KNN
  (embed real queries + all obs with bge, apply the same `1 - dist²/2` + floor) and compare
  MiniLM-vs-bge on real "find precedents for X" queries + held-out pairs. GO/NO-GO — adopt only on
  measured + spot-checked improvement; if marginal, STOP (the viewer win is already banked).
- **Phase 3 — Cutover (gated, reversible).** Make `MODEL_NAME` an ENV VAR (default still MiniLM);
  `npm run build`; BACK UP memory.db; flip env→bge + restart; clear `vec_observations` so the sweep
  re-embeds all obs with bge; re-tune the three thresholds empirically. Rollback = flip env back +
  re-embed (the backup is the belt).
- **Phase 4 — Bake-in.** Watch dedup/precedent quality; keep the backup + the env flip as the
  one-step rollback. Re-tune as the judged set grows; record the model id with the vectors.

---

## Phase 1 RESULTS (2026-06-20) — export + fidelity PASSED
- **Export**: `concept_embeddings/export_onnx.py` exports the bge backbone (BertModel, 384-hidden)
  to ONNX via `torch.onnx.export` (opset 14, dynamic batch+seq, emits `last_hidden_state`). Chose
  torch's tracer over `optimum` because the fine-tune venv runs transformers 5.12.1 (bleeding edge)
  and optimum pins older transformers — torch.onnx avoids the conflict and only needs `onnx` +
  `onnxruntime` (both have Python-3.14 wheels: onnx 1.22.0, onnxruntime 1.27.0). Output:
  `concept_embeddings/onnx-export/bge-concept-aligned-obs/{config.json,tokenizer*.json,onnx/model.onnx}`
  (133 MB fp32; gitignored). Layout = transformers.js convention; `dtype:'fp32'` loads `onnx/model.onnx`.
- **Fidelity (two independent runtimes, both PASS)**: 5 probe texts (3–66 tokens, run as a padded
  batch to stress masking + dynamic axes).
  - Python onnxruntime + CLS-pool + normalize vs PyTorch sentence-transformers → **cosine 1.000000** (min).
  - The server's own transformers.js (v4.0.1, node v22) loading the LOCAL model, `pooling:'cls'` →
    **cosine 1.000000** (min). The two runtimes also agree to 6 decimals on the (wrong) mean-pool
    numbers (min 0.945988) — strong cross-validation.
- **Confirmed**: (a) CLS pooling is required (mean → ~0.96 silent drift); (b) no query prefix needed;
  (c) **local-path loading works** (`env.allowLocalModels=true` + `env.localModelPath`), so the model
  can live inside the server dir and stay private — no HF Hub upload.
- **Phase 3 implication** (NOT taken — see Phase 2 verdict): the server change WOULD have been (1) point
  the loader at the local bge dir, (2) change `pooling:'mean'`→`'cls'`, behind one env switch. Documented
  for completeness only.

---

## Phase 2 RESULTS (2026-06-20) — GATE VERDICT: **NO-GO, STOP AT VIEWER**
Tooling: `concept_embeddings/phase2_prep.py` (+ a throwaway 54-agent blind-judge workflow).

**What was measured.** The server's `find_precedents` embeds a QUERY and does obs-level KNN over
`vec_observations`. So the realistic test is obs-level query→observation retrieval, MiniLM vs our
concept-tuned bge, on 18 realistic queries, scored by a blind panel (3 perspective-diverse judges per
query, model identity hidden, A/B order seeded-random).

**Result — bge REGRESSES obs-level retrieval:**
- Blind panel: **MiniLM 16/18 (89%), bge 1/18, 1 tie.** Judges' reasons were consistent: at the obs
  level bge surfaced *surface-keyword* matches ("hook", "memory") while MiniLM surfaced the
  *conceptually* on-point observation. (The one bge win was the narrowband-astro query.)
- This INVERTS the entity-level picture, and coherently so:
  - bge WINS entity-level concept clustering — eval gate Spearman 0.825 vs 0.626, domain-sep 0.341 vs
    0.144; fair domain-retrieval precision@5 0.248 vs 0.171. → this is what improved the VIEWER.
  - MiniLM WINS obs-level query retrieval. → this is what the SERVER's find_precedents does.
- (The pair-retrieval metric in phase2_prep that *favored* MiniLM is separately CONTAMINATED — targets
  are MiniLM's own top-8 neighbours — and was discarded. It is NOT the basis for this verdict; the
  blind obs-level panel is.)

**Mechanism.** bge-small-en-v1.5's base strength is query→passage retrieval. We fine-tuned it on
ENTITY-PAIR concept-relatedness, which sharpened whole-entity clustering (great for the graph layout)
but traded away per-observation retrieval acuity — exactly the skill find_precedents needs. The
fine-tune optimized the wrong granularity for the server.

**Steelman of bge (considered, rejected):** (a) "queries favor MiniLM's vocabulary" — judges scored
*concept* match and explicitly penalized surface-keyword wins, yet still chose MiniLM; (b) "bge is
misused at obs level" — true, but the server IS obs-level, so that's a reason not to adopt it, not an
artifact; (c) "bge-BASE (untuned) might beat MiniLM at obs retrieval" — possibly, but that abandons the
concept-alignment entirely and is a different project (noted as optional future work), not this swap.

**Decision.** NO-GO on adopting OUR TUNED model. The live server stays on MiniLM (no regression, no
migration, no risk). The viewer keeps bge — its entity-clustering win is real and independent. The
offline gate caught a silent retrieval regression BEFORE any live change.

## Phase 2b CONTROL (2026-06-20) — bge-BASE vs MiniLM (corrects the framing above)
Prompted by Dustin's pushback ("how is a vocabulary matcher better than a concept matcher? shouldn't
concept-matching win retrieval?"). He was right to push — the "Phase 2" framing of *MiniLM/vocabulary
beats concept* was WRONG and is corrected here.
- Ran the CONTROL: untuned **bge-small-en-v1.5** vs MiniLM, same obs-level blind harness. **Crucial fix:**
  bge retrieval is ASYMMETRIC — the query needs the instruction prefix "Represent this sentence for
  searching relevant passages: " (passages don't). My first base run OMITTED it and bge-base leaned to a
  loss; adding it is the fair test.
- **Result (prefixed, fair): bge-base 8, MiniLM 9, 1 tie — a statistical DEAD HEAT** (1 judge/query, n=18).
  Contrast: our TUNED bge lost 1–16. So the untuned base model is FINE; only our fine-tune regressed.
- **Corrected conclusions:**
  1. MiniLM is NOT a "vocabulary matcher" — it's a strong SEMANTIC model (canine→dog), which is why it
     ties a strong concept model. The earlier "vocabulary beat concept" framing was wrong (mine).
  2. Our tuned model failed for a SPECIFIC reason (entity-domain overfitting wrecked per-obs retrieval),
     NOT because "concept matching loses." Confirmed: bge-base retrieves fine.
  3. Server stays MiniLM for the HONEST reason: it's already ≈ as good as the best drop-in alternative on
     this short/dense/jargon corpus. **No free win** in switching — tuned regresses, base ties.
- Dustin's intuition (a good concept model should be competitive at retrieval) is VINDICATED. The viewer
  split is unchanged and still right: layout/retrieval → MiniLM (faithful, ≈ best); edge suggester →
  bge-tuned (entity-relatedness is its trained strength — the concept-over-vocabulary win at the right
  granularity). Tooling: `concept_embeddings/phase2_base.py`.

