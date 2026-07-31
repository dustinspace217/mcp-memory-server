#!/usr/bin/env python3
"""
Nearest-neighbour link suggester — the "what should I connect?" engine.

Given the entity-vectors (from entity_vectors.py) and the graph's existing edges,
this surfaces the pairs that are semantically CLOSE but NOT yet linked — the gap
between "near in meaning" (the embeddings) and "actually linked" (the curated graph).

WHY top-k-per-entity instead of a global cosine floor:
  On same-author technical memory the cosine values pack into a narrow high band
  (~0.64-0.77 measured 2026-06-10), so a single absolute floor (e.g. 0.55) admits
  almost every pair — thousands of mostly-noise candidates. Taking each entity's
  own top-k nearest UNLINKED neighbours is *relative* to that node, so the list stays
  bounded and relevant even when the whole graph is tightly clustered. The score is
  surfaced in the UI so the human still judges; this only proposes.

It is a DISCOVERY AID, not an auto-linker: similar != should-be-linked, embeddings
can't supply the verb or direction, and some hits are spurious. Expect to reject many.
"""


def _cos(a, b):
    # Vectors are unit-length (entity_vectors normalizes), so cosine == dot product.
    return sum(x * y for x, y in zip(a, b))


def compute_suggestions(vectors, edges, k=6, cap=40, ceiling=0.98):
    """
    Return unlinked semantically-near entity pairs, ranked.

    Receives:
      vectors : {normalized_name: [float]} — unit entity-vectors (entity_vectors.py).
      edges   : iterable of dicts each with 'source' and 'target' (normalized_name)
                — the EXISTING relations, used to exclude already-linked pairs.
      k       : neighbours considered per entity (the relative cut).
      cap     : max suggestions returned globally (keeps the panel reviewable).
      ceiling : drop pairs at/above this cosine. A near-1.0 score between two DISTINCT
                entities means their aggregate content is ~identical — that is a
                DUPLICATE-content signal (merge candidate / boilerplate stub), not a
                "you should link these" signal, and it otherwise floods the top of the
                list and buries the genuine cross-cluster suggestions. (Measured
                2026-06-10: sparse code-file stubs produced a band of exact-1.0 pairs.)

    Returns: list of {"source", "target", "score"} dicts, deduped to one entry per
    unordered pair, sorted by cosine descending. Direction is arbitrary — the human
    picks the verb + direction when staging the link.
    """
    # Already-linked pairs (either direction) as unordered keys, so a suggestion is
    # never offered for something the graph already asserts.
    linked = set()
    for e in edges:
        linked.add(frozenset((e["source"], e["target"])))

    names = list(vectors)
    best = {}  # frozenset({a, b}) -> highest cosine seen for that pair

    for a in names:
        va = vectors[a]
        # Score every OTHER entity, skip self / already-linked / near-duplicate, keep
        # this entity's top-k. (O(n^2) overall; trivial at ~235 entities.)
        scored = []
        for b in names:
            if b == a:
                continue
            pair = frozenset((a, b))
            if pair in linked:
                continue
            score = _cos(va, vectors[b])
            if score >= ceiling:
                continue  # ~identical content -> duplicate signal, not a link candidate
            scored.append((score, b))
        scored.sort(reverse=True)
        for score, b in scored[:k]:
            pair = frozenset((a, b))
            if pair not in best or score > best[pair]:
                best[pair] = score

    suggestions = []
    for pair, score in best.items():
        src, tgt = tuple(pair)
        suggestions.append({"source": src, "target": tgt, "score": round(score, 4)})
    suggestions.sort(key=lambda d: d["score"], reverse=True)
    return suggestions[:cap]
