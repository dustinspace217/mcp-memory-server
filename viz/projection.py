#!/usr/bin/env python3
"""
Project entity-vectors (384-d) down to 3-d coordinates for the spatial graph.

UMAP (cosine metric) is the projection. It preserves LOCAL neighbourhood structure —
which PCA's top-3 linear axes did NOT: the 2026-06-10 PCA gate put clearly cross-domain
entity pairs CLOSER together than genuinely-related same-domain pairs, so a PCA cloud
would mislead about what's related. UMAP optimises for keeping each point near its
true neighbours, which is exactly what the spatial view needs to show.

Falls back to PCA (with a visible note) only if umap-learn can't be used, so the
generator still produces a page rather than crashing.

DETERMINISTIC: random_state pins the embedding so re-running generate.py gives the
same layout (a maintainability choice — a future session shouldn't get a different
graph each regenerate).
"""
import sys

import numpy as np

# UMAP knobs. n_neighbors a bit below the default 15 tightens local cluster structure
# on this ~240-entity graph; min_dist keeps clusters from collapsing to points; cosine
# matches how the embeddings encode meaning (unit vectors).
_N_NEIGHBORS = 12
_MIN_DIST = 0.12
_SEED = 42


def _pca_3d(X):
    """PCA fallback: project the centered data onto its top-3 principal axes."""
    Xc = X - X.mean(axis=0, keepdims=True)
    _, _, Vt = np.linalg.svd(Xc, full_matrices=False)
    return Xc @ Vt[:3].T


def project_3d(vectors):
    """
    Receives: vectors {normalized_name: [float * 384]} — unit entity-vectors.
    Returns:  {normalized_name: [x, y, z]} — UMAP coords, centered + uniformly scaled
              to a ~[-50, 50] cube (uniform scaling preserves relative distances).
    """
    names = list(vectors)
    if not names:
        return {}
    X = np.asarray([vectors[n] for n in names], dtype=np.float64)
    try:
        import umap
        reducer = umap.UMAP(n_components=3, metric="cosine",
                            n_neighbors=_N_NEIGHBORS, min_dist=_MIN_DIST,
                            random_state=_SEED)
        coords = np.asarray(reducer.fit_transform(X), dtype=np.float64)
    except Exception as exc:
        print(f"  (UMAP unavailable, falling back to PCA: {type(exc).__name__}: {exc})",
              file=sys.stderr)
        coords = _pca_3d(X)

    coords = coords - coords.mean(axis=0, keepdims=True)
    span = float(np.abs(coords).max())
    if span > 0:
        coords = coords / span * 50.0
    return {n: [round(float(v), 3) for v in coords[i]] for i, n in enumerate(names)}
