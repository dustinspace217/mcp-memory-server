# JSONL Backend Retirement (v1.6.0) — Plan

> Dustin (2026-07-04, ~04:45 PDT): "Retire JSONL backend." Context: the backend has
> been deprecated since v1.0.0, but every feature since has paid a tax — dual-backend
> implementation or a "throws in JSONL" branch, plus a permanent seat in the
> parameterized test suite. Decision surfaced in the v1.5.0 close-out review of
> project-wide open questions; Dustin ruled retire.

## Status (updated 2026-07-04, ~04:55 PDT)
Phase: 1 of 2 (implementation — Opus builder dispatched with the DECIDED spec below)
Done: decision recorded; scope ruled by the goal hierarchy (see Decisions)
Next: builder report -> head verification (diff read + both test pools) -> slim QA pair -> v1.6.0 bump -> commit
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
(appended at close)
