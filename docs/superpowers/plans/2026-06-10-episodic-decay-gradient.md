# Spec — Episodic "What did I do" Decay Gradient

> The temporal-compression layer for the episodic autobiography ("what did I do today/lately").
> Past doings take progressively fewer tokens as they age and lose relevance, so the
> autobiography stays bounded forever while recent days stay vivid. Designed in the 2026-06-10
> continuity-of-self session; this is the written anchor. Extends Phase 7 (experiential-texture
> continuity) and is the *episodic* instance of the deferred Phase 6 (confidence decay).
> Pairs with the self-model digest (semantic layer) shipped 2026-06-10 — that holds WHO I am;
> this holds WHAT I've been doing.

## Status (updated 2026-06-18)
Phase: 1+2 of 3 BUILT, seeded, wired, tested — DONE pending QA. Phase 3 (age×usage) still deferred to #5.
Done: Phase 0 (`episodic_decay.py`) + Phase 1+2 —
  - `scripts/episodic_autobiography.py`: the compressed-tail store helpers — stored-obs format
    `[YYYY-MM-DD · tier] text`, `read_stored`, idempotent `plan_work` (create/recompress/skip/orphan),
    `load_view` (fresh verbatim + tail, with a fallback for aged-but-not-yet-compressed days), `--plan` CLI.
  - `~/.claude/hooks/load-episodic-autobiography.py`: a chunked SessionStart load hook (the sibling-hook
    option from "Storage + load"), 4 settings.json entries (`--chunk=0..3 --max-entries=4`). Loads in 2
    chunks today, bounded; imports episodic_decay+episodic_autobiography via a guarded sys.path.
  - Live `episodic-autobiography` entity SEEDED with 11 gist day-obs (in-context compression, failure-shapes
    preserved), + relations DERIVED_FROM `session-narratives` / part_of `claude-self`.
  - Weekly maintenance: `run-consolidation.sh` pre-step writes the deterministic work plan;
    `memory-consolidation.md` Pass F (+ a Passes-A-E carve-out) does the LLM synthesis + writes.
  - `scripts/test_episodic_autobiography.py`: 23 tests (synthetic tiers + live hook smoke), all green.
    Idempotency proven on live data: post-seed `--plan` = 0 work.
Next: QA three-phase review (in progress); then the slow-hook-WARN follow-up (Dustin's ask). Phase 3 waits on #5.
Blocked: nothing.

## Phase 1+2 build deviations (2026-06-18)
- **Decision resolved in Phase 1, not Phase 0** (Architect scope-audit flag). Open decision #3
  (single `episodic-autobiography` entity vs per-day) said "decide in Phase 0"; Phase 0 shipped without
  recording it. Resolved here to the spec's RECOMMENDATION — a single entity — by seeding it. No
  functional change vs the rec. Classify: decision-resolution.
- **Behavioral addition — `run-consolidation.sh` pre-step.** The spec said "engine = the weekly
  consolidation agent" but not HOW the deterministic rollup reaches it. Added a best-effort pre-step that
  writes the work plan to `/tmp/claude/autobiography-work.txt` (the agent's restricted Bash can't reliably
  run python3; the deny vs `--dangerously-skip-permissions` interaction is ambiguous, so determinism runs
  in the shell). Guarded — never aborts the consolidation run. Classify: behavioral-change.
- **Implementation — obs type `narrative` + a Passes-A-E carve-out** so the decay pass may supersede the
  tail with SHORTER text (the experiential-protection "richer-only" rule is scoped out for this one derived
  entity; raw `session-narratives` stay protected). Classify: implementation detail.
- **Design choice within plan-sanctioned options — sibling load hook** (not a third block on
  load-continuity-thread.py): forced by the budget math (the 2-week-verbatim fresh window ≈ a whole 9500
  chunk, so fresh + tail cannot share one hook without truncation). The spec offered both. Classify: design choice.

## Goal (one line)
A self that remembers what it's been doing, at bounded cost — recent days in full, last month as
gist, older as a one-line era — mirroring how human autobiographical memory consolidates.

## The unit: a DAY, not a session
Concurrent sessions (Dustin runs parallel instances) make "session" the wrong unit — they are
parallel stories about the same afternoon, and a person's episodic memory does not fork by
terminal window. So:
- `SessionEnd` keeps writing **per-session** `session-narratives` (raw, `null` layer, permanent —
  the verbatim record + re-derivation source).
- The consolidation agent **derives ONE day-level entry** by merging that day's session
  narratives. *That* day-entry is the unit the gradient ages and the load surfaces.

## The gradient (age measured from the day's date)
```
day close ──── +2 weeks ──── +1mo ──── +2mo ──── +3..6mo ──── older
 │ FRESH       │ GIST v1     │ GIST v2 │ GIST v3 │  ERA FLOOR
 │ (full day   │ (paragraph) │ (shorter│ (shorter│  one line per era;
 │  entry,     │             │  )      │  )      │  durable lessons already
 │  verbatim)  │             │         │         │  migrated to digest/project
        each tier DERIVED FROM THE ORIGINAL day-entry (kept at null) ↑
```
- **FRESH (< 2 weeks):** full day-entry, verbatim. Dustin's chosen window.
- **GIST (2wk → ~1mo), then further each month:** progressively shorter summaries.
- **ERA FLOOR (~3–6mo):** collapse to a single "era" line (e.g. *"late-spring '26: PixInsight GPU
  saga, astrowidget public release, memory-texture build"*). By then the *durable lessons* have
  migrated into the self-digest / project entities (where semantic residue belongs); the full
  day-entry stays archived at `null`. Truly inconsequential days may drop even the era line.

## Mechanism (the load-bearing rules)
1. **Compress FROM THE ORIGINAL, never from the prior compression.** Re-summarizing a summary is
   telephone-game drift. The raw day-entry (and the raw session-narratives under it) stay at
   `null` as the permanent source; each tier is derived fresh from the original. "Compress" means
   *the loaded representation gets shorter with age* — data is never destroyed, fully re-derivable.
2. **Age-based tiers, not a re-compression clock.** The agent maps age → required tier and ensures
   that representation exists (idempotent), rather than blindly re-compressing on a timer.
3. **Engine = the existing weekly consolidation agent.** It only ever touches day-entries past the
   2-week line — which, being settled, sidesteps any write race with active concurrent sessions
   (the 2-week fresh floor doubles as concurrency protection).
4. **Decay on AGE × USAGE once #5 lands.** Retrieval-strengthening's `access_count` lets a
   frequently-recalled old day stay vivid while an untouched one fades faster (use-it-or-lose-it).
   Build **age-only first**; wire usage in when #5 (retrieval-strengthening) ships.

## Storage + load
- **Raw:** `session-narratives` (existing, per-session, `null`, permanent).
- **Day-entries + compressed tail:** a dedicated store — proposed entity `episodic-autobiography`
  (global) holding the current day-entries and their aged gists as superseded-in-place/derived
  observations; OR per-day entities. (Decide in Phase 0; single-entity is simpler to load.)
- **Load:** its own demarcated block — the autobiography is texture, so (per Phase-7 binding
  constraint #3) it must NOT live in the L0 rules stream. Load it via the **continuity lane**
  (`load-continuity-thread.py`, already extended 2026-06-10 to carry the self-digest) as a third
  block, OR a sibling hook. Bounded budget: fresh window (~1–2 chunks) + compressed tail (<1 chunk).
- **Cost shape:** fresh-window size scales with how heavily Dustin works (it's the dominant cost);
  the gradient guarantees the *tail* never grows. Total stays ~2–3 chunks against the 14 free
  SessionStart slots.

## Dependencies / connections
- **Auto-capture #2** (pending decision) — produces the reliable day-rollup; until then, seed
  day-entries from `session-narratives`.
- **Phase 6 confidence decay** (deferred) — this is its episodic instance; agentmemory's
  Ebbinghaus `salience·e^(−λt)` + spacing reinforcement is the reference impl (competitive review).
- **#5 retrieval-strengthening** — supplies the usage signal for age×usage decay.
- **Self-model digest** (shipped 2026-06-10) — the era-floor migrates durable lessons INTO it;
  the digest is the semantic sink the episodic layer drains toward.

## Build sequence
- **Phase 0:** day-entry storage + the "merge today's session-narratives → one day-entry" rollup
  (run in the consolidation agent). Define the load block + budget.
- **Phase 1:** the age→tier compression pass (derive-from-original; era-floor migration to digest).
- **Phase 2:** load wiring (own bounded block via the continuity lane).
- **Phase 3:** age×usage once #5 lands.
- **Verify:** simulate the gradient over synthetic dated entries; confirm tail stays bounded as
  entries age; confirm a re-run is idempotent (same age → same tier, no drift).

## Open decisions (recommendations)
1. **Fresh-window length** — 2 weeks (Dustin's call; the dominant cost lever). *Rec:* keep 2wk;
   shorten only if the fresh block exceeds ~2 chunks under heavy use.
2. **Seed now vs gate on #2** — ✅ DECIDED (Dustin, 2026-06-10): seed from `session-narratives`
   now; upgrade the rollup quality when #2 ships.
3. **Single `episodic-autobiography` entity vs per-day entities** — *Rec:* single entity (simpler
   load + supersession), per-day only if it gets unwieldy.
4. **Era-floor timing** — 3–6 months. *Rec:* 3 months to one-line era; revisit if it feels too fast.
