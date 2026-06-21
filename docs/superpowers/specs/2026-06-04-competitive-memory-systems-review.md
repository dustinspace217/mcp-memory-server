# Competitive Review — `agentmemory` & `claude-mem` vs. our Memory MCP Server

## Status (written 2026-06-04, overnight async task)
Phase: research complete; recommendations are proposals awaiting Dustin's read
Done: both systems researched from primary source (repos cloned/read), mapped against our goals A/B/C + the 5 usability pillars + current roadmap
Next: Dustin reads, picks which recommendations (if any) to turn into plans
Source reports: saved in MCP under entities `agentmemory-competitor` (+ agent-1 report) and this session's agent-2 report; raw detail beyond this summary lives there

---

## TL;DR (read this first)

1. **The embedding choice is validated.** *Both* competitors use the **exact model we do** — `all-MiniLM-L6-v2`, 384-dim. agentmemory runs it in-process; claude-mem outsources it to a Chroma subprocess. We are not behind on the model.
2. **The one clear gap both confirm: automatic capture + LLM compression.** Both auto-capture every tool call via lifecycle hooks and use an LLM to *compress raw session activity into structured observations*, with **zero manual save calls**. We capture largely by hand / hook-prompt — which is the exact root cause of the orphan problem and the "memory misses things" gap. **This is the #1 takeaway.**
3. **Our knowledge graph is a real differentiator.** claude-mem has **no relations/edges/graph at all** (flat `facts[]`/`concepts[]` JSON). agentmemory has a graph but as a secondary retrieval stream. Our typed-relations + bounded multi-hop traversal (`get_connected_context`) + the temporal model (`supersede`/`as_of`/`entity_timeline`) + importance/contextLayer tiers + eviction are things **neither fully matches** — keep and lead with these when selling colleagues.
4. **Several of their best ideas are things we already planned but haven't built** — decay (our Phase 6), retrieval-strengthening (our Pillar 2), FTS5 keyword search (our issue #30). The competitors are concrete reference implementations for our own backlog, not net-new directions.

---

## At a glance

| Dimension | **Ours** | **agentmemory** (rohitg00) | **claude-mem** (thedotmack) |
|---|---|---|---|
| Repo / traction | private | 21k★, Apache-2.0, ~3mo old, TS | 80k★, Apache-2.0, ~9mo, TS/Bun |
| Store | SQLite + sqlite-vec | JSON-on-disk + in-memory cosine | SQLite + FTS5 **+** Chroma; Postgres option |
| Embedding | MiniLM-L6 384 (in-proc) | MiniLM-L6 384 (in-proc) | MiniLM-L6 384 (via Chroma MCP) |
| Capture | **manual / hook-prompted** | **auto** (12 lifecycle hooks) | **auto** (lifecycle hooks) |
| Compression | manual + weekly `claude -p` agent | LLM consolidation (working→episodic→semantic→procedural) | **LLM-as-compressor** (Claude SDK sub-agent per session) |
| Retrieval | vector + graph + weak LIKE | **BM25 + vector + graph, RRF-fused + rerank** | FTS5 + Chroma, filter-then-rerank |
| Knowledge graph | **typed relations + multi-hop traversal** | secondary graph stream (Dijkstra) | **none** (flat JSON arrays) |
| Temporal | supersede / as_of / entity_timeline | **bitemporal edges** (valid-time + rationale) | created_at ordering only |
| Tiers / decay | L0/L1 + importance + eviction | **Ebbinghaus decay + retention + auto-forget** | none (recency window) |
| Forgetting | LRU-shielded eviction | decay curve + contradiction-forget | — |
| Provenance | entity_timeline | **`verify` citation chain** | `memory_sources` citations |
| UI | `memory-graph-viz` (ours, new) | shipped viewer + OTEL | shipped web viewer + SSE |

---

## System 1 — `agentmemory` (github.com/rohitg00/agentmemory)

**What it is:** a persistent-memory layer for coding agents that auto-captures sessions, runs a full *cognitive* memory model, and recalls via triple-stream hybrid search. Single local Node process, no external DB (JSON on disk). 21k★, Apache-2.0, very high velocity, solo maintainer.

**Standout ideas (the cognitive model is the story):**
- **Explicit memory tiers** — `working | episodic | semantic | procedural`, with **automatic LLM consolidation** rolling episodic session summaries up into deduplicated semantic facts and recurring patterns into procedural step-lists.
- **MemGPT-style working memory** — token-budgeted Core (pinned, scored) vs. Archival (paged out, fetched on demand); auto-pages out low-scored entries.
- **Decay/forgetting as first-class** — Ebbinghaus curve (`salience·e^(−λΔt)`), spacing-effect reinforcement, contradiction-driven forgetting, TTL/low-value pruning.
- **Reflection** — periodic higher-order insight synthesis from concept clusters, with confidence that strengthens on reinforcement and decays when stale.
- **Bitemporal knowledge graph** — every edge carries transaction-time + valid-time **and an `EdgeContext` (reasoning, alternatives considered)**, never overwritten → point-in-time + "what changed between t1/t2" queries.
- **Triple-stream retrieval** — BM25 (lexical) + vector + graph(Dijkstra), fused with **Reciprocal Rank Fusion**, optional cross-encoder rerank, query expansion.
- **`verify`** — traces any memory back to its source observations/sessions (provenance/anti-hallucination).
- Plus: crystallize (action-chain digests), editable memory slots, self-diagnostics + a "followup-rate" recall-quality metric, multi-agent orchestration, CLIP image search. *(Headline benchmark numbers are self-reported — unverified.)*

## System 2 — `claude-mem` (github.com/thedotmack/claude-mem)

**What it is:** an open-source persistent-memory **plugin for Claude Code** (and Gemini/OpenCode/Codex). Hooks the session lifecycle, uses a **Claude Agent SDK sub-agent to compress raw tool activity into structured observations + summaries**, stores them in SQLite+FTS5 + Chroma, and auto-injects relevant past context. A session-compression + RAG system, **not** a knowledge graph. 80k★ (corrected from a stale 46k search figure), Apache-2.0, single maintainer, Bun runtime.

**Standout ideas:**
- **LLM-as-compressor** — a separate Claude SDK session turns raw transcripts into typed observations with `facts[]`/`concepts[]`/file-touch lists. Semantic distillation, not raw logging. *Their core differentiator.*
- **Action-triggered injection** — context injected at **`UserPromptSubmit` (per-prompt semantic)** and **`PreToolUse:Read` (memory about a file right before it's read)**, not only at session start.
- **Field-level embeddings** — each observation explodes into multiple Chroma docs (one per `fact`), for sharper semantic hits than our one-vector-per-observation.
- **Progressive-disclosure 3-tool search** — `search` (compact, ~50-100 tok) → `timeline` → `get_observations` (full detail only for chosen IDs); ~10× token savings claim.
- **`observation_feedback` table** — usage/feedback signal per observation (substrate for retrieval-strengthening).
- **Content-hash dedup** (SHA256 over session+title+narrative, 30s window) at write time.
- **`memory_sources` provenance** + cite-by-ID API; real-time web viewer + SSE.
- **KnowledgeAgent "prime-then-resume"** — loads the whole rendered corpus into a Claude SDK session and answers by *resuming* that primed session (the model's own context window as a cache).
- Plus: multi-tenant teams/RBAC/API-keys/Postgres, multi-IDE portability, pluggable summarizer LLMs, "Endless Mode" biomimetic memory *(unverified — beta docs 404'd)*.

---

## Features we lack — grouped by what to do, with goal mapping

Axes: ①more capable ②more useful memories ③more human-like. Goals: A reduce drift · B faithful recall · C conversation+code quality.

### ADOPT — fills a real gap, serves the goals, fits anti-bloat
- **Automatic capture + LLM compression of session activity → classified observations** (both systems). ②③ / B,C. *The biggest gap.* Attacks our manual-save / orphan root cause directly. **Implementation path that fits us:** a Claude compressor (`claude -p` / Agent-SDK) at capture points (Stop / SessionEnd) distills the session *slice* into classified, **auto-parent-linked** observations. This aligns with Phase 7's capture-as-core + the existing weekly consolidation agent — and crucially is **not** a local-LLM (which the overhaul plan explicitly rejected). Pairs with the orphan-prevention design: auto-compression is also where the auto-linking should happen.
- **Decay / forgetting curve + verification-refresh** (agentmemory). ③ / A. *This is our Phase 6 (Confidence Decay), still TODO.* agentmemory is a concrete reference: `salience·e^(−λt)` + spacing reinforcement + contradiction-forget. Adopt its model when we build Phase 6.
- **FTS5 keyword stream + fusion** (both). ① / B. We have weak LIKE (ASCII-only, unranked). *This is our backlog issue #30.* Upgrade LIKE→FTS5 and fuse with vector (RRF or constrained rerank). Bounded, high-value, validated by both competitors.
- **Provenance / `verify` (source pointers + citation)** (both). ① / A. We have `entity_timeline` but no "trace this claim to its source." Strong anti-hallucination fit, and it **directly strengthens the Phase 7 audit** (which already cites-the-source). At minimum, stamp auto-compressed observations with their source session/turn.
- **Retrieval-strengthening via a usage signal** (claude-mem `observation_feedback`; agentmemory access-log). ③ / B,C. *This is our Pillar 2, unbuilt.* Track which observations actually get retrieved/used, feed it into importance over time. The overhaul plan already names the consolidation agent as the intended mechanism — so this is "wire up the signal," not new architecture.

### ADAPT — good idea, but our architecture/anti-bloat changes the form
- **Relation `rationale` + valid-time** (agentmemory's `EdgeContext`). ①③ / A,B. We just hit this tonight — relations can't carry *why*/*when-true* (the verbose `drove tech decisions for via stated criteria` verb was a workaround). Extends the 2026-06-02 causal-relations work with a `rationale`/`valid_time` field on edges. Medium.
- **Reflection / insight synthesis** (agentmemory). ②③ / C. High-judgment → belongs in the **weekly Claude consolidation agent**, not a server hot-path (consistent with our local-LLM rejection). Flag the anti-bloat risk: insight-generation can manufacture noise; gate hard.
- **Working/core-vs-archival paging** (agentmemory MemGPT model). ③ / C. Our L0/L1 tiers + the Phase-7 continuity thread + the **bounded session-start expansion** (tonight's design doc) are our equivalent and arguably cleaner. Don't adopt wholesale; prioritize the bounded-expansion design instead.
- **Field-level (per-fact) embeddings** (claude-mem). ① / B. Minor retrieval sharpening; our observations are already fairly atomic. Low priority.
- **Action-triggered injection (pre-Read / per-prompt)** (claude-mem). ① / C. A hook pattern (PreToolUse:Read → query → inject). Interesting, but adds per-call latency and our memory is more decision/architecture- than file-oriented. Low priority; note as a future hook idea.

### SKIP — out of scope / anti-bloat / not single-user
- Multi-tenant **teams / RBAC / API keys / Postgres** (claude-mem) — single-user; skip.
- **Multi-IDE portability** (Gemini/OpenCode/Codex) — we're Claude-Code-specific; skip.
- **Heavy web UI** — we just built `memory-graph-viz`, which covers inspection; skip claude-mem's UI.
- **Multi-agent orchestration / CLIP vision / Obsidian export** (agentmemory) — out of scope.
- **KnowledgeAgent corpus-priming, crystallize, "Endless Mode"** — interesting but heavy and/or unverified; don't chase.

---

## Recommended priority order (grounded in goals + existing roadmap)

1. **Automatic capture + compression with auto-linking** — the highest-leverage gap; fixes manual-save/orphans (A/B/C). Build as a Claude compressor at capture points; merge with the orphan-prevention design (`2026-06-04-graph-hygiene-and-context-expansion.md`).
2. **FTS5 + fusion** (issue #30) — small, bounded, both competitors validate it; immediate recall quality (B).
3. **Bounded session-start expansion** (already designed tonight) — converts our graph edges into auto-recall; the thing that makes our differentiator actually pay off.
4. **Phase 6 decay** — now has a concrete reference implementation (A); was already conditional/TODO.
5. **Provenance/source stamping + a `verify` capability** — anti-hallucination (A) + strengthens the Phase 7 audit.
6. **Retrieval-strengthening usage signal → importance** (Pillar 2) — via the consolidation agent.
7. **Relation rationale + valid-time** — extends causal-relations (A/B).

---

## How we already stack up (positioning for colleagues)

When a colleague points at these, the honest pitch is: **ours is a curated knowledge-graph memory; theirs are auto-compressed session-RAG systems.** Different shapes, different strengths.
- **We have, claude-mem lacks entirely:** typed relations + multi-hop graph traversal, importance/contextLayer tiers, eviction, supersede/as_of/entity_timeline temporal model, `find_precedents`.
- **We have, agentmemory partly matches:** the graph (theirs is secondary), temporal queries (theirs is on edges, ours on observations), tiered context loading.
- **They have, we lack:** automatic capture/compression (both), decay (agentmemory), a real lexical stream (both), provenance verify (both). Items 1–7 above close most of that.
- **The convergence that helps the pitch:** two independent, popular projects (101k★ combined) chose the *same embedding model we did* and the *same lifecycle-hook capture philosophy* — we're on the mainstream path, with a graph layer most of them don't have.

---

## Caveats / what the agents could not verify
- agentmemory's headline benchmark numbers (95.2% R@5, comparison table vs Mem0/Letta/Cognee) are **self-reported marketing**; the retrieval code was read but the eval was not run.
- claude-mem's **"Endless Mode" biomimetic memory** (its only claimed decay/consolidation-for-long-sessions feature) could not be verified — beta docs 404'd, implementation not located. Treat as claimed, not confirmed.
- The claude-mem agent reviewed via GitHub raw/API (primary source) rather than a local clone (Bash was unavailable in its sandbox); not every file was read.
- Star counts and "first/biggest" framing are popularity, not quality signals — weight the *ideas*, not the ★.
