# Overnight Backlog Sweep (v1.5.0) — Plan

> Dustin (2026-07-04 02:03): "Let's go through as much of the backlog as possible
> overnight... work autonomously through the items you think are worth doing from the
> roadmap... fix whatever filed issues you can without my input." Under the standing
> model-economy directive: Fable specs/verifies/decides, Opus implements; specs are
> DECIDED — implementation agents do not relitigate them.

## Status (updated 2026-07-04, ~02:15 PDT)
Phase: starting — triage locked, live-data probe for #59 done (0 Cf chars, 0 collisions
  → v17 re-normalization is a verified no-op on this deployment).
Done: worklist + skip-list decided (below).
Next: #59 (Opus build), then #81 harness, #79/#80, polish items, sweep QA, close-out.
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
(appended per item at close)
