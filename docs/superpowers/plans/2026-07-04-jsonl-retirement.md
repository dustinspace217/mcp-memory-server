# JSONL Backend Retirement (v1.6.0) — Plan

> Dustin (2026-07-04, ~04:45 PDT): "Retire JSONL backend." Context: the backend has
> been deprecated since v1.0.0, but every feature since has paid a tax — dual-backend
> implementation or a "throws in JSONL" branch, plus a permanent seat in the
> parameterized test suite. Decision surfaced in the v1.5.0 close-out review of
> project-wide open questions; Dustin ruled retire.

## Status (updated 2026-07-04, ~05:35 PDT)
Phase: COMPLETE — v1.6.0 shipped (3e214ee implementation, 56b3570 QA round + bump)
Done: JsonlStore deleted (-1,314 net lines); jsonl-reader.ts upgrade path live-probed
  end-to-end; both QA verdicts SHIP; the QA round's new fixture test found + fixed a
  REAL pre-existing migrateFromJsonl defect (relation created_at/superseded_at dropped
  → superseded relations resurrected as active). 540 tests / 18 files, both pools green.
Next: Discussion thread post (Phase B replies pending), then nothing.
Blocked: nothing

## Decisions (settled — do not relitigate)

1. **The JSONL→SQLite auto-migration STAYS.** It is the upgrade path for any old
   deployment and the data-preserving option (workspace rule: data-preserving before
   data-destructive). What gets deleted is JSONL as a *live backend*, not the ability
   to read an existing .jsonl file once, migrate it into SQLite, and rename it .bak.
2. **A fresh .jsonl path is an explicit error.** `MEMORY_FILE_PATH=*.jsonl` where no
   file exists (nothing to migrate) throws with a message naming the retirement and
   telling the user to point at a .db path instead. No silent substitution
   ("every error tells the user what went wrong").
3. **`JsonlStore` is deleted, not frozen.** The migration only needs a line-parser;
   that shrinks to a small `jsonl-reader.ts` (loadGraph equivalent: per-line error
   isolation, temporal-field/summary/project deserialization compat — exactly what
   `migrateFromJsonl` consumes). ~700 lines of dead GraphStore implementation go.
4. **`rankingUnavailable` dies with it.** The flag existed solely for the JSONL
   relevance-mode fallback. It leaves `PaginatedOutputSchema`, the tool descriptions,
   and the harness declaration guard (case (c) reworks to pin the flag's ABSENCE
   from the advertised schema is NOT needed — the case is simply removed; case (a)
   still covers the declaration-guard pattern).
5. **Version: v1.6.0** (removes a documented backend = minor bump, not patch).

## Worklist (single Opus builder, then QA)
1. Extract `jsonl-reader.ts` (migration parser only) from jsonl-store.ts; rewire
   `migrateFromJsonl` / index.ts auto-migration to it; delete `jsonl-store.ts`.
2. index.ts: `.jsonl` routing → migrate-if-exists (unchanged flow) else throw
   retirement error; remove JsonlStore import/registration and the JSONL branches.
3. types.ts: remove JSONL-specific interface notes; GraphStore contract unchanged.
4. Tests: collapse `describe.each` to SQLite-only in knowledge-graph.test.ts; delete
   JSONL-specific blocks (atomic writes, summary round-trip, scoped-search parity,
   rankingUnavailable fallback + cursor guard in fts-search.test.ts, harness case (c));
   KEEP + extend migration.test.ts (it now exercises jsonl-reader.ts; add a
   fresh-.jsonl-path-throws test); file-path.test.ts extension-routing updates.
5. Docs: CLAUDE.md (architecture bullets, Known Limitations, Tests section, Version
   History v1.6.0 entry), README.

## Deviation log

1. **Builder kept the describe.each scaffolding** (other, minimal-diff call): single-entry
   array + ~45 now-permanently-false `ext === 'jsonl'` guards left verbatim rather than
   flattening ~48 test bodies. Accepted; but THREE guards were INVERTED (`!==`) and became
   vacuous green tests — QA (test-analyzer MEDIUM) caught them; deleted in 56b3570.
2. **migration-validation.test.ts touched though not in the spec's list** (scope-change,
   forced): it imported JsonlStore for fixture seeding; the builder flagged rather than
   hid it. Correct call — a direct consequence of the delete.
3. **The QA round found a real pre-existing defect the retirement exposed** (fix, from
   review): the TA's LOW ("no fixture feeds a relation with serialized temporal fields")
   was implemented as a test and immediately failed — `migrateFromJsonl`'s insertRel
   dropped relation `created_at`/`superseded_at` (the #87 fix added only valid-time), so
   a superseded relation in a real .jsonl RESURRECTED as active on migration. Fixed +
   pinned (no-resurrection assertion) in 56b3570. Note for the review record: the CR's
   Phase A had rated migration losslessness "verified sound" — its trace covered the
   reader's branches and the entity/observation defaults but not the relation INSERT's
   column list; the empirical test beat the trace, again (the night's recurring theme).
4. **Head-agent additions beyond the spec** (scope, small): five stale "SDK strips
   undeclared keys" comments in index.ts corrected during diff verification (same false
   premise the sweep QA killed; pre-dated the builder), and an end-to-end live probe of
   the composed upgrade path (legacy fixture → sibling .db → migrate → .bak → retirement
   throw) run through the compiled dist before commit.
