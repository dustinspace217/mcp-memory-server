# Memory Graph Visualizer

A self-contained visual explorer for the MCP memory-server knowledge graph —
entities as nodes, relations as directed edges, observations in a detail panel.
Screenshots are in the [main README](../README.md).

> **Privacy note:** the generated `index.html` / `index-3d.html` embed the FULL
> CONTENT of your memory database directly in the page (that's what makes them
> work offline over `file://`). Treat generated snapshots as private files —
> this directory's `.gitignore` keeps them out of the repo, and you should never
> publish one.

## Requirements

Python 3.10+. The 2D graph needs only the standard library. The 3D semantic
layout additionally wants `numpy` and `umap-learn` (`pip install numpy umap-learn`);
without `umap-learn` it falls back to a PCA projection with a visible note.

## What it is

The memory server stores everything in SQLite (`~/.claude/memory.db`) across three
tables — `entities` (nodes), `relations` (edges), `observations` (the facts on each
node). Opening that DB in a SQLite tool only shows rows. This tool renders the
**graph** as an interactive node-link diagram you open in a browser.

## How to use

```sh
python3 generate.py          # reads ~/.claude/memory.db, writes index.html
xdg-open index.html          # open it in a browser
```

Re-run `generate.py` any time the memory changes to refresh the picture.

Options:
- `--db PATH`  — point at a different database (default `~/.claude/memory.db`)
- `--out PATH` — write the HTML somewhere else (default `./index.html`)

## In the viewer

- **Click** a body → inspect it: its observations (with importance + type) and its
  in/out relations. Click a relation row to jump to that neighbour.
- **Hover** → preview a node's neighbourhood.
- **Find entity** → search by name; matches light up.
- **Project** filter → show one project (plus its directly-connected global nodes),
  or the global layer alone.
- **Colour by** → project (default) or entity type.
- **Show relation labels** → put the relation verb on each edge.
- **Show all entity labels** → persistent labels on every node (off by default to
  keep the overview legible; spread nodes out and the labels fit). Hovering still
  highlights a node's relations on top of this.
- Node size ∝ connection count (hubs read like brighter stars).

## Staging new links (link mode)

The graph is read-only against the database, but you can *propose* new relations
without leaving the viewer:

1. Tick **link mode — stage relations** in the control panel.
2. Click a **source** body, then a **target** body (swap with ⇅ if you got the
   direction backwards — direction matters for causal verbs).
3. Pick a relation type. The causal verbs (`CAUSED_BY`, `PRECEDENT_FOR`,
   `SUPERSEDES`) show their from→to direction; you can also reuse a type already
   in the graph, or type a custom one. **Add link** stages it as a dashed edge.
4. When done, **Copy JSON** (or **Download** — used automatically if the clipboard
   is blocked on `file://`).
5. Hand the JSON to Claude. It's the exact input shape of the memory server's
   `create_relations` tool, so Claude commits the whole batch in one call.

The viewer **never writes to the database** — it's a capture surface. Staged links
are **not** saved across a page reload, so export before closing the tab.

Example exported payload:

```json
[
  { "from": "my-project", "to": "login-manager-lesson", "relationType": "CAUSED_BY" }
]
```

## Design notes (why it's built this way)

- **Generator + baked snapshot, not a live app.** The graph is small (~300 nodes),
  so a static HTML file with the data embedded needs no running server, has no
  memory-leak surface, and is refreshed by re-running one script. (Opening via
  `file://` can't `fetch()` a sibling JSON, so the data is embedded directly.)
- **Read-only DB access** (`mode=ro` URI) — a viewer must never be able to corrupt
  what it views.
- **Display-only normalization.** Inconsistent relation spellings in the data
  (`belongs to` / `belongs-to` / `belongs_to`) are unified *in the view only*; the
  database is untouched.
- **Vendored** `cytoscape.js` (`vendor/`) + its built-in `cose` layout — no build
  step, no framework, works offline. Fonts load from Google Fonts but degrade
  gracefully to system serif/mono when offline.

## Files

- `generate.py`        — reads the DB, emits `index.html` + `index-3d.html`
- `entity_vectors.py`  — per-entity embedding vectors from the server's sqlite-vec shadow tables (stdlib only)
- `suggester.py`       — semantic link suggestions (nearest unlinked neighbours)
- `projection.py`      — 384-d → 3-d UMAP projection (PCA fallback) for the 3D view
- `template.html`      — the 2D viewer (edit this, not the generated `index.html`)
- `template-3d.html`   — the 3D semantic-space viewer
- `verify_*.py`        — manual sanity checks for vectors / neighbours / projection / suggester
- `vendor/`            — vendored cytoscape.js (2D) and 3d-force-graph (3D), both MIT
- `index.html`, `index-3d.html` — **generated** output; gitignored, do not hand-edit, do not publish

An optional `concept_embeddings/` workspace (not part of the repo) can supply a
fine-tuned comparison model's vectors as `concept_embeddings/data/bge_vectors.json`;
when absent the viewer simply renders without the comparison toggle.
