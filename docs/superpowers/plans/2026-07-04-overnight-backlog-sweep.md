# Overnight Backlog Sweep (v1.5.0) — Plan

> Dustin (2026-07-04 02:03): "Let's go through as much of the backlog as possible
> overnight... work autonomously through the items you think are worth doing from the
> roadmap... fix whatever filed issues you can without my input." Under the standing
> model-economy directive: Fable specs/verifies/decides, Opus implements; specs are
> DECIDED — implementation agents do not relitigate them.

## Status (updated 2026-07-04, ~04:15 PDT)
Phase: COMPLETE — all 8 worklist items + the DEF-RR-04 stretch item shipped; v1.5.0.
Done: commits 9f9a4ad (#81), b762e19 (#59/v17), e736287 (#79+#80), 9c34fee (#20 audit
  + polish), f95bcc9 (DEF-RR-04 — 3 real races found+fixed), 3b07cb6 (docs+version),
  a7ef977 (sweep-QA fixes). Issues #59/#79/#80/#81/#20 closed. QA thread: Discussion #90.
  741 tests / 18 files green (Pool 1 726 + Pool 2 15).
Next: nothing in this plan — deploy note: live memory.db is already v16+granite from an
  earlier 2026-07-04 session; the next server restart applies only v17 (verified no-op).
Blocked: nothing.

## Worklist (in order)
1. **#59** — Unicode Format (Cf) stripping in `normalizeEntityName` + v17 re-normalization
   migration (v8 collision-check pattern over entities + relation endpoints). DECIDED
   design: strip `\p{Cf}` in a dedicated step after NFC, before lowercase/separators;
   C0 strip and the char(31) guarantee unchanged; collision → abort with both display
   forms (v8 precedent). Live no-op verified by probe.
2. **#81** — in-process McpServer test harness (SDK `InMemoryTransport` linked pair),
   exercising REAL registered tools + production Zod output schemas. First cases: the
   two findings folded from Discussion #89 (L1Index output-schema declaration pin;
   summary Zod binding pin), plus rankingDegraded/rankingUnavailable declaration pins
   (same stripped-key class).
3. **#79** — sourceInstance test suite (v9→v10 forward test, round-trips, timeline/
   layers/summary output, supersede-uses-current-instance, stale comments).
4. **#80** — sourceInstance resolution: trim + single shared cached constant; remove
   the dead per-call env read in `createObservation()`.
5. **#20** — JSDoc audit against the April list (post-refactor: verify which of the 8
   remain undocumented; write only what's missing; apply the also-improve notes that
   still exist).
6. Test-artifact leak fix (__tests__/ debris: find the tests missing cleanup, fix,
   delete debris).
7. Harness polish: remove inert `MAX_THINKING_TOKENS` + `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`
   from consolidation-settings.json (pending since 2026-06-05); sync
   settings.hooks.example.json with the live hooks block (PreCompact 480 etc.);
   README currency pass for v1.4/1.5.
8. Sweep QA: slim Opus pair (code-reviewer + test-analyzer) over the whole diff,
   findings applied, Discussion thread, issues closed, version 1.5.0, docs.
9. (Stretch, only if the night allows) DEF-RR-04 two-connection migration race harness.

## Skipped deliberately (Dustin-gated or anti-bloat — NOT silently dropped)
- **Auto-capture**: his explicitly-held decision since 2026-06-05; recommendation
  (timer worker, not daemon) already delivered. Not built without his go.
- **Observation decay** (competitive review #4): changes live recall behavior; wants
  an evaluation gate like rerank got, and v1.3.0's activation signal already covers
  recency-weighting in relevance mode. Needs his eyes, not an overnight ship.
- **Relation rationale field**: fails the anti-bloat practical-use test today (causal
  vocabulary + observation prose already carry the why; a per-edge column adds write
  friction). Noted for future re-evaluation.
- **#53** (alias graph): design-locked by its own issue. **#30 residual**: perf-only at
  current scale (annotated on the issue 2026-07-02). **DEF-CG-01/02, DEF-RR-01/03**:
  open-by-design conditions unmet.

## Deviation log
Classified per the Post-Phase Deviation Summary convention.

1. **#80 design flipped mid-build: per-call resolver, not a cached constant**
   (behavioral-change, deliberate). The plan said "single shared cached constant";
   shipped `resolveSourceInstance()` reads the env PER CALL. Reason: a module-level
   const freezes at import time, which breaks `vi.stubEnv`-based tests without
   `resetModules` gymnastics and would silently ignore an env change on a long-lived
   process. Per-call cost is one string read; the tests pin the per-call behavior.
2. **#20 resolved as an audit, not a build** (scope-change, honest-premise). All 8
   listed functions already carried JSDoc after intervening refactors; the assigned
   Opus agent correctly refused to invent work and said so. Shipped the adjacent real
   gap instead (README currency + harness config hygiene, 9c34fee).
3. **Item 6 (test-artifact debris) resolved as crash-orphan cleanup** (scope-change,
   same honest-premise shape). The debris traced to interrupted runs (usage-limit
   kills), not to tests missing cleanup — every current test has afterEach unlink
   discipline. Deleted the orphans; no code change warranted.
4. **DEF-RR-04 stretch item became the night's largest work item** (scope-change,
   upward). Budgeted as "only if the night allows"; ran three find-fix-rehammer
   layers: (L1) busy_timeout set after lock-taking pragmas — reordered; (L2) legacy
   v2–v10 migrations predate the house race rules — full retrofit (IMMEDIATE +
   in-transaction version re-check + duplicate-tolerant ALTERs + INSERT OR IGNORE
   version seeding with authoritative re-read); (L3) delete→WAL journal-mode
   conversion bypasses the busy handler (SQLITE_BUSY immediate, ~13%/run residual) —
   bounded 20×100ms retry. 48 consecutive races clean after L3. Three prior
   trace-based review lenses had cleared all three — the empirical harness earned
   its cost in one night.
5. **Sweep QA corrected a build-time premise the head agent had propagated**
   (behavioral-change, from review). The #81 harness was built on opus-81's claim
   that the SDK strips undeclared structuredContent keys; qa-sweep-ta's HIGH said
   false, and an SDK source read + empirical InMemoryTransport probe CONFIRMED the
   TA (validateToolOutput throws-on-failure but forwards the original result
   unmodified). Cases (a)/(c) were re-anchored on the tools/list-advertised
   outputSchema (a7ef977); the false claim was also scrubbed from CLAUDE.md and the
   test header now documents the verified behavior. Note the propagation path: the
   head agent verified opus-81's TESTS passed but not its stated MECHANISM — agent
   claims about runtime behavior need the same one-probe check as my own.
6. **Transient Opus dispatch failure** (other). One opus-race dispatch died on a
   "temporarily unavailable" classifier error; retried after a delay, succeeded.
   No work lost.

## Appendix: Deferments originated in this sweep

- **DEF-SW-01** — Found by: qa-sweep-ta (MEDIUM). Commit: a7ef977 (decision).
  Defer target: indefinite (next race-harness touch). Severity: MEDIUM.
  What: the race suite covers only fresh-DB starts; racing two instances over an
  EXISTING v10/v14 DB through 10→17 (the Issue-#78 deployment shape) is untested.
  Why deferred: the fresh-DB race traverses the same v2–v17 chain including every
  retrofit mechanism; the marginal interleaving differs but the mechanisms under
  test are identical, and seeding a mid-version fixture into the child-process
  harness is real plumbing. Fix direction: third race case seeding a v10 DB
  (reuse migration-validation's fixture builders), then two children.
  Obsolescence: any migration-chain rewrite that drops the legacy blocks.
- **DEF-SW-02** — Found by: qa-sweep-ta (LOW-MEDIUM, residual half). Commit: a7ef977.
  Defer target: indefinite. Severity: LOW.
  What: the WAL-retry loop's error-classification branch (non-"database is locked"
  rethrow; 20-attempt cap) has no deterministic pin — only the ~13-20%/run
  probabilistic race coverage. The busy_timeout=5000 half WAS pinned (a7ef977).
  Why deferred: a deterministic pin needs fault injection into better-sqlite3's
  pragma call; disproportionate for a bounded loop whose failure mode is loud.
  Fix direction: injectable pragma wrapper or a mock-Database seam, if the loop
  ever grows. Obsolescence: better-sqlite3 routing journal-mode conversion
  through the busy handler (upstream change).
