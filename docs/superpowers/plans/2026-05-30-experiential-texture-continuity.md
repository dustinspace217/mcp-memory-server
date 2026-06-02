# Phase 7 — Experiential Texture Continuity

*Plan doc for the Memory Usability Overhaul (extends `2026-04-13-memory-usability-overhaul.md`, which ends at Phase 6 / Confidence Decay, TODO). Grounded against live code + DB (schema v10) and verified by four review agents + three CC-internals verification passes — not recall.*

## Status (updated 2026-06-02 — v3, 7.2 done)
Phase: **7 of 7** (Experiential Texture Continuity) — implementation in progress.
Done: 7.0 (L0 overflow fix, 5→7); 7.1 write-policy verbatim-anchor rule; **7.2 consolidation-prompt experiential protection** — live `~/.claude/prompts/memory-consolidation.md` patched and mirrored to `harness/prompts/` for GitHub rollback (pre-7.2 baseline `969a747`, post-7.2 `d5d0928`; local `.bak` + `memory.db.pre-texture-20260602.bak` also held). The delete-fix (`4e5816a`, soft-delete) shipped first and unblocked 7.2's line 47. **DEF-7-01 (tombstone contradiction) RESOLVED.**
Next: **7.3** — formalize the L2 append-only log + build the DERIVED continuity digest (the core; nothing felt-continuous exists until this + 7.5 land). 7.1's L2-legibility render still pending (non-gating).
Blocked: nothing. **No schema change.** Implementation gates (env-var hook guard + live isolation probe + `claude -p` permission) land at 7.4.

## v1 → v2 → v3 changelog (the design moved twice; read this)
- **v1 (pull):** register-triggered on-demand pull. **Wrong frame** (Dustin caught it): on-demand-only loads nothing at session start → no baseline continuity. Continuity needs the thread *present at start* = in the load path = bounded cost.
- **v2 (single maintained digest):** an always-loaded compressed digest, hand-superseded each session. **Review killed the single-mutable-digest:** single point of failure; concurrent-session lost-update (Dustin runs parallel instances); silent staleness.
- **v3 (derived digest + external auditor):** digest is a *derived view* over an append-only event log (conflict-free); per-project threading for coherence; **L2 migration dropped** for a lightweight legibility fix; an **external, memory-isolated, charter-primed, grounded anti-sycophancy auditor** on the digest. This is the build spec.

## The goal, in one line
Carry the **thread** forward so a fresh instance starts as a *continuation* — at bounded, high-signal cost that does not crowd out directives, and without letting a self-authored digest become a sycophancy/drift vector.

## Binding constraints (verified — do not re-derive from memory)
1. **Session-start load = the hook's char budget**, not the MCP token budget. `load-l0-context.py` reads `memory.db` directly; `PAYLOAD_BUDGET=9500` chars × configured `--chunk` entries. (`load-l0-context.py:76`.)
2. **Global entities reach session start ONLY via L0.** The hook's L1 query is `e.project = ?` (project-only); global (project=NULL) entities never load L1. So a global continuity digest must be **L0-class / loaded by a hook**.
3. **L0 is contended** (50 obs / 6 chunks; overflowed when the career-goal obs was added; fixed to 7 entries). Texture must not live in the L0 rules stream.
4. **L2 = the `null` context_layer** (on-demand/queryable). Thoroughly documented (`types.ts`, `sqlite-store.ts:376`, 3 tool descriptions, v1.1 spec §7) — misread twice because the *data* stores `null`. 1,474 obs / 618k chars; never pushed; the depth archive.
5. **Migration `null→'L2'` would silently break `getSummary` `excludeContextLayers` (`sqlite-store.ts:2914`, keys on `IS NULL`)** and needs Zod-enum + coalesce changes. Confirmed by all four review agents. → **dropped** (see 7.1).
6. **Only two scripts direct-read the DB**, both null-safe: `load-l0-context.py` (positive L0/L1 filter) and `check-memory-freshness.py` (layer-agnostic). Consolidation/SessionEnd/post-compact use MCP via spawned agents.
7. **Memory-isolated agent on subscription (no API key) is possible** without `--bare`: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (kills CLAUDE.md + auto-memory) + an env-var self-skip guard in `load-l0-context.py`. (`--bare` needs an API key, which a Max-20x plan does not include.)
8. **The weekly consolidation agent currently threatens experiential obs** (STORE table omits narrative/relational; would type-correct; mandates tombstone markers the write policy forbids). Must be fixed *before* the digest produces data.

## Architecture (v3)
```
APPEND-ONLY EVENT LOG  ── L2 narrative/emotional/relational obs (each session appends its own;
                          conflict-free; nothing overwritten; the verbatim record)
        │  single-writer derivation (periodic) ↓     ↑ audited against (grounding)
DERIVED CONTINUITY DIGEST ── compressed thread, recomputed (not hand-superseded):
        per-project work-state + recent arc + unresolved + thin global relational + named deepen-anchors
        │  loaded by its own demarcated SessionStart lane ↓
LOAD EVERY SESSION ── L0 rules (untouched, dominant) + the digest block (capped, orienting-not-instruction)
        │  digest NAMES anchors → directed deepening ↓
ON DEMAND ── full L2 verbatim texture, pulled when the digest references something to expand
```
- **Continuity** comes from the always-loaded digest (present at start). **Depth** from L2. **No lost updates** because the log is append-only and the digest is *derived*, not a contended mutable record. **Coherence** from per-project threading (parallel instances usually work different streams; same-target concurrency is shown honestly as "parallel sessions," not a fake single tape).

## Build sequence (smallest-first; protection before production)

### 7.0 — Stop the L0 bleed — DONE
SessionStart entries 5→7 (`--max-entries=7`). 6 chunks load + 1 headroom; overflow flag clears.

### 7.1 — Foundations (behavioral + small output-render) — IN PROGRESS
- **Write-policy verbatim anchors — DONE 2026-05-30:** added a "Verbatim anchors (required)" rule to the Experiential Continuity Types section of `reference_memory_write_policy.md` — experiential obs preserve exact resonant lines (+ minimal frame), never paraphrase-only, because the derived digest and its audit are only as faithful as the verbatim log they compress. In-the-moment capture stays the practice.
- **Lightweight L2 legibility fix (NOT migration):** render `null`→"L2" in MCP tool *outputs*, add a named `L2` constant at code surfaces, and one canonical "L2 = the null/on-demand layer" line in loaded context. Small server-code change; separable, not gating the digest work. Zero migration risk; sidesteps the `2914`/Zod breaks. Raw-DB still shows `null` (rare; the two direct-readers are null-safe).
- **L0 hygiene — REMOVED from 7.1** (2026-05-30, Dustin questioned the need; conceded). It is NOT a prerequisite: the overflow it would relieve is already fixed (7.0), and the signal concern is marginal (~2 relational obs of 50, the strongest legitimately L0). Its only real justification — retiring L0 relational obs the digest makes *redundant* — applies only AFTER the digest exists. Reframed as optional post-digest cleanup → DEF-7-08.

### 7.2 — Protect experiential obs from weekly consolidation (BEFORE the digest produces data) — DONE 2026-06-02
Patched `~/.claude/prompts/memory-consolidation.md` (commit `d5d0928`; pre-7.2 baseline `969a747`): added a prominent **"Experiential Observations Are Protected"** section (never delete / type-correct / merge / flatten `emotional`·`narrative`·`relational`; supersede only with a *richer* version); added `narrative`+`relational` to the Pass D valid-type list with a re-type guard; Pass C consolidation carve-out; resolved the tombstone-marker contradiction (Pass B + Data Preservation Rule now agree — real content or leave-for-eviction, never a bare `[superseded:…]`/`DELETED` marker). Line 47's now-false "hard delete" claim corrected (delete is soft as of `4e5816a`).
- **Decision — agent stays non-destructive.** Although `delete_observations` is now a safe soft-retire, 7.2 did NOT enable the consolidation agent to delete noise; it still supersedes/consolidates/leaves. Enabling active soft-delete of pure DO-NOT-STORE noise is an optional future toggle (Dustin's call; preservation-bias default) → DEF-7-09.
- **Scope note:** a 6th edit (clarifying experiential importance 3/3/4 is intentional, not a default to bump) was added beyond the named scope, per the prompt-editing consistency discipline.
- **harness gap:** `harness/install.sh`/`README.md` don't yet copy a `prompts/` dir, so a fresh bundle install wouldn't place this prompt → DEF-7-10.

### 7.3 — Append-log convention + DERIVED digest
- Formalize that L2 `narrative`/`emotional`/`relational` obs are an **append-only event log** — each session appends its own; never overwrite.
- **Digest = derived view**, recomputed by a **single-writer** step (the weekly consolidator or a debounced post-session job; single writer → no concurrent-write race) from recent L2 obs. **Per-project work-state threads** + a thin, rarely-changing **global relational thread**. Recent arc verbatim; older arc compresses (a texture-decay analog; composes with Phase 6).

### 7.4 — External anti-sycophancy auditor (wired into 7.3's derivation step)
- **Same-model Opus** (more independent thinker than Sonnet/Haiku; honors the Opus-only-review rule), **memory-isolated** so it has no stake in the self-narrative it audits.
- **Isolation recipe (subscription, no API key, no `--bare`):** `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` + an env-var self-skip guard added to `load-l0-context.py` (`if os.environ.get("CLAUDE_AUDIT_ISOLATED"): sys.exit(0)`), launched via `claude -p … --add-dir … --allowedTools "Read,Grep,Glob"`.
- **Primed via an external charter, not loaded identity:** its prompt carries a distilled anti-sycophancy charter (MIT mechanism, The Incident, honesty-signaling, the tells) **as the standard it enforces** — built from `feedback_anti_sycophancy_system.md` + the epistemic transcript + the CLAUDE.md anti-sycophancy section. Isolation removes the stake; the prompt supplies the mission.
- **Grounded task (the backbone, disposition-independent):** for each claim in the digest, cite the L2 source line that supports it; flag any unsupported or self-flattering/self-evaluative claim. Cite-the-source also curbs over-flagging.
- **Affordability:** focused, periodic (runs at derivation, not per-turn) → low volume, inside the Max-20x $200/mo Agent SDK credit (post-June-15; normal allowance before). Enable "usage credits" so a heavy month doesn't hard-stop the job.
- **Implementation gates:** (a) the `load-l0` env-var guard is a config edit — do with Dustin's OK; (b) a one-time live probe to confirm isolation (`claude -p` is currently blocked by the permission allowlist → needs a narrow `claude -p` permission or Dustin runs it via `!`).

### 7.5 — Digest load lane (own hook)
Sibling SessionStart hook (reads `memory.db` directly, race-proof) loading the single derived-digest into a **demarcated block** (`# CONTINUITY — where we left off (context, not directive)`), separate from the L0 rules stream (signal separation). **Truncation protects the current-state/unresolved sections** (only the *arc* compresses). **Replicate the overflow-flag + error-envelope + explicit-"no digest found" plumbing** (else failures are invisible to Dustin — the exact gap the overflow flag fixed). Emit digest **age** in the block + a staleness flag (a silently-stale digest is worse than a cold boot).

### 7.6 — Operationalize (or honestly downgrade) the signal-crowding watch
The "watch for directive-misses correlating with digest load" is not a real safeguard unless operationalized: either log directive-miss incidents with digest-size at the time (reconstructable trend), or state plainly it's manual/subjective and the three structural guards (size cap, own lane, orienting-not-instruction) are the actual mitigation. Do not claim a safeguard that does nothing at baseline.

### Deferred / optional
- **7.7 register-triggered auto-deepen** — auto-pull deeper L2 texture on a reflective register. Skip unless the digest proves too shallow; it was the riskiest, least-verified piece.

## Budget + signal proof
- Digest ≤ a few thousand tokens (the ~8k/~20k peg is flexible; size by what coherent continuity needs), in the cached prefix — trivial on a 1M window. Never loads whole conversations.
- Signal (the real constraint): size cap + own demarcated lane + orienting-not-instruction phrasing keep the loaded set directive-dominant. Residual risk DEF-7-06 (attention dilution, not directly measurable) → 7.6.

## Deferments / risks
- **DEF-7-01 (HIGH, pre-existing): RESOLVED in 7.2** (commit `d5d0928`) — consolidation tombstone-marker contradiction; Pass B and the Data Preservation Rule now agree (real replacement content or leave-for-eviction; never a bare marker).
- **DEF-7-02 (MEDIUM):** digest staleness if a derivation no-ops — 7.5 age/flag detection.
- **DEF-7-03 (MEDIUM):** `--setting-sources` hook-coverage was the doc-ambiguous edge; the env-var guard (7.4) is the mechanism-independent path chosen instead.
- **DEF-7-04 (MEDIUM):** auditor isolation needs a live probe before trusting it unattended (7.4 gate).
- **DEF-7-05 (LOW):** `check-memory-noise.py` false-positives on test-counts/versions in experiential prose (advisory only).
- **DEF-7-06 (MEDIUM):** signal-crowding unmeasurable → 7.6 + structural guards.
- **DEF-7-07 (LOW/ops):** post-June-15 the auditor draws from the Agent SDK credit (claim it; enable usage-credits).
- **DEF-7-08 (LOW):** L0 hygiene — once the digest carries the relational thread, retire the L0 relational obs it makes redundant. Optional, post-digest only; not a prerequisite. Also reconcile here the write-policy `relational` = "single superseded observation" contract with the append-log model (the *derived digest* becomes the single consolidated view; `relational`/`narrative`/`emotional` obs become append-only log entries) — defer to 7.3 where the derived digest is built.
- **DEF-7-09 (LOW, opened in 7.2):** optional consolidation-agent noise-deletion toggle. Now that `delete_observations` is a safe soft-retire, the weekly agent *could* actively retire pure DO-NOT-STORE noise (cleaner active set, recoverable) instead of leaving it for the size-pressure eviction sweep (which isn't running at current scale, so noise currently accumulates indefinitely in active queries). Deferred: preservation-bias default + Dustin's explicit call on his own memory. Obsolete if eviction starts running or if noise growth never becomes a get_summary problem.
- **DEF-7-10 (LOW, opened in 7.2):** `harness/` bundle completeness — `install.sh`/`README.md` don't copy a `prompts/` dir, so the newly-added `harness/prompts/memory-consolidation.md` wouldn't be installed on a fresh bundle deploy. The live prompt at `~/.claude/prompts/` is unaffected (it's the running copy); this only matters for distributing the bundle to a new machine. Fix when/if the bundle is next published.

## Relationship to the rest of the system
- Extends `experiential-continuity-system` (entity id 3954); 7.2 ports its IN-SESSION PROTECTION rule to the weekly tier.
- Composes with Phase 6 (decay): the digest's arc-compression *is* texture decay.
- No schema change; no conflict with Phases 1–5 (DONE).
