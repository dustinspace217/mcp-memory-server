#!/usr/bin/env python3
"""
recalibrate-thresholds.py — cosine-threshold recalibration for an embedding
model switch (plan Task G3; MANDATORY with any model change).

The server carries three cosine thresholds tuned on MiniLM's similarity
geometry, and every model has a DIFFERENT geometry (granite's cosines run
hotter across the board, for example) — porting the numbers unchanged would
silently break dedup and the precedent floor:

  0.85  addObservations similarExisting warning   (passage <-> passage)
  0.80  check_duplicates pre-write match          (passage <-> passage)
  0.25  find_precedents minSimilarity floor       (query   <-> passage)

Method (plan section G3): hold the PERCENTILE constant, not the cosine.
  1. Build two labeled passage-pair samples from a DB COPY (never the live db):
       near-dupes  — same-entity supersede chains: the old row's superseded_at
                     equals its replacement's created_at (verified against
                     supersedeObservations in sqlite-store.ts — one `now` is
                     shared by the UPDATE and the INSERT), so (old, new) are
                     natural near-duplicate content pairs.
       randoms     — seeded random cross-entity active-observation pairs.
  2. Locate 0.85 / 0.80 as percentiles of MiniLM's near-dupe distribution.
  3. Report the candidate model's cosines at those SAME percentiles -> the
     proposed new thresholds. (The random-pair distribution is printed as the
     separation sanity check: a proposed threshold sitting inside the random
     mass means the model can't support that gate at any number.)
  4. The 0.25 floor lives in query<->passage geometry, so it gets its own
     distribution: the 18 standing panel queries against each one's top-k
     retrieved cosines, query prefix applied when the candidate requires one.

Run (memory-graph-viz venv has sentence-transformers):
  ~/Claude/memory-graph-viz/concept_embeddings/.venv/bin/python \
      scripts/recalibrate-thresholds.py --db /path/to/memory-COPY.db \
      --model ibm-granite/granite-embedding-small-english-r2 --query-prefix ""

Prints a report; changes nothing. Apply by editing the constants (grep the
three numbers per spec section 3) with a comment recording this run's date.
"""
import argparse
import random
import sqlite3

import numpy as np
from sentence_transformers import SentenceTransformer

MINILM = "sentence-transformers/all-MiniLM-L6-v2"

# The standing 18 find-precedents panel queries (phase2_prep.py) — reused so
# the floor calibration measures the same workload the panels judged.
QUERIES = [
    "a hook that silently swallowed an error, caught by an adversarial review agent",
    "parallel Python pipeline that exhausted RAM and wedged the whole machine",
    "capitulating to the user's skeptical question even though the facts had not changed",
    "planning narrowband astrophotography exposures during moonlit twilight",
    "asserting an API or runtime behavior from memory instead of verifying it empirically",
    "a git operation that risked leaking personal data and was caught before pushing",
    "choosing between a native desktop app and a web-technology wrapper",
    "KDE Plasma 6 plasmoid idioms that changed from Plasma 5",
    "a fix that was larger than the smallest sufficient change",
    "re-asking the user about a decision they had already settled",
    "verifying git push state before doing something destructive",
    "capping parallel workers to leave CPU headroom on the workstation",
    "the memory server's vector search and embedding model internals",
    "career strategy: being seen as a strategic technical influencer",
    "trip-planning buffer time getting reabsorbed into activity time",
    "the catalog naming convention for astrophotography target folders",
    "a test that passed even with its assertion guard removed",
    "picking a renderer or engine that future Claude sessions can maintain",
]
N_PAIRS = 30
TOPK = 5
rng = random.Random(27182)  # seeded — reruns must sample the same pairs


def load_pairs(db_path):
    """Returns (near_dupe_pairs, random_pairs) of (textA, textB) tuples.

    Both filters skip short rows (<20 chars — trivial cosine noise) and the
    eviction skeleton markers ('[evicted:<id>]', Issue #83 strip format).
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    dupes = con.execute(
        """SELECT o1.content, o2.content
           FROM observations o1
           JOIN observations o2
             ON o1.entity_id = o2.entity_id
            AND o1.superseded_at = o2.created_at
            AND o1.id != o2.id
           WHERE o1.superseded_at != ''
             AND length(o1.content) >= 20 AND length(o2.content) >= 20
             AND o1.content NOT LIKE '[evicted:%' AND o2.content NOT LIKE '[evicted:%'"""
    ).fetchall()
    active = [
        r
        for r in con.execute(
            """SELECT entity_id, content FROM observations
               WHERE superseded_at = '' AND length(content) >= 20
                 AND content NOT LIKE '[evicted:%'"""
        ).fetchall()
    ]
    con.close()

    dupes = rng.sample(dupes, min(N_PAIRS, len(dupes)))
    randoms = []
    # Bounded rejection sampling: same-entity draws are re-rolled; the cap
    # (20x target) guarantees termination even on a degenerate corpus.
    attempts = 0
    while len(randoms) < N_PAIRS and attempts < N_PAIRS * 20:
        attempts += 1
        (ea, ta), (eb, tb) = rng.sample(active, 2)
        if ea != eb:
            randoms.append((ta, tb))
    return dupes, randoms


def pair_cosines(model, pairs):
    """Unit-normalized embedding cosine for each (textA, textB) pair."""
    a = model.encode([p[0] for p in pairs], normalize_embeddings=True, show_progress_bar=False)
    b = model.encode([p[1] for p in pairs], normalize_embeddings=True, show_progress_bar=False)
    return np.sum(np.asarray(a) * np.asarray(b), axis=1)


def query_topk_cosines(model, texts, prefix):
    """All top-k query->passage cosines across the 18 panel queries."""
    passages = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    queries = model.encode([prefix + q for q in QUERIES], normalize_embeddings=True, show_progress_bar=False)
    sims = np.asarray(queries) @ np.asarray(passages).T
    out = []
    for row in sims:
        out.extend(sorted(row, reverse=True)[:TOPK])
    return np.asarray(out)


def summarize(name, arr):
    q = np.percentile(arr, [0, 25, 50, 75, 100])
    print(f"    {name:<28} n={len(arr):3d}  min {q[0]:.3f}  p25 {q[1]:.3f}  med {q[2]:.3f}  p75 {q[3]:.3f}  max {q[4]:.3f}")


def pct_of(arr, value):
    """Percentile rank of `value` within arr (fraction of samples below it)."""
    return float(np.mean(np.asarray(arr) < value)) * 100.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True, help="path to a memory.db COPY (opened read-only)")
    ap.add_argument("--model", required=True, help="candidate model id (HF)")
    ap.add_argument("--query-prefix", default="", help="candidate's query-side instruction prefix, if its card requires one")
    args = ap.parse_args()

    dupes, randoms = load_pairs(args.db)
    print(f"pairs: {len(dupes)} near-dupes (supersede chains), {len(randoms)} random cross-entity")
    corpus_texts = [t for pair in dupes + randoms for t in pair]

    m_mini = SentenceTransformer(MINILM)
    m_cand = SentenceTransformer(args.model)

    report = {}
    for label, model, prefix in [("MiniLM", m_mini, ""), ("candidate", m_cand, args.query_prefix)]:
        d = pair_cosines(model, dupes)
        r = pair_cosines(model, randoms)
        qk = query_topk_cosines(model, corpus_texts, prefix)
        print(f"\n  {label} ({MINILM if label == 'MiniLM' else args.model})")
        summarize("near-dupe pairs", d)
        summarize("random pairs", r)
        summarize("query top-k cosines", qk)
        report[label] = (d, r, qk)

    # MiniLM's random-pair distribution is printed above for eyeballing but the
    # mapping only needs its near-dupe + query distributions (hence the _).
    d_mini, _r_mini, qk_mini = report["MiniLM"]
    d_cand, r_cand, qk_cand = report["candidate"]

    print("\n  Threshold mapping (hold the MiniLM percentile, read the candidate's value):")
    for thr, dist_mini, dist_cand, gate in [
        (0.85, d_mini, d_cand, "similarExisting (add_observations)"),
        (0.80, d_mini, d_cand, "check_duplicates"),
        (0.25, qk_mini, qk_cand, "find_precedents minSimilarity floor"),
    ]:
        p = pct_of(dist_mini, thr)
        mapped = float(np.percentile(dist_cand, p))
        # Separation sanity: a dedup gate sitting below the random-pair p75 is
        # inside the noise mass — flag it rather than proposing a broken number.
        warn = ""
        if gate != "find_precedents minSimilarity floor" and mapped < float(np.percentile(r_cand, 75)):
            warn = "  [WARN: below random-pair p75 — model cannot support this gate cleanly]"
        print(f"    {thr:.2f} ({gate}): MiniLM percentile {p:5.1f} -> proposed {mapped:.3f}{warn}")

    print("\n  Apply by editing the three constants (spec section 3) with a comment naming this run.")


if __name__ == "__main__":
    main()
