# Plan — Adopt concept-aligned embeddings in the LIVE memory server

> Switch the memory server's similarity substrate from MiniLM to the concept-aligned
> `bge-tuned-obs` model, so `search` / `find_precedents` / session recall use concept-over-
> vocabulary similarity — not just the viewer. Written 2026-06-19 at the close of the marathon
> session that built + validated the embedder (Phases 0-4). Resume conversation:
> `fbe2a512-8519-41c6-be2d-db52f1a2a7a1`. Full project detail on MCP entity
> `concept-aligned-embeddings` (project=memory-graph-viz).

## Status (updated 2026-06-19)
Phase: PRE-IMPLEMENTATION. The embedder is trained, eval-gate-passed, and viewer-adopted; the
  live server is NOT yet touched (it still embeds with ONNX MiniLM).
Done: `model-concept-aligned-obs/` (sentence-transformers, 384-d) — obs-pair fine-tuned; eval gate
  0.825 Spearman / 0.341 domain-sep (vs MiniLM 0.626 / 0.144); Dustin visually confirmed in the 3D
  viewer ("makes a LOT more sense"). Viewer reads a SHADOW JSON cache (`bge_vectors.json`), server
  untouched.
Next: Phase 0 — read the server's actual embedding mechanism, then export the model to ONNX.
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
