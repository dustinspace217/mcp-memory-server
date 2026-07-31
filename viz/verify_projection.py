#!/usr/bin/env python3
# Does PCA preserve cluster structure into 3-d? Related entities must end up CLOSER
# in 3-d than cross-domain ones. If this gate fails, PCA lost the structure -> UMAP.
import math, sys
from entity_vectors import compute_entity_vectors
from projection import project_3d

ev = compute_entity_vectors()
coords = project_3d(ev)
print(f"entities projected: {len(coords)}\n")

def dist(a, b):
    if a not in coords or b not in coords:
        return None
    return math.dist(coords[a], coords[b])

# EDIT THESE for your own database (same probe pairs as verify_entity_vectors.py);
# missing names are skipped gracefully.
near = [("related-entity-a", "related-entity-b"), ("same-domain-x", "same-domain-y")]
far = [("domain-one-entity", "unrelated-domain-entity"), ("another-entity", "unrelated-domain-entity")]

print("NEAR (expect SMALL 3-d distance):")
nd = []
for a, b in near:
    d = dist(a, b); nd.append(d)
    print(f"  {a} ↔ {b}: {d if d is None else round(d, 2)}")
print("FAR (expect LARGER 3-d distance):")
fd = []
for a, b in far:
    d = dist(a, b); fd.append(d)
    print(f"  {a} ↔ {b}: {d if d is None else round(d, 2)}")

nd = [d for d in nd if d is not None]
fd = [d for d in fd if d is not None]
# Also report the overall spread so we can see if it's a flat pancake.
import statistics
allcoords = list(coords.values())
for axis, label in enumerate("xyz"):
    vals = [c[axis] for c in allcoords]
    print(f"  axis {label}: range [{round(min(vals),1)}, {round(max(vals),1)}], stdev {round(statistics.pstdev(vals),1)}")

ok = nd and fd and max(nd) < min(fd)
print(f"\nGATE: max(near) < min(far)? {ok}  (max_near={round(max(nd),2) if nd else 'n/a'}, min_far={round(min(fd),2) if fd else 'n/a'})")
sys.exit(0 if ok else 1)
