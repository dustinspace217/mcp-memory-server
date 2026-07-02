#!/bin/bash
# test-retry-queue.sh — sandboxed tests for the memory retry queue.
#
# Everything runs against a THROWAWAY sandbox: MQ_ROOT + MQ_LOGFILE point into
# a mktemp dir, HOME is redirected there for the producer tests, and `claude`
# is a fake shim on PATH — no real queue jobs execute, no real logs are
# touched, no real model spawns (QA 2026-07-02: the first mechanics test ran
# against the LIVE queue; the MQ_ROOT/MQ_LOGFILE seams exist for this file).
#
# Covers: worker mechanics (enqueue atomicity, backoff, not-due skip, success
# dequeue, give-up + loud FAIL line, TTL expiry, per-job timeout, corrupted
# meta resilience, label dedup) and the two highest-risk PRODUCER paths
# (pre-compact-agent.sh and sessionend-save.sh enqueue-on-failure), asserted
# down to the payload contents.
#
# Run:  bash harness/tests/test-retry-queue.sh     (from the repo root)
#
# shellcheck disable=SC2319  # `[ cond ]; check "desc" $?` is this harness's
# deliberate assertion idiom — the $? IS the condition's result by design,
# which is exactly what SC2319 warns might be unintended.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS="$REPO/harness/hooks"

SANDBOX="$(mktemp -d /tmp/claude/mq-test-XXXXXX 2>/dev/null || mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

export MQ_ROOT="$SANDBOX/queue"
export MQ_LOGFILE="$SANDBOX/hook-execution.log"
LIB="$HOOKS/memory-queue-lib.sh"
WORKER="$HOOKS/memory-retry-worker.sh"

PASS=0; FAIL=0
check() { # check DESC RC
    if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: $1";
    else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}

# shellcheck disable=SC1090
source "$LIB"

# ── Worker mechanics ─────────────────────────────────────────────────────

# 1: failing job gets backoff, not removed
STAGE=$(mq_new_staging "t-fail")
printf '#!/bin/bash\nexit 1\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30
JOB1="$MQ_ROOT/jobs/$(basename "$STAGE")"
[ -d "$JOB1" ]; check "enqueue publishes job atomically" $?
bash "$WORKER"
[ -d "$JOB1" ]; check "failed job stays queued" $?
# shellcheck disable=SC1091
source "$JOB1/meta"
[ "$ATTEMPTS" -eq 1 ]; check "attempts incremented" $?
NOW=$(date +%s)
[ "$NEXT_AFTER" -gt "$NOW" ] && [ "$NEXT_AFTER" -le $((NOW + 901)) ]; check "backoff ~15min set" $?

# 2: not-due job skipped on next tick
bash "$WORKER"
# shellcheck disable=SC1091
source "$JOB1/meta"
[ "$ATTEMPTS" -eq 1 ]; check "not-due job untouched" $?

# 3: due job that succeeds is removed
printf '#!/bin/bash\nexit 0\n' > "$JOB1/job.sh"; chmod +x "$JOB1/job.sh"
sed -i 's/^NEXT_AFTER=.*/NEXT_AFTER=0/' "$JOB1/meta"
bash "$WORKER"
[ ! -d "$JOB1" ]; check "successful job dequeued" $?

# 4: attempts give-up path is LOUD (FAIL line) and moves to failed/
STAGE=$(mq_new_staging "t-giveup")
printf '#!/bin/bash\nexit 1\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30
JOB2="$MQ_ROOT/jobs/$(basename "$STAGE")"
sed -i 's/^ATTEMPTS=.*/ATTEMPTS=24/; s/^NEXT_AFTER=.*/NEXT_AFTER=0/' "$JOB2/meta"
bash "$WORKER"
[ ! -d "$JOB2" ] && [ -d "$MQ_ROOT/failed/$(basename "$STAGE")" ]; check "exhausted job moved to failed/" $?
grep -q "RetryQueue | FAIL: job .*t-giveup.* gave up" "$MQ_LOGFILE"; check "give-up logs a FAIL line (loud, never silent)" $?

# 5: TTL give-up path (age, not attempts)
STAGE=$(mq_new_staging "t-ttl")
printf '#!/bin/bash\nexit 1\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30
JOB3="$MQ_ROOT/jobs/$(basename "$STAGE")"
EIGHT_DAYS_AGO=$(( $(date +%s) - 8 * 24 * 3600 ))
sed -i "s/^CREATED=.*/CREATED=$EIGHT_DAYS_AGO/; s/^NEXT_AFTER=.*/NEXT_AFTER=0/" "$JOB3/meta"
bash "$WORKER"
[ -d "$MQ_ROOT/failed/$(basename "$STAGE")" ]; check "TTL-expired job moved to failed/" $?

# 6: per-job timeout kills a runaway and backs off
STAGE=$(mq_new_staging "t-timeout")
printf '#!/bin/bash\nsleep 60\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 2
JOB4="$MQ_ROOT/jobs/$(basename "$STAGE")"
T0=$(date +%s); bash "$WORKER"; T1=$(date +%s)
[ $((T1 - T0)) -lt 30 ]; check "runaway job killed by per-job timeout" $?
# shellcheck disable=SC1091
source "$JOB4/meta"
[ "$ATTEMPTS" -eq 1 ]; check "timed-out job backs off for retry" $?
rm -rf "$JOB4"

# 7: corrupted meta doesn't kill the tick — healthy siblings still run
STAGE=$(mq_new_staging "t-corrupt")
printf '#!/bin/bash\nexit 1\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30
JOBC="$MQ_ROOT/jobs/$(basename "$STAGE")"
printf '(!!$ not shell &&\n' > "$JOBC/meta"
STAGE=$(mq_new_staging "t-healthy")
printf '#!/bin/bash\nexit 0\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30
JOBH="$MQ_ROOT/jobs/$(basename "$STAGE")"
bash "$WORKER"; rc=$?
[ "$rc" -eq 0 ] && [ ! -d "$JOBH" ]; check "corrupt meta doesn't kill the tick (healthy job still ran)" $?
rm -rf "$JOBC"

# 8: label dedup helper
STAGE=$(mq_new_staging "t-dedup")
printf '#!/bin/bash\nexit 0\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30
mq_has_job "t-dedup"; check "mq_has_job finds pending label" $?
if mq_has_job "no-such-label"; then false; else true; fi
check "mq_has_job misses absent label" $?
rm -rf "$MQ_ROOT/jobs/"*t-dedup*

# ── Producer: pre-compact-agent.sh enqueue-on-failure ────────────────────
# Sandboxed HOME + a fake `claude` that fails → the hook must (a) still emit
# fallback instructions on stdout, (b) enqueue a self-contained replay job
# with the -retry session suffix and the persisted excerpt.

export HOME="$SANDBOX/home"
mkdir -p "$HOME/.claude/hooks" "$HOME/Claude" "$SANDBOX/bin"
cp "$HOOKS/pre-compact-agent.sh" "$HOOKS/sessionend-save.sh" \
   "$HOOKS/memory-queue-lib.sh" "$HOOKS/precompact-prompt.md" \
   "$HOOKS/sessionend-prompt.md" "$HOME/.claude/hooks/"
printf '#!/bin/bash\nexit 1\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"
export PATH="$SANDBOX/bin:$PATH"
unset CLAUDE_LIFECYCLE_AGENT || true

TRANSCRIPT="$SANDBOX/transcript.jsonl"
for i in $(seq 1 12); do echo "{\"line\":$i}"; done > "$TRANSCRIPT"

HOOK_STDOUT=$(printf '{"transcript_path":"%s","cwd":"%s","session_id":"tsess1","trigger":"auto"}' \
    "$TRANSCRIPT" "$HOME/Claude" | bash "$HOME/.claude/hooks/pre-compact-agent.sh")
[ -n "$HOOK_STDOUT" ]; check "precompact: instructions still reach stdout on failure" $?

PJOB=$(echo "$MQ_ROOT/jobs/"*precompact-save*)
[ -d "$PJOB" ]; check "precompact: failure enqueued a replay job" $?
grep -q -- "tsess1-retry" "$PJOB/prompt.txt" 2>/dev/null; check "precompact: prompt carries the -retry session suffix" $?
if grep -q "{{" "$PJOB/prompt.txt" 2>/dev/null; then false; else true; fi
check "precompact: no unsubstituted placeholders in prompt" $?
# The excerpt path must be the @@EXCERPT@@ run-time token, NOT a baked path:
# mq_enqueue moves the job dir, so any path baked at staging time dangles
# (real bug this test caught on its first run — see the producers' comments).
grep -q "@@EXCERPT@@" "$PJOB/prompt.txt" 2>/dev/null; check "precompact: prompt carries the run-time excerpt token" $?
[ -s "$PJOB/excerpt.jsonl" ]; check "precompact: excerpt persisted into the job" $?
[ "$(cat "$PJOB/cwd" 2>/dev/null)" = "$HOME/Claude" ]; check "precompact: cwd payload recorded" $?
[ -x "$PJOB/job.sh" ]; check "precompact: job.sh is executable" $?
grep -q "^ATTEMPTS=0$" "$PJOB/meta" 2>/dev/null; check "precompact: meta initialized" $?

# ── Producer: sessionend-save.sh enqueue-on-failure ──────────────────────
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess2" "$TRANSCRIPT" "$HOME/Claude"
SJOB=$(echo "$MQ_ROOT/jobs/"*sessionend-save*)
[ -d "$SJOB" ]; check "sessionend: failure enqueued a replay job" $?
# NOTE: sessionend-prompt.md contains no {{SESSION_ID}} placeholder (its
# outputs aren't session-scoped files, unlike precompact's), so there is no
# -retry marker to assert — the enqueue's SESSION_ID sed line is a harmless
# no-op kept for symmetry. What matters: full substitution + payload present.
if grep -q "{{" "$SJOB/prompt.txt" 2>/dev/null; then false; else true; fi
check "sessionend: no unsubstituted placeholders in prompt" $?
grep -q "@@EXCERPT@@" "$SJOB/prompt.txt" 2>/dev/null; check "sessionend: prompt carries the run-time excerpt token" $?
[ -s "$SJOB/excerpt.jsonl" ]; check "sessionend: excerpt persisted into the job" $?

# ── E2E replay: worker resolves the token to the MOVED job's excerpt ─────
# Swap the shim for a capturing success stub and run the real worker over the
# two producer jobs. Pins the whole chain: enqueue → move → job.sh run-time
# substitution → claude stdin references a path that actually exists.
printf '#!/bin/bash\ncat >> "%s/replay-stdin.txt"\nexit 0\n' "$SANDBOX" > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"
bash "$WORKER"
grep -q -- "$SJOB/excerpt.jsonl" "$SANDBOX/replay-stdin.txt" 2>/dev/null; check "replay: sessionend prompt resolves to the moved excerpt path" $?
grep -q -- "$PJOB/excerpt.jsonl" "$SANDBOX/replay-stdin.txt" 2>/dev/null; check "replay: precompact prompt resolves to the moved excerpt path" $?
[ ! -d "$SJOB" ] && [ ! -d "$PJOB" ]; check "replay: successful jobs dequeued" $?

echo "---"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
