#!/usr/bin/env python3
# Proper projection-quality test: NEIGHBORHOOD PRESERVATION. For each entity, what
# fraction of its top-k cosine-nearest neighbours stay among its top-k 3-d-nearest?
# This is what UMAP optimizes (and what the pair-gate failed to measure on a narrow band).
import numpy as np
from entity_vectors import compute_entity_vectors
from projection import project_3d

ev = compute_entity_vectors()
names = list(ev)
V = np.asarray([ev[n] for n in names])          # n x 384 (unit)
coords = project_3d(ev)
C = np.asarray([coords[n] for n in names])      # n x 3

S = V @ V.T                                     # cosine (unit vecs)
np.fill_diagonal(S, -2.0)
D = np.sqrt(((C[:, None, :] - C[None, :, :]) ** 2).sum(-1))  # 3-d euclidean
np.fill_diagonal(D, 1e18)

for k in (5, 10):
    cos_nn = np.argsort(-S, axis=1)[:, :k]
    d3_nn = np.argsort(D, axis=1)[:, :k]
    overlap = np.mean([len(set(cos_nn[i]) & set(d3_nn[i])) / k for i in range(len(names))])
    print(f"mean top-{k} neighbourhood preservation: {overlap:.3f}")

# Qualitative: a few entities' cosine neighbours vs their 3-d neighbours.
idx = {n: i for i, n in enumerate(names)}
# EDIT THESE for your own database: a few well-connected entity names (normalized
# form — lowercase, separators stripped); unknown names are skipped.
for probe in ("a-hub-entity", "another-hub-entity", "a-third-entity"):
    if probe not in idx:
        continue
    i = idx[probe]
    cos5 = [names[j] for j in np.argsort(-S[i])[:5]]
    d3_5 = [names[j] for j in np.argsort(D[i])[:5]]
    print(f"\n{probe}")
    print(f"  cosine-nearest: {cos5}")
    print(f"  3-d-nearest:    {d3_5}")
