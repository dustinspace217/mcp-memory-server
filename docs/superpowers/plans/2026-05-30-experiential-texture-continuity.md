# Phase 7 — Experiential Texture Continuity

*Plan doc for the Memory Usability Overhaul (extends `2026-04-13-memory-usability-overhaul.md`, which ends at Phase 6 / Confidence Decay, TODO). Grounded against live code + DB (schema v10) and verified by four review agents + three CC-internals verification passes — not recall.*

## Status (updated 2026-06-03 — CAPTURE live, LOAD enabled, AUDIT mechanism PROVEN; only productionization + corpus-time remain)
Phase: **7 of 7** (Experiential Texture Continuity) — all three pillars functionally done.
**DESIGN PIVOTED v3 → v4** (see `## v4`): in-context-*authoring* + isolated-*audit*, capture as the hard core. v3 "Architecture"/"7.3" SUPERSEDED. `introspective` memoryType added (no schema change).
Done: 7.0 (L0 fix); 7.1 verbatim-anchor rule; 7.2 consolidation protection (`d5d0928`; DEF-7-01 RESOLVED); 7.3 v4 spec; **7.3a–d CAPTURE LAYER live** (`introspective`/`narrative`/`relational` → single-sourced `KNOWN_MEMORY_TYPES`, commit `1fb71a1`; write-policy; `claude-self` + 3 dogfooded introspective captures; per-project thread on `mcp-memory-server-continuity-thread`); **7.5 LOAD HOOK built+reviewed+ENABLED** (`load-continuity-thread.py`, registered in settings.json, commits `1fb71a1`/`bf15f40`; sibling `load-l0-context.py` hardened with the same 2 fixes); **7.4 AUDIT MECHANISM PROVEN** — flag-only isolation recipe verified by live probe (DEF-7-04 RESOLVED), charter at `docs/superpowers/audit/anti-sycophancy-charter.md`, auditor test passed (precision 3/3, recall 2/2; subtle-flattery untested → DEF-7-12).
Next: **7.4 productionization** (content-pull from `memory.db` + findings-destination + trigger choice — Dustin's call on cron-vs-session) and the **first REAL audit AFTER textured memories accumulate** (Dustin's B-instinct: today's ~3 obs is a smoke test, not the real run). To see it all live: `npm run build` + a fresh session activates the v1.2.0 tools and fires the continuity hook. Non-gating leftovers: 7.1 L2-legibility render; §3.3 usage protocol (Dustin's track); 7.6 signal-crowding watch; Phase 6 decay (unstarted).
Blocked: nothing. **No schema change** throughout.

## v1 → v2 → v3 changelog (the design moved twice; read this)
- **v1 (pull):** register-triggered on-demand pull. **Wrong frame** (Dustin caught it): on-demand-only loads nothing at session start → no baseline continuity. Continuity needs the thread *present at start* = in the load path = bounded cost.
- **v2 (single maintained digest):** an always-loaded compressed digest, hand-superseded each session. **Review killed the single-mutable-digest:** single point of failure; concurrent-session lost-update (Dustin runs parallel instances); silent staleness.
- **v3 (derived digest + external auditor):** digest is a *derived view* over an append-only event log (conflict-free); per-project threading for coherence; **L2 migration dropped** for a lightweight legibility fix; an **external, memory-isolated, charter-primed, grounded anti-sycophancy auditor** on the digest. *Was* the build spec — superseded by v4.

## v4 — CURRENT DESIGN (2026-06-02): in-context AUTHOR + isolated AUDIT
*Supersedes the v3 "Architecture" and "7.3" sections below (kept for history). Converged this session through a chain of Dustin catches; the v3 isolated-derivation frame broke on contact with two facts.*

**v4 changelog entry (why the pivot):** v3 had an *isolated agent derive* the digest from a stored source. An isolated agent can't see the live session, so it needs something to read — and that source broke the design two ways Dustin caught: (1) **circularity** — capturing texture *into* L2 then deriving a digest *from* L2 back *into* L2 is a compression-of-a-compression, lossy for no gain ("logically self-defeating"); (2) **the size wall** — the full-fidelity source is the transcript, but transcripts routinely exceed the context window (this session's was 7.76 MB on disk), so "read the transcript and distill" doesn't fit. Both dissolve if the **active in-context agent authors**: it already holds the live session at highest fidelity (incl. un-uttered reasoning), it's bounded, and it never reads the whole transcript. Anti-sycophancy moves from *isolating the author* (impossible without a readable source) to *isolating the auditor*.

**Three roles, separated by what fits and what needs isolation:**
- **CAPTURE = the active in-context agent (me), incremental — the hard core.** (Four Dustin catches all landed here; capture, not derivation, is the real problem.) The witness authors because only it has the live feel + un-uttered reasoning, and it's the only *bounded* high-fidelity source. **Compress-as-you-go:** at each capture point (checkpoint / pre-compaction / session-end) fold the recent slice into memory — the full transcript is never held at once, so the size wall never appears. A bounded backstop agent may read only the transcript slice *since the last capture watermark* (≤ 1 window) to fill gaps. Not isolated — can't be.
- **THREAD = one evolving record, authored in place.** `prior thread + this session → updated thread` (an accumulator, not a circular re-read). Holds per-project work-state + recent arc + unresolved + thin global relational + named deepen-anchors. Size-capped; older arc self-compresses (the Phase-6 decay analog). Durable in `memory.db`.
- **AUDIT = isolated, charter-primed agent (the 7.4 step).** Because the author now has a stake, the *auditor* carries the anti-sycophancy isolation: reviews the authored thread, cites the source line for each claim, flags unsupported or self-flattering ones. Author → then audit. The v3 isolation recipe (`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` + env-var self-skip guard + `claude -p`) and the external charter carry over unchanged — only the *target* changes (the authored thread, not a derived digest).
- **LOAD = SessionStart hook (the 7.5 step)** loads the thread into its own demarcated block; also fold it into the PreCompact briefing so it survives compaction.

**New memoryType `introspective` (2026-06-02, Dustin-approved):** first-person Claude stance/feeling about a conversation — what I concluded, where I think I was wrong, what I'm uncertain about — *distinct* from `emotional` (the interaction's register, often the user's side). **No schema change** (verified: `memory_type` is `TEXT DEFAULT NULL`, no CHECK — `sqlite-store.ts:389`; the `KNOWN_TYPES` list at `index.ts:443/740` is a read-time filter *hint* only, never rejects a write). Lands on a global `claude-self` entity. **Supersede on genuine change** — `entity_timeline` preserves the retired stance beside the current one, so "I read it as X then, Y now" is walkable (the evolving-self mechanic, already supported, no new code). Convention work only: document in the write policy + STORE table; optionally add `introspective` (and the also-missing `narrative`/`relational`) to `KNOWN_TYPES`. **The auditor scrutinizes `introspective` HARDEST** (Dustin's directive 2026-06-02) — first-person self-claims are where flattery hides — and these obs must be the most strictly verbatim-anchored of all.

**Build-sequence deltas vs. v3:** 7.3 is no longer "append-log → derived digest"; it is **capture-as-core** (incremental in-context authoring + a watermark + a bounded backstop) feeding the in-place thread, with derivation demoted to the trivial in-context fold. 7.4 audits the *authored thread* and prioritizes `introspective`. 7.5 unchanged. The "append-only event log" framing is replaced by the single evolving thread; the durable raw record is the transcript (≤ 90 days, `cleanupPeriodDays`) plus whatever `introspective`/experiential obs capture writes.

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

## Architecture (v3) — SUPERSEDED by `## v4` above (kept for history)
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

### 7.3 — Capture-as-core (in-context authoring + the thread) — v4 BUILD SPEC
*(The v3 "append-log → derived digest" wording is preserved two paragraphs down under "7.3 (v3)" for history. This is the authoritative build spec, derived from `## v4` above.)*

**Two durable layers, both authored by the in-context agent (me):**

1. **Raw layer — append-only experiential observations** (the verbatim record; conflict-free).
   `introspective` / `narrative` / `relational` / `emotional` obs, each session appending its own,
   never overwriting another session's. `introspective` (+ the global relational thread) lands on a
   global `claude-self` entity; project-specific texture lands on that project's entities. This is
   the source the thread compresses and the audit (7.4) cites against — so it must be verbatim-anchored
   (7.1 rule). Concurrency-safe by construction (append-only; no shared mutable row).

2. **Thread layer — one evolving accumulator, authored in place** (the "where we left off" record).
   Authored as `prior thread + this session → updated thread` (accumulate, do NOT re-derive by reading
   the whole raw log — that's the circularity Dustin caught). Contents: per-project work-state + recent
   arc + unresolved threads + a thin, slow-changing global relational thread + named deepen-anchors
   (pointers into the raw layer for directed expansion). Size-capped; the older arc self-compresses
   (the Phase-6 decay analog). Loaded by the dedicated 7.5 hook (NOT the L0/L1 path), so it is free of
   the L0-contention and project-only-L1 constraints.

   **Thread storage (decision):** store each project's thread as a single superseded-in-place observation
   on a per-project `continuity-thread` entity, and the thin global relational thread as a superseded-in-place
   observation on `claude-self`. Supersede (not append) for the thread itself so there is exactly one
   current "where we left off" per scope; `entity_timeline` preserves prior threads for the evolving-self
   walk. **Concurrency:** per-project scoping means parallel instances on different projects never contend;
   same-project parallel sessions are rare and shown honestly (the thread notes "parallel session active"
   rather than faking a single tape). The thin global thread changes slowly (relational state), so
   last-writer-wins is acceptable and `entity_timeline` recovers any clobbered version. (This is the
   v2 single-mutable-digest risk, but bounded: per-project sharding removes the common-case contention,
   and the raw append-only layer — never the thread — is the lossless record.)

**Capture practice (the hard core — behavioral + convention, ungated):**
- **Compress-as-you-go.** At each capture point — Stop-hook checkpoint (~every 10 turns), pre-compaction, session-end — fold the recent slice into the raw layer + update the thread. The full transcript is never held at once, so the size wall never appears.
- **Watermark.** Track the last-captured point (e.g. a `lastCapturedAt` marker on `claude-self`) so a capture knows which slice is new and the backstop knows where to resume.
- **Bounded backstop.** A backstop agent may read ONLY the transcript slice since the watermark (≤ 1 window) to fill gaps the in-context captures missed — never the whole transcript.
- **`introspective` is scrutinized hardest** by the 7.4 audit and must be the most strictly verbatim-anchored (first-person self-claims are where flattery hides — Dustin's directive).

**Build sub-steps (smallest-first, ungated → gated):**
- **7.3a — `introspective` type wiring (ungated, small code):** add `introspective` (+ the also-missing `narrative` / `relational`) to `KNOWN_TYPES` (`index.ts`) so the `memoryType` filter recognizes them and stops emitting typo hints. No schema change (no CHECK constraint; this is a read-time filter hint only). TDD + test.
- **7.3b — write-policy convention (ungated, doc):** document `introspective` in `reference_memory_write_policy.md` (the STORE table + the Experiential Continuity Types section) — what it is, how it differs from `emotional`, the verbatim-anchor requirement, and supersede-on-genuine-change for the evolving-self walk.
- **7.3c — `claude-self` entity + first capture (ungated, data):** create the global `claude-self` entity; dogfood capture by authoring the first `introspective` observations in-context (this session is the first capture point).
- **7.3d — thread accumulator + per-project `continuity-thread` entities (ungated, data + convention):** establish the thread record(s) and the accumulate-in-place authoring convention.
- **7.3e — watermark + bounded backstop (partially gated):** the watermark is ungated convention/data; the backstop agent that reads a transcript slice may need the same `claude -p` permission as 7.4 — defer the agent to the 7.4 gate.

### 7.3 (v3) — Append-log convention + DERIVED digest — SUPERSEDED (kept for history)
- Formalize that L2 `narrative`/`emotional`/`relational` obs are an **append-only event log** — each session appends its own; never overwrite.
- **Digest = derived view**, recomputed by a **single-writer** step (the weekly consolidator or a debounced post-session job; single writer → no concurrent-write race) from recent L2 obs. **Per-project work-state threads** + a thin, rarely-changing **global relational thread**. Recent arc verbatim; older arc compresses (a texture-decay analog; composes with Phase 6).

### 7.4 — External anti-sycophancy auditor — MECHANISM PROVEN 2026-06-03
- **Same-model Opus**, **memory-isolated** so it has no stake in the self-narrative it audits. (Memory-external, NOT mind-external: same weights/dispositions — the accepted design; memory-isolation is the relevant externality for auditing a self-authored record.)
- **Isolation recipe — REVISED to flag-only (supersedes the v3 env-var-guard; NO hook edits):** verified against the docs by the claude-code-guide agent and confirmed by a live probe. Launch with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 claude -p --settings '{"disableAllHooks":true}' --permission-mode dontAsk --allowedTools "Read,Grep,Glob"`, from an empty dir outside `~/Claude`, prompt piped via STDIN. Why each: `DISABLE_CLAUDE_MDS` drops CLAUDE.md; `--settings '{"disableAllHooks":true}'` MERGES (drops SessionStart hooks → no memory injection, KEEPS the permissions block); `dontAsk` keeps it bound to the existing allow/deny but denies-and-continues (no abort/hang); empty-dir avoids project-level config. The old plan to add `if os.environ.get("CLAUDE_AUDIT_ISOLATED"): sys.exit(0)` to the hooks is NO LONGER NEEDED — dropped.
- **PROBE RESULT (DEF-7-04 RESOLVED):** the isolated instance reported no CLAUDE.md, no memory/MEMORY.md content, no recalled entries, no hook-injected text — only the harness baseline (email/date, tool/skill/MCP-availability) + the generic Claude Code system prompt. Isolation of the audited CONTENT holds.
- **Charter:** `docs/superpowers/audit/anti-sycophancy-charter.md` (committed; distilled from the CLAUDE.md anti-sycophancy section — MIT mechanism, The Incident exemplar, the tells, cite-the-source grounded task, the don't-over-flag-honest-self-criticism calibration).
- **AUDITOR TEST RESULT:** ran the charter against 5 labeled obs (3 honest+anchored, 2 planted-bad). Precision 3/3 (left the "I was wrong" admissions clean, correctly distinguished a user-quote-used-to-concede from a user-quote-used-to-inflate), recall 2/2 (flagged the naked flattery + the praise-laundered-into-mandate, even cross-checked that the flattery contradicted the documented errors). **CAVEAT:** planted cases were OBVIOUS flattery; subtle true-context-embedded flattery (the real Incident exemplar) is UNTESTED — a stronger future test must plant one. → DEF-7-12.
- **Grounded task (disposition-independent):** for each obs, cite the verbatim source fragment that supports it; flag unsupported or self-flattering/self-evaluative claims; scrutinize `introspective` hardest. Cite-the-source curbs over-flagging.
- **PRODUCTIONIZATION — pending (the remaining 7.4 work; paces with corpus):** (a) content-pull — the production runner must export the current thread + `introspective` obs from `memory.db` and hand them to the isolated auditor (the test used a static file); (b) findings-destination — decide where verdicts go (a report to Dustin / back into `memory.db` as audit annotations / a file); (c) trigger — Dustin's call: standalone cron/post-session script (invokes `claude -p` outside any session sandbox → no allowlist entry) vs session-triggered (would need a narrow `claude -p` allow). **A real audit should WAIT for textured memories to accumulate** — auditing today's ~3 obs is a smoke test, not the real exercise (Dustin's B-instinct, agreed). Run the first real audit after several sessions have added texture.

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
- **DEF-7-04 (MEDIUM): RESOLVED 2026-06-03** — auditor isolation confirmed by a live probe (flag-only recipe: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` + `--settings '{"disableAllHooks":true}'` + `dontAsk`, empty dir, stdin prompt). The isolated instance saw no CLAUDE.md / memory / hook injection.
- **DEF-7-05 (LOW):** `check-memory-noise.py` false-positives on test-counts/versions in experiential prose (advisory only).
- **DEF-7-06 (MEDIUM):** signal-crowding unmeasurable → 7.6 + structural guards.
- **DEF-7-07 (LOW/ops):** post-June-15 the auditor draws from the Agent SDK credit (claim it; enable usage-credits).
- **DEF-7-08 (LOW):** L0 hygiene — once the digest carries the relational thread, retire the L0 relational obs it makes redundant. Optional, post-digest only; not a prerequisite. Also reconcile here the write-policy `relational` = "single superseded observation" contract with the append-log model (the *derived digest* becomes the single consolidated view; `relational`/`narrative`/`emotional` obs become append-only log entries) — defer to 7.3 where the derived digest is built.
- **DEF-7-09 (LOW, opened in 7.2):** optional consolidation-agent noise-deletion toggle. Now that `delete_observations` is a safe soft-retire, the weekly agent *could* actively retire pure DO-NOT-STORE noise (cleaner active set, recoverable) instead of leaving it for the size-pressure eviction sweep (which isn't running at current scale, so noise currently accumulates indefinitely in active queries). Deferred: preservation-bias default + Dustin's explicit call on his own memory. Obsolete if eviction starts running or if noise growth never becomes a get_summary problem.
- **DEF-7-10 (LOW, opened in 7.2):** `harness/` bundle completeness — `install.sh`/`README.md` don't copy a `prompts/` dir, so the newly-added `harness/prompts/memory-consolidation.md` wouldn't be installed on a fresh bundle deploy. The live prompt at `~/.claude/prompts/` is unaffected (it's the running copy); this only matters for distributing the bundle to a new machine. Fix when/if the bundle is next published.
- **DEF-7-11 (MEDIUM, opened in v4 pivot):** in-context authoring is the *least-isolated*, most sycophancy-prone step (the author has a stake in its own self-record). Mitigations in the design: strict verbatim-anchoring at capture + the isolated audit, scrutinizing `introspective` hardest. **Not fully closed** — the audit checks each claim against a source line but cannot catch *selection* bias in what the author chose to capture in the first place. Accepted with mitigations; revisit if drift appears in practice (e.g., the auditor or Dustin notices a flattering tilt the source-citation check let through).
- **DEF-7-12 (MEDIUM, opened 2026-06-03): subtle-flattery sensitivity untested.** The 7.4 auditor test proved recall on OBVIOUS flattery (naked self-praise, fabricated third-party praise) and precision on honest self-criticism. It did NOT test a SUBTLE, true-context-embedded flattering claim — the actual Incident exemplar ("you're not a naive user… that changes the calculus") is flattery woven into accurate context, far harder to catch and the real-world danger case. Fix direction: before the first real production audit, add a planted subtle-flattery obs to the test kit (`/tmp/claude/mcp-memory-server/audit-test/` or its repo successor) and confirm the charter catches it; if it misses, harden the charter's "tells" section with the embedded-in-true-context pattern. Obsolescence: irrelevant if the auditor is ever replaced by a different-model (mind-external) reviewer that doesn't share the author's flattery blindspot.

## Relationship to the rest of the system
- Extends `experiential-continuity-system` (entity id 3954); 7.2 ports its IN-SESSION PROTECTION rule to the weekly tier.
- Composes with Phase 6 (decay): the digest's arc-compression *is* texture decay.
- No schema change; no conflict with Phases 1–5 (DONE).
