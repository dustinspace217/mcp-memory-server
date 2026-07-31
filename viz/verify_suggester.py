#!/usr/bin/env python3
# Phase-1a verification: run the suggester on real data, show the top candidates
# with display names, and assert none of them are already-linked pairs.
import os, sys
from entity_vectors import compute_entity_vectors
from suggester import compute_suggestions
from generate import load_graph

DB = os.path.expanduser("~/.claude/memory.db")
graph = load_graph(DB)
edges = [e["data"] for e in graph["edges"]]
disp = {n["data"]["id"]: n["data"]["name"] for n in graph["nodes"]}

vectors = compute_entity_vectors(DB)
sugg = compute_suggestions(vectors, edges, k=6, cap=40)

print(f"entities w/ vectors: {len(vectors)} | existing edges: {len(edges)} | suggestions: {len(sugg)}\n")
print("Top 20 candidate links (unlinked but semantically near):")
for s in sugg[:20]:
    a = disp.get(s["source"], s["source"])
    b = disp.get(s["target"], s["target"])
    print(f"  {s['score']:.4f}  {a}  ↔  {b}")

# Sanity: no suggestion may be an already-linked pair.
linked = {frozenset((e["source"], e["target"])) for e in edges}
leaks = [s for s in sugg if frozenset((s["source"], s["target"])) in linked]
print(f"\nalready-linked leaks among suggestions: {len(leaks)} (must be 0)")
sys.exit(0 if not leaks else 1)
