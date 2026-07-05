# Prospective Memory + Provenance Close-out (v1.7.0) — Plan

> Dustin (2026-07-05, ~04:38): "Let's do it. prospective memory and close out 4."
> Approving the two recommendations from the biomimicry/capabilities gap analysis:
> (1) trigger-conditioned future recall — the one memory-biology mechanism the server
> lacks entirely; (2) item #4 of the 2026-06-05 plan (provenance), approved 2026-06-04
> and discovered this morning to have silently never shipped.

## Status (updated 2026-07-05, ~15:00 PDT)
Phase: COMPLETE — v1.7.0 shipped (0f6e7ee implementation, fbe9bd6 QA round + bump)
Done: both features live on main; Architect SHIP (verify tool cut → DEF-PM-02 per
  Dustin); QA Discussion #92 (both verdicts SHIP, zero code defects; three TA
  coverage MEDIUMs closed by BUILT fixtures — none exposed a latent bug this time,
  because the #91-style round-trip guard was already in the diff). 557 tests / 18
  files, both pools green. DEPLOY STAGED: MEMORY_TRIGGER_THRESHOLD=0.84
  (percentile-held granite recalibration, this morning's run) added to the live
  registration env — next natural server restart brings up v1.7.0 + v18 + gate.
Next: Dustin to approve the proposed Session Protocol line (workspace CLAUDE.md)
  so sessions actually CALL check_prospective_triggers; nothing else open.
Blocked: nothing

## Feature 1 — Prospective memory (schema v18, part A)

**The gap it closes:** every existing surface is retrospective — memory arrives only
when someone thinks to search. The brain's prospective memory ("when situation X
arises, remember Y") has no analog here. Continuity threads half-serve it but are
per-project, head-of-thread only, and don't fire on *condition*.

**Decided design (do not relitigate):**
- Table `prospective_triggers`: id, trigger_text (≤1000), payload (≤5000), project
  (nullable, normalized like entities.project), created_at, fired_at ('' sentinel =
  pending, ISO timestamp = fired — house style). One-shot semantics: firing retires.
- `vec_triggers` vec0 virtual table (384-dim, +trigger_id aux col) mirroring the
  vec_observations pattern: synced on create (fire-and-forget like syncEmbedding),
  orphan-cleaned at startup, CLEARED by the v15 vec_config model-switch guard
  (extend the guard's DELETE to both vec tables — a mixed-model trigger index is the
  same silent-drift hazard the guard exists for).
- Tools (4):
  - `set_prospective_trigger(triggerText, payload, projectId?)` → id
  - `check_prospective_triggers(contextText, projectId?, threshold?)` — embeds the
    context ONCE (query-side prefix), KNN over pending triggers scoped to
    project+global, fires everything ≥ threshold, marks fired_at, returns fired
    triggers with scores. Degrades to `{ fired: [], vectorSearchEnabled: false }`
    when the model/vec table is unavailable (no LIKE fallback — same honesty rule
    as find_precedents).
  - `list_prospective_triggers(projectId?, includeFired?)` — management surface.
  - `delete_prospective_triggers(ids)` — idempotent hard delete (triggers are
    ephemeral intent, not knowledge; the preservation lifecycle does NOT apply —
    deliberate exception, documented in the tool description).
- Threshold: `MEMORY_TRIGGER_THRESHOLD` env resolved in embedding.ts beside the three
  existing geometry-coupled gates. MiniLM-geometry default 0.50 (between the
  precedent floor 0.25 and similar 0.85 — firing interrupts, so it must sit well
  above precedent-recall looseness). Deploy note: the live granite registration
  needs a recalibrated value (percentile-mapped like the G3 gates; head agent sets
  the live env at deploy, NOT the builder).
- Firing is TOOL-DRIVEN in v1: the Session Protocol gains a step (call check with
  the current project + a one-line context) and the tool description teaches
  mid-session use on project switch. Harness auto-fire = DEF-PM-01 (deferred until
  tool-driven usage proves the firing threshold behaves).

## Feature 2 — Provenance close-out (#4; schema v18, part B)

- `observations.source_ref TEXT NOT NULL DEFAULT ''` ('' = unknown/unset — house
  sentinel style; the June 5 spec's "prefer nullable" loses to consistency with
  every sibling column except summary's deliberate NULL).
- Optional `sourceRef` (≤200) param on `add_observations`, `supersede_observations`
  (applies to replacement rows), and `create_entities` (applies to seeded
  observations). Stored verbatim; surfaced in ObservationSchema output +
  entity_timeline.
- `verify` tool: CUT (Architect FLAG-TO-USER → Dustin ruled source_ref-only,
  2026-07-05 ~04:50). The June 5 spec was internally in tension — it named the thin
  verify tool while also mandating "do NOT rebuild what entity_timeline gives"; a
  compose-only tool fails the anti-bloat practical-use test. Registered as
  **DEF-PM-02** below: build only when a NAMED workflow demonstrably reaches for a
  one-call provenance chain instead of entity_timeline + get_connected_context.
- Harness follow-up (separate, not builder scope): capture prompts/hooks pass the
  session id as sourceRef. Until then the column simply stays '' for most writes —
  same adoption curve as valid-time (v14).

## Migration v18
One migration, both parts: CREATE TABLE prospective_triggers + vec_triggers setup +
ALTER observations ADD source_ref. House race discipline (IMMEDIATE, in-txn version
re-check, duplicate-tolerant ALTER, Issue #78 pattern). Race harness already covers
the chain from fresh DB.

## Deferments originated in this plan
- **DEF-PM-01** — harness auto-fire of prospective triggers (SessionStart hook calls
  check automatically). Defer until tool-driven usage proves the threshold behaves.
  Severity LOW. Obsolescence: if tool-driven checking proves sufficient forever.
- **DEF-PM-02** — the `verify` provenance-chain tool (Architect flag; Dustin ruled
  source_ref-only). Found by: architect-v17. Severity LOW. Fix direction: thin
  compose-only tool over entity_timeline + relations. Reopen condition: a named
  workflow demonstrably wanting the one-call chain.

## Version/test bookkeeping
v1.7.0. Tools 19 → 23. Tests: migration-validation forward test for v18, tool-boundary
Zod tests, store-level trigger lifecycle tests (Pool 1, vectors off = degraded-path
contract; real firing test in Pool 2 vector-integration), harness declaration pin for
the new tools' schemas.

## Deviation log

1. **verify tool cut mid-plan** (scope-change, Architect FLAG → Dustin ruling):
   documented in Feature 2 above; DEF-PM-02.
2. **Builder's degrade-flag clarification** (behavioral-clarification, accepted):
   checkProspectiveTriggers reports vectorSearchEnabled:false whenever the CALL
   can't run vector matching (model loading/failed, not just configured-off) —
   the honest reading of the single-flag degrade shape; matches the Pool 1 test.
3. **QA round: three check-side coverage MEDIUMs** (fix, from review): the scope
   clause, threshold param, and vec_triggers guard-clear each had zero firing
   coverage. All three fixtures BUILT (fbe9bd6, the #91 rule) with positive
   controls; unlike #91, none exposed a latent defect — the source_ref round-trip
   guard #91 taught us to demand was already in the implementation diff.
4. **Accepted-deferred, named home** (other): the fire transaction's DEFERRED
   read-then-write shape (CR minor) is pre-existing across every mutation method;
   both reviewers concur its failure mode is a safe throw and that the DEF-RR-04
   child-process harness is the only substrate that could ever pin it. Not a
   register entry — recorded here as the named home if multi-checker contention
   ever appears in practice.
5. **Trigger-threshold recalibration ran at deploy-prep, not in the build**
   (planned): percentile-held mapping (MiniLM 0.50 ≈ p97-99 of query↔top-k
   cosines → granite ≈0.84) from scripts/recalibrate-thresholds.py distributions
   on a backup-DB copy; 0.84 written to the live registration env by the head
   agent. Builder never touched live config (per spec).
