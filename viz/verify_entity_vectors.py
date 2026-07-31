#!/usr/bin/env python3
# Phase-0 verification for entity_vectors.py: confirm the extraction produces
# MEANINGFUL geometry — entities the build session flagged as related must score
# high cosine, and clearly cross-domain pairs must score lower. If the rowid→entity
# join were wrong, these would be noise.
import sys
from entity_vectors import compute_entity_vectors, cosine

ev = compute_entity_vectors()
print(f"entities with vectors: {len(ev)}\n")

def sim(a, b):
    if a not in ev or b not in ev:
        return None
    return cosine(ev[a], ev[b])

# EDIT THESE for your own database: NEAR = two pairs of entities you know are
# genuinely related; FAR = two pairs from clearly unrelated domains. Missing
# names are skipped gracefully (score prints as None), so until you edit them
# the gate reports n/a. NOTE: keys are normalized_name (lowercase, separators
# stripped) to match compute_entity_vectors.
near_pairs = [
    ("related-entity-a", "related-entity-b"),
    ("same-domain-x", "same-domain-y"),
]
far_pairs = [
    ("domain-one-entity", "unrelated-domain-entity"),
    ("another-entity", "unrelated-domain-entity"),
]

print("NEAR (expect high):")
near_scores = []
for a, b in near_pairs:
    s = sim(a, b)
    near_scores.append(s)
    print(f"  {a} ↔ {b}: {s if s is None else round(s, 4)}")
print("FAR (expect lower):")
far_scores = []
for a, b in far_pairs:
    s = sim(a, b)
    far_scores.append(s)
    print(f"  {a} ↔ {b}: {s if s is None else round(s, 4)}")

# Sanity gate: every present near pair should beat every present far pair.
near_ok = [s for s in near_scores if s is not None]
far_ok = [s for s in far_scores if s is not None]
ok = near_ok and far_ok and min(near_ok) > max(far_ok)
print(f"\nGATE: min(near) > max(far)? {ok}  (min_near={round(min(near_ok),4) if near_ok else 'n/a'}, max_far={round(max(far_ok),4) if far_ok else 'n/a'})")
sys.exit(0 if ok else 1)
