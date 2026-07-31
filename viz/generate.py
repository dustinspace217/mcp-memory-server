#!/usr/bin/env python3
"""
Memory Graph Visualizer — generator
====================================

Reads the live MCP memory-server SQLite database (READ-ONLY) and emits a single
self-contained `index.html` that renders the knowledge graph: entities as nodes,
relations as directed edges, observations shown in a detail panel on click.

WHY a generator that bakes a snapshot into the HTML, rather than a live web app:
  - The graph is small (~300 nodes / ~245 edges). A static snapshot needs no
    running server, has no memory-leak surface, and is trivially refreshed by a
    future session: just re-run this script.
  - Opening index.html via the file:// protocol cannot fetch() a sibling .json
    file (browsers block file-origin cross-file requests), so the data is
    embedded directly into the page as a `const GRAPH = {...}` literal.

WHY read-only on the database:
  - A viewer must never be able to corrupt the thing it is viewing. We open the
    DB through a `file:...?mode=ro` URI (uri=True) so writes are impossible at
    the SQLite layer, not just by convention.

Usage:
    python3 generate.py                 # reads ~/.claude/memory.db, writes ./index.html
    python3 generate.py --db PATH       # override the database location
    python3 generate.py --out PATH      # override the output HTML path

Refresh the picture any time the memory changes by re-running this script.
"""

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

# Sibling modules (same directory): the shared embedding substrate + the suggester.
# Imported here so the generator can bake semantic link-suggestions into the page.
from entity_vectors import compute_entity_vectors
from suggester import compute_suggestions
from projection import project_3d

# Default location of the LIVE memory database. The copy inside the
# mcp-memory-server repo is stale dev data; the hook-driven server writes here.
DEFAULT_DB = os.path.expanduser("~/.claude/memory.db")

# The HTML template lives next to this script. We do simple marker replacement
# (not str.format / f-strings) because the template is full of literal { } from
# CSS and JS — token replacement avoids brace-escaping noise entirely.
TEMPLATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template.html")
# The 3D companion's template (optional — rendered to index-3d.html when present).
TEMPLATE_3D_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template-3d.html")

# A refined, slightly desaturated categorical palette tuned to a "star
# temperature" feel (warm golds through cool teals) — chosen to read as
# celestial rather than the generic neon-on-white AI palette. Assigned to
# projects in sorted order so colors stay stable across regenerations.
PALETTE = [
    "#e0a458",  # amber
    "#6fc2d0",  # cyan
    "#9ab87f",  # sage
    "#c98a9b",  # dusty rose
    "#8a92c9",  # periwinkle
    "#d8c47a",  # pale gold
    "#4f9a94",  # teal
    "#d98b6f",  # coral
    "#a89bc0",  # lavender-grey
    "#7fc4a8",  # mint
    "#6f86b3",  # slate blue
    "#b3946f",  # bronze
    "#c96f6f",  # soft red
    "#80b39a",  # eucalyptus
]
OTHER_COLOR = "#5a6172"  # muted slate for the "everything else" bucket / global


def normalize_relation(rel):
    """
    Collapse the inconsistent relation-type spellings into one display form.

    The database has accumulated variants from different sessions/agents:
    `contains_file` / `contains-file`, `belongs_to` / `belongs to` / `belongs-to`.
    For VIEWING we want those to be one edge type. We lowercase, turn any run of
    spaces/hyphens/underscores into a single underscore, and trim. The raw value
    is preserved separately so the detail panel can still show what was stored.

    Receives: rel (str) — the raw relation_type from the relations table.
    Returns: (str) the normalized display form, e.g. "belongs_to".
    """
    return re.sub(r"[\s\-_]+", "_", rel.strip().lower())


def load_graph(db_path):
    """
    Pull the active knowledge graph out of the SQLite store.

    "Active" everywhere means superseded_at='' AND tombstoned_at='' — the same
    filter the server's readGraph uses, so the picture matches what live queries
    see (history/superseded rows are intentionally excluded).

    Receives: db_path (str) — filesystem path to memory.db.
    Returns: a dict ready to be JSON-embedded into the page, containing:
      nodes, edges (cytoscape element data), plus meta/palette info for the UI.
    """
    # Open READ-ONLY via URI. immutable=1 would assume the file never changes;
    # we use mode=ro instead so a concurrent server write doesn't error us out.
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    active = "superseded_at='' AND tombstoned_at=''"

    # --- Entities (nodes) ---------------------------------------------------
    # Keyed by normalized_name because that is what relations reference (verified
    # empirically: 245/245 active relation endpoints match normalized_name, only
    # 6 coincidentally match the human-readable name). We also keep entity_id so
    # we can attach observations, which are stored by entity_id.
    cur.execute(f"""
        SELECT id, name, normalized_name, entity_type,
               COALESCE(project,'') AS project,
               updated_at, last_accessed_at
        FROM entities
        WHERE {active}
    """)
    id_to_key = {}      # entity_id -> normalized_name (for attaching observations)
    nodes = {}          # normalized_name -> node record
    project_counts = {}
    type_counts = {}
    for r in cur.fetchall():
        key = r["normalized_name"]
        id_to_key[r["id"]] = key
        project = r["project"] or ""          # '' means a global (cross-project) entity
        etype = r["entity_type"] or "unknown"
        nodes[key] = {
            "id": key,
            "name": r["name"],
            "type": etype,
            "project": project,
            "updated": r["updated_at"],
            "lastAccessed": r["last_accessed_at"],
            "degree": 0,                       # filled in once edges are counted
            "obs": [],                         # filled in below
        }
        project_counts[project] = project_counts.get(project, 0) + 1
        type_counts[etype] = type_counts.get(etype, 0) + 1

    # --- Observations (node payload) ----------------------------------------
    # Sorted by importance so the detail panel leads with the most significant
    # facts. memory_type / context_layer become badges in the UI.
    cur.execute(f"""
        SELECT entity_id, content, importance,
               COALESCE(memory_type,'') AS memory_type,
               COALESCE(context_layer,'') AS context_layer
        FROM observations
        WHERE {active}
        ORDER BY importance DESC, created_at ASC
    """)
    for r in cur.fetchall():
        key = id_to_key.get(r["entity_id"])
        if key is None:
            continue  # observation belongs to a superseded/tombstoned entity — skip
        nodes[key]["obs"].append({
            "content": r["content"],
            "importance": r["importance"],
            "memoryType": r["memory_type"],
            "contextLayer": r["context_layer"],
        })

    # --- Relations (edges) --------------------------------------------------
    # An edge is kept only if BOTH endpoints exist in the active node set. Edges
    # to a missing endpoint are counted and reported (never silently dropped) so
    # the viewer's "N edges" number is honest about what it omitted and why.
    cur.execute(f"""
        SELECT from_entity, to_entity, relation_type
        FROM relations
        WHERE {active}
    """)
    edges = []
    dropped = 0
    rel_counts = {}
    seen_edge_ids = set()
    for i, r in enumerate(cur.fetchall()):
        src, tgt = r["from_entity"], r["to_entity"]
        if src not in nodes or tgt not in nodes:
            dropped += 1
            continue
        rel_raw = r["relation_type"]
        rel = normalize_relation(rel_raw)
        # Cytoscape requires unique edge ids; multiple raw relations can collapse
        # to the same (src,tgt,rel) after normalization — suffix to stay unique.
        eid = f"e{i}"
        edges.append({
            "id": eid,
            "source": src,
            "target": tgt,
            "rel": rel,
            "relRaw": rel_raw,
        })
        seen_edge_ids.add(eid)
        nodes[src]["degree"] += 1
        nodes[tgt]["degree"] += 1
        rel_counts[rel] = rel_counts.get(rel, 0) + 1

    conn.close()

    # --- Semantic link suggestions ------------------------------------------
    # Entity-vectors (mean of each entity's MiniLM observation vectors) → the top-k
    # UNLINKED near pairs (the "what should I connect?" list). Degrades to [] with a
    # visible note if the DB has no embeddings, so the suggester can never break the
    # core graph render. `edges` already carries normalized_name source/target.
    try:
        vectors = compute_entity_vectors(db_path)
        suggestions = compute_suggestions(vectors, edges)
        coords3d = project_3d(vectors)
    except Exception as exc:
        print(f"  (suggester/projection skipped: {type(exc).__name__}: {exc})", file=sys.stderr)
        suggestions = []
        coords3d = {}

    # --- bge concept-aligned SHADOW representation (Phase 4) -----------------
    # The fine-tuned, concept-aligned entity vectors, computed offline by
    # concept_embeddings/bge_vectors.py (it needs the ML venv, so it can't run inline
    # here). We read its JSON cache and run the SAME suggester + 3D projection on it, so
    # the viewer can toggle MiniLM-vs-bge layouts/suggestions and SEE the difference
    # (the eval gate measured ~2.4x domain separation). Purely additive + read-only — the
    # live MiniLM vectors are untouched. Degrades to empty (MiniLM-only viewer) if the
    # cache is absent, so a missing shadow can never break the core render.
    suggestions_bge, coords3d_bge = [], {}
    bge_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "concept_embeddings", "data", "bge_vectors.json")
    try:
        if os.path.exists(bge_path):
            with open(bge_path, encoding="utf-8") as f:
                bge_vectors = json.load(f)
            suggestions_bge = compute_suggestions(bge_vectors, edges)
            coords3d_bge = project_3d(bge_vectors)
    except Exception as exc:
        print(f"  (bge shadow skipped: {type(exc).__name__}: {exc})", file=sys.stderr)
        suggestions_bge, coords3d_bge = [], {}

    # --- Colour assignment --------------------------------------------------
    # By project: stable colours assigned in sorted order. Global ('') gets the
    # neutral slate so cross-project rules read as "shared/background".
    projects_sorted = sorted([p for p in project_counts if p != ""])
    project_colors = {"": OTHER_COLOR}
    for idx, p in enumerate(projects_sorted):
        project_colors[p] = PALETTE[idx % len(PALETTE)]

    # By entity type: ~90 distinct types exist (mostly singletons from ad-hoc
    # session coinage), far too many for a legend. We give the most common types
    # distinct colours and lump the long tail into one "other" bucket.
    top_types = [t for t, _ in sorted(type_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:len(PALETTE)]]
    type_colors = {}
    for idx, t in enumerate(top_types):
        type_colors[t] = PALETTE[idx % len(PALETTE)]

    # Bake the per-node presentational fields (both colour modes + size) directly
    # into the node data NOW, so the data is complete before cytoscape applies any
    # style. Setting these client-side after construction makes cytoscape warn once
    # per node ("no mapping for property background-color with data field bg") and
    # flashes uncoloured nodes for a frame. node size uses sqrt(degree) so highly
    # connected hubs read like brighter stars without dwarfing everything.
    for n in nodes.values():
        n["bgProject"] = project_colors.get(n["project"], OTHER_COLOR)
        n["bgType"] = type_colors.get(n["type"], OTHER_COLOR)
        n["bg"] = n["bgProject"]  # initial colour mode is "by project"
        # Two size modes, both baked so the viewer toggle is a cheap data swap:
        #   szDegree    — by connection count (structural prominence)
        #   szKnowledge — by observation count (how much we KNOW about it).
        # The knowledge mode makes content-dense nodes (e.g. a user-profile entity with 100+ obs) the
        # big bright stars even when they have few edges. sqrt compresses the top
        # so the single largest node doesn't dwarf everything; both clamp to 58.
        n["szDegree"] = round(min(58.0, 13.0 + 7.0 * math.sqrt(n["degree"])), 2)
        n["szKnowledge"] = round(min(58.0, 13.0 + 5.0 * math.sqrt(len(n["obs"]))), 2)
        n["sz"] = n["szDegree"]  # default emphasis = connections

    meta = {
        "generatedAt": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M %Z"),
        "dbPath": db_path,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
        "droppedEdges": dropped,
        "obsCount": sum(len(n["obs"]) for n in nodes.values()),
    }

    return {
        "nodes": [{"data": n} for n in nodes.values()],
        "edges": [{"data": e} for e in edges],
        "meta": meta,
        "projectColors": project_colors,
        "typeColors": type_colors,
        "otherColor": OTHER_COLOR,
        "projects": projects_sorted,
        "topTypes": top_types,
        # Sorted relation legend for the detail/filter UI.
        "relCounts": dict(sorted(rel_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        # Semantic link suggestions: unlinked-but-near pairs [{source,target,score}].
        "suggestions": suggestions,
        # 3-d UMAP coordinates per entity (normalized_name -> [x,y,z]) for the companion.
        "coords3d": coords3d,
        # Phase 4 — the bge concept-aligned SHADOW: parallel suggestions + 3D coords the
        # viewer toggles against MiniLM. Empty when the offline shadow cache is absent.
        "suggestionsBge": suggestions_bge,
        "coords3dBge": coords3d_bge,
        "hasBge": bool(coords3d_bge),
    }


def main():
    ap = argparse.ArgumentParser(description="Generate a self-contained HTML view of the memory knowledge graph.")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"path to memory.db (default: {DEFAULT_DB})")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html"),
                    help="output HTML path (default: ./index.html)")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        sys.exit(f"ERROR: database not found at {args.db}")
    if not os.path.exists(TEMPLATE_PATH):
        sys.exit(f"ERROR: template not found at {TEMPLATE_PATH}")

    graph = load_graph(args.db)

    # Inject the data. json.dumps with ensure_ascii=False keeps prose readable;
    # we guard the only sequence that could break an inline <script>: a literal
    # "</script>" inside observation text is split so the HTML parser can't see
    # it (the payload only ever lands inside a <script>, where HTML comment
    # delimiters like --> are inert, so escaping "</" is the sole guard needed).
    payload = json.dumps(graph, ensure_ascii=False).replace("</", "<\\/")

    def render(template_path, out_path):
        # The placeholder MUST appear exactly once. str.replace() substitutes ALL
        # occurrences, so a stray token copy would inject the payload twice and
        # corrupt the document — fail loudly rather than emit broken HTML.
        with open(template_path, "r", encoding="utf-8") as f:
            template = f.read()
        marker = "/*__GRAPH_DATA__*/"
        count = template.count(marker)
        if count != 1:
            sys.exit(f"ERROR: expected the data marker exactly once in {template_path}, found {count}.")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(template.replace(marker, payload))

    # 2D viewer (always) + the 3D companion (when its template is present).
    render(TEMPLATE_PATH, args.out)
    out_3d = os.path.join(os.path.dirname(os.path.abspath(args.out)), "index-3d.html")
    if os.path.exists(TEMPLATE_3D_PATH):
        render(TEMPLATE_3D_PATH, out_3d)

    m = graph["meta"]
    print(f"Wrote {args.out}")
    if os.path.exists(TEMPLATE_3D_PATH):
        print(f"Wrote {out_3d}")
    print(f"  {m['nodeCount']} nodes, {m['edgeCount']} edges "
          f"({m['droppedEdges']} edges dropped: endpoint not in active set), "
          f"{m['obsCount']} observations")
    print(f"  {len(graph['suggestions'])} link suggestions")
    print(f"  Open it with:  xdg-open {args.out}")


if __name__ == "__main__":
    main()
