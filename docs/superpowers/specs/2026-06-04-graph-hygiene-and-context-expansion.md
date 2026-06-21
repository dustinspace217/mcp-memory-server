# Design Recommendations — Graph Hygiene (Orphan Prevention) + Bounded Session-Start Context Expansion

## Status (updated 2026-06-04 — BUILT)
Phase: implemented (Dustin gave the go; all three pieces wired + tested)
Done:
- **Bounded session-start expansion** → `load-l0-context.py` gained a `--connections` mode (isolated from the L0/L1 chunk path): emits the 1-hop relation-neighbours of the L0/L1 anchor entities, ranked by anchor-link count then importance, capped at 20 neighbours / ~8800 chars. Registered as a new SessionStart entry in `settings.json`. Tested global + project cwd, resume-silent, L0/L1 path regression-clean. Hook backup: `~/.claude/hooks/load-l0-context.py.bak-20260604`. **Activates next session.**
- **Enforcement-locus rule** (prevent-at-source) → new "Structural edges" section in `reference_memory_write_policy.md` (deterministic trigger: entity has a project OR hub-matching name-prefix → draw the part_of/contains edge in the same save, or note why not; propose-then-judge, never link-for-completeness).
- **Structural orphan-suggester** → "Pass E: Orphan linking" added to `~/.claude/prompts/memory-consolidation.md` (the weekly agent now sweeps orphans using name/project/type signals, same conservative discipline; it is the backstop the write-policy rule names).
Next: observe whether the connected-context block reads as useful vs noisy in real sessions; tune neighbour cap / budget if needed. The bigger bet (automatic capture+compression) remains queued.
Blocked: nothing.

---

## Origin

Captured 2026-06-03/04 during a manual knowledge-graph densification session driven by the new `memory-graph-viz` viewer. Over the session the active relation count went **246 → 322 edges** (+~76 relations, +4 entities): Dustin's homelab was modeled as entities, the about-him / project clusters were wired, the memory-server schema entities were corrected to their real projects, the `local-llm-test-pool-crash` incident's causality was graphed, and every loose `dustin-space` artifact was pulled in. Two systemic questions fell out of that work; this doc records the design thinking so a future session doesn't re-derive it.

Related: `memory-graph-viz` (MCP entity + `~/.claude/projects/-home-dustin-Claude/memory/project_memory_graph_viz.md`), the orphan-prevention procedure observation on the `mcp-memory-server` entity (2026-06-04), and the tabled **semantic nearest-neighbor suggestion layer** (see Part 1, "composes with").

---

## Part 1 — Orphan prevention

### Problem & root cause
Entities accumulate as **orphans** (degree 0) by default. Diagnosed root cause: routine saves run `create_entities` / `add_observations`, but `create_relations` is a **separate, easily-skipped step**. The SessionEnd / checkpoint hooks (and in-session saves) bank *content* and drop *structure*. Orphans are not random — they are the predictable residue of **save-without-link**.

### The four detectable signals (rising order of cleverness)
1. **Name prefix = parent.** `dustin-space-*`, `fedora-*`, `mele-*`, `qhy*`, `bainbridge-*` literally encode their hub. Most of this session's placements were recoverable from the prefix alone.
2. **`project` field set, but no edge to the project-hub entity.** Many orphans had `project=dustin-space` and zero link to the `dustin-space` entity — the scalar attribute knew where they belonged; nobody drew the edge.
3. **Entity type implies containment.** `SourceFile`, `ConfigFile`, `FileGroup`, `FileInventory`, `ProcedureLibrary`, `PlannedFeature`, `ContentRevision` don't stand alone — one with no `part_of`/`contains` edge is an orphan-by-omission almost by definition.
4. **Incident / bug / issue entities lack their causal + locus edges** (the crash incident had neither `occurred_on` nor `CAUSED_BY` until this session).

### The key reframe (do not skip this)
The instinct is to debate **rigid wording vs. flexible wording** for a "draw the relationship" rule. That is the wrong axis. Dustin's proposed softer phrasing — *"when storing entities and observations meaningfully connected to existing data, draw the relationship"* — is **almost exactly the existing CLAUDE.md write-policy** ("graph the why / create relations as you record"), and that policy is what produced the ~76 orphans. It did not fail from ambiguity; it failed because **discretionary "also link" steps get dropped under context/time pressure regardless of wording.** Softening toward judgment leans harder on the faculty that already proved unreliable.

The real axis is **discipline-reliant vs. mechanically-enforced.**

### Recommendation — split it
- **(A) Mechanical backstop** that does NOT depend on in-the-moment discipline: a post-save check (a hook, or the weekly consolidation agent) that flags any entity with a `project` set, or a name-prefix matching an existing hub, that has no edge to that hub → "unlinked, link it?" Catches the bulk of signals 1–3 mechanically.
- **(B) Deterministic-trigger judgment rule** (Dustin's phrasing, fixed so it fires reliably): *"When you create an entity that has a project set, OR whose name shares a prefix with an existing entity, you MUST either draw the `part_of`/`contains` edge in the same save or state why not."* Deterministic **trigger** (project set / prefix match), judgment **action** (link or justify). This is the middle ground — not link-by-rote, not link-when-it-feels-meaningful.

**Both stay propose-then-approve, never blind automation.** Counter-example that proves the need: `fedora-nas-backup` legitimately relates to **both** `Fedora` and `vaultinspace-nas`; a name prefix picks only one.

**Composition:** this structural approach pairs with the tabled **semantic nearest-neighbor suggester**. Structural signals (name / project / type) catch the *obvious* orphans cheaply and at high precision with no embeddings. Semantic cosine-NN over entity-aggregated observation vectors catches the *non-obvious, cross-cluster* links that no prefix would reveal. Two complementary layers; ship the cheap structural one first.

---

## Part 2 — Bounded session-start context expansion

### Verified current behavior (2026-06-04, read from source — not assumed)
- `~/.claude/hooks/load-l0-context.py` makes **no** relation/traversal calls.
- `SqliteStore.getContextLayers` (`sqlite-store.ts`) filters observations by **tier (L0/L1) + importance + token budget only** — its body references no relations and performs no edge-following.
- Relations are traversed **only** when `get_connected_context` is invoked deliberately, mid-session.

**Conclusion:** loading an L0 entity does **not** pull its connected context out of L1/L2 today. That association is invisible at session start.

### The idea (Dustin's) and why it matters
On session start, expand from the L0 anchors **along relation edges** to pull a bounded amount of associated context, even if it lives in L1/L2.

This is the **missing piece that converts the relation graph into auto-recall.** Today the edges don't feed the auto-loaded context, so any recall benefit from them is *conditional on Claude choosing to traverse*. Bounded session-start expansion is what would make the structure we keep adding *automatically* improve what a fresh session wakes up knowing. (It directly answers the unmeasured-recall caveat recorded on `claude-self`, 2026-06-04.)

### Hard constraint — it MUST be bounded
The recent densification makes bounding **more** critical, not less. `dustin-space` is degree ~53, `Fedora` ~12; a naive "load N hops from every L0 anchor" explodes (the supernode problem, applied to loading — two hops reaches most of the graph). Required design:
- **1 hop only** from L0 anchors;
- **top-K neighbors, ranked by importance** (not all neighbors);
- under a **hard token budget**, **project-scoped**;
- load each neighbor's **name + single headline observation**, not its full observation set.

Result: "here is the L0 fact, and the most important things it connects to" — without dumping the graph.

### Implementation locus
A code change to `mcp-memory-server` — either `getContextLayers` (add an optional bounded-expansion mode) or the SessionStart hook. A real build with its own plan + QA pass, not a config tweak. **Prioritize this** once the orphan-prevention backstop exists, because it is what turns accumulated structure into recall Dustin actually feels.

---

## Open decisions for Dustin (not yet settled)
1. **Enforcement mechanism for Part 1**: post-save hook vs. consolidation-agent sweep vs. write-policy rule with deterministic trigger (or some combination). Leaning: lightweight rule (B) now + mechanical backstop (A) as the durable fix.
2. **Expansion parameters for Part 2**: K (neighbors per anchor), token budget, 1-hop vs. selective 2-hop, and whether to scope strictly to the current project.
3. **Sequencing**: structural orphan-suggester → prevention rule → bounded expansion → (later) semantic NN suggester.
