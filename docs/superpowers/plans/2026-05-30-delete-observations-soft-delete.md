# Fix: make `delete_observations` a soft-delete (align to design intent)

*Standalone mcp-memory-server fix. Surfaced during Phase 7 (experiential texture) but kept separate — it's a deletion-semantics correctness fix, not a texture feature. Grounded in source + git this session, not recall.*

## Status (updated 2026-06-01)
Phase: standalone fix — IMPLEMENTED + REVIEWED, pending commit approval.
Done: `deleteObservations` hard `DELETE FROM` → soft `UPDATE superseded_at` (vec embedding retained, matching `supersedeObservations`). Two TDD tests — soft-delete recovery via `entityTimeline`, and re-add-after-soft-delete (guards the `UNIQUE(entity_id, content, superseded_at)` interaction, a silent-data-loss shape). `delete_observations` tool description updated. Full non-vector pool GREEN (541 tests); Pool 2 untouched (zero delete tests). 3-agent review (code-reviewer + test-analyzer + adversarial-tester, all Opus) → unanimous SHIP, no bugs. Write-policy doc + project CLAUDE.md "Memory Maintenance" now accurate (write-policy needed no edit — the code caught up to what it already documented).
Next: Dustin approves the commit (NOT committed — commit-only-when-asked rule). Then Phase-7 7.2 picks up the now-stale consolidation-prompt line 47.
Blocked: nothing. **No schema change, no migration, no version bump.**

## Goal trace (A/B/C anti-bloat gate)
- **A — reduce drift/hallucination:** ✓ Hard delete is irrecoverable; a wrongly-deleted observation is gone and can't be audited via `asOf`. Soft-delete preserves the trail.
- **B — faithful recall (who/what/when/why):** ✓ Soft-delete keeps the observation as recoverable history, so "what did we know at time T" survives a removal. Hard-delete destroys it.
- **C — quality:** ✓ (one hop) Lets the consolidation agent and callers remove noise from active queries **without data loss**, and makes the long-documented behavior actually true.

## Problem
`deleteObservations` runs `DELETE FROM observations WHERE entity_id=? AND content=? AND superseded_at=''` (`sqlite-store.ts`, the `delObs` prepared statement) — a **hard delete**: row gone, irrecoverable, not recoverable via `asOf`. It is the **one path that bypasses** the system's entire preservation-biased lifecycle (supersede → superseded → tombstoned → hard-delete, the last two only via the size-pressure-gated, LRU-shielded eviction sweep in `evict.ts`). It also contradicts `reference_memory_write_policy.md`, which has described `delete_observations` as "Retired to Tier 2 (recoverable via asOf)" since ~2026-04-16. Git: never soft (always `DELETE FROM` since 2026-04-01).

## The fix
Change `deleteObservations` from hard delete to **soft delete (retire-without-replacement)**:
1. Replace the `DELETE FROM observations …` statement with `UPDATE observations SET superseded_at = ? WHERE entity_id = ? AND content = ? AND superseded_at = ''` (timestamp = current ISO).
2. **Keep the `vec_observations` row** — do NOT delete the embedding (the current hard-delete path removes it via `syncEmbedding(..., 'delete')`). Match `supersedeObservations`, which deliberately retains the vec row so `asOf` vector search can recover the historically-active observation.
3. Keep the existing `updated_at`/`last_accessed_at` bump.

Idempotent + constraint-safe: the `superseded_at=''` filter means an already-soft-deleted obs won't re-match (no-op); the `UNIQUE(entity_id, content, superseded_at)` constraint is satisfied (one row's sentinel flips from `''` to a timestamp).

### What `delete_observations` now means
"Retire an observation from active queries **without** a replacement, keeping it recoverable via `asOf`." This fills a real gap: `supersede` *requires* replacement content, so pure-noise-with-nothing-to-replace previously had no non-destructive option. Now it does — and it's the observation-level analog of `deleteEntities`' soft-delete.

### Entity vs observation eviction — known, accepted limitation
A soft-deleted observation enters the **superseded** tier (recoverable) but `evict.ts` keys on `entities.superseded_at` (entity-level), so a superseded *observation* inside an *active* entity is **never auto-tombstoned/hard-deleted** — it persists as history indefinitely. This already matches `supersedeObservations`' behavior and the preservation bias, and eviction isn't running at current scale anyway. **Decision: accept it.** Extending eviction to the observation level is a separate, larger change → DEF-DEL-01.

## Implementation steps
1. **`sqlite-store.ts`:** `deleteObservations` DELETE→UPDATE `superseded_at`; remove the vec-row deletion (retain embedding).
2. **Tests** (`__tests__/knowledge-graph.test.ts`): the current delete tests assert the row is gone — *locate and update* them to assert: excluded from active queries; `superseded_at` set; recoverable via `asOf`; vec row retained. Add a test that a soft-deleted obs is NOT returned by normal search but IS returned at an `asOf` before the deletion. (Expect existing delete tests to fail until updated — that's part of the change.)
3. **Tool description** (`index.ts`, `delete_observations`): *locate and update* to "soft-delete — retires the observation (recoverable via `asOf`); does not destroy it."
4. **Docs become correct:** `reference_memory_write_policy.md` Cleanup Operations (the delete=Tier-2 claim becomes TRUE — drop the "pending correction"); re-frame CLAUDE.md "Memory Maintenance" ("never delete to clean up") — delete is now a safe soft-retire usable for noise.
5. **Consumer check:** grep `delete_observations`/`deleteObservations` callers; confirm none relied on hard-delete (immediate space reclamation / true removal). Expected: none — the design never wanted a hard per-obs delete.
6. **Schema:** no change, no migration, no version bump.

## Relationship to Phase 7
This **unblocks** the 7.2 cleanup. Once delete is soft: the consolidation prompt's Pass-B can simply use it for noise (safe/recoverable) instead of the "never delete / leave it" workaround, and the write-policy doc is accurate without edits. **Sequence this fix before finishing the Phase-7 7.2 doc edits.**

## Implementation notes & deviations (2026-06-01)
Built this session under strict TDD (the soft-delete recovery test went RED→GREEN; the re-add test was added post-GREEN as a regression guard and passes immediately by design). Deviations from the plan-as-written:

1. **Review was abbreviated in-chat, not the full GitHub Discussions 3-phase workflow.** Ran three Opus agents (code-reviewer + test-analyzer + adversarial-tester — one more than the "code-reviewer + test-analyzer minimum" in step 2's note) and synthesized in conversation. *Why:* a ~50-line single-function fix where all three independently converged on SHIP; the Discussions workflow's value (independent cross-examination, durable audit trail) is high for major/contested changes and heavy for a small uncontested one. *Class:* process scope-change. Full Discussions treatment available on request.

2. **Added a second test beyond the tests named in step 2.** Step 2 named excluded-from-active / `superseded_at`-set / recoverable-via-`asOf` — all covered by the `entityTimeline`-recovery test. Added **re-add-after-soft-delete** on top: the review's one critical coverage gap, the load-bearing interaction the change introduces (silent data loss if the `UNIQUE` constraint or active-filter ever regressed). *Class:* review-driven coverage addition.

3. **Write-policy doc needed no edit.** Step 4 anticipated dropping a "pending correction" on `reference_memory_write_policy.md`. It already described `delete_observations` as Tier-2/recoverable (lines 110/114); the code fix made that description *true*, and no pending-correction marker existed there. *Class:* deferment resolved as no-op. (Before the fix that doc was actively instructing a data-loss operation — a real goal-A drift hazard the fix closes, not just a cosmetic mismatch.)

4. **Project CLAUDE.md test-count snapshot left stale (flagged, not edited).** The two new tests moved the parameterized suite by +4 (knowledge-graph ~378, Pool 1 541, total 549). The "545/374/537" counts in `mcp-memory-server/CLAUDE.md` now lag. Not edited: outside step 4's doc list, a perpetually-drifting snapshot, and the exact per-file count wasn't independently re-verified. Refresh on request.

## Deferments / risks
- **DEF-DEL-01 (LOW):** observation-level eviction — extend `evict.ts` to tombstone/hard-delete old superseded *observations* (not just entities) under size pressure, so soft-deleted observations eventually traverse the full four-tier chain. Deferred: eviction isn't running at current scale; preservation-bias tolerates retained history; larger change. Revisit if observation-history growth becomes a real size problem.
- **DEF-DEL-02 (LOW):** Pool 2 vector test for active-exclusion of a soft-deleted-but-still-embedded observation. test-analyzer ranked it nice-to-have: the kept embedding *could* surface in active KNN, but the active-search path filters `superseded_at` (verified by code-reviewer at `sqlite-store.ts:2492` and by adversarial-tester), and the supersede suite already exercises the identical `syncEmbedding`-skip mechanism (`vector-integration.test.ts:83`). Deferred under the anti-bloat gate as regression insurance over already-verified behavior.
- **Phase-7 7.2 pointer:** `~/.claude/prompts/memory-consolidation.md` line 47 is now stale — it forbids `delete_observations` on a "hard delete: irrecoverable" rationale the fix has falsified, and now conflicts with the (correct) write-policy doc that says to use delete for noise. Rewrite belongs to Phase-7 7.2 per "Relationship to Phase 7" above; sequence it after this commit.
- **RISK (resolved):** any caller relying on immediate hard removal would change behavior — step-5 consumer check found the only caller is the `delete_observations` MCP handler (`index.ts:346`); nothing relied on hard removal.
- **Note (done):** server code → Post-Coding Process review run (abbreviated, deviation #1).
