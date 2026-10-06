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
trap 'rm -rf "$SANDBOX"; rm -f /tmp/claude/*-tsess[0-9]*.jsonl /tmp/claude/sessionend-std*-tsess[0-9]*.txt' EXIT

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
# Every stub records what the queue looked like at the moment claude ran: job dir
# names plus their meta. This is the only honest pin of the write-ahead ORDER
# (a mutant that stages the job AFTER the live run keeps every log line in place;
# QA 2026-10-05, TA-1/TA-2). SESSIONEND_LOCK keeps the harness off the REAL save
# lock so a test never blocks a live save or vice versa (TA-4).
export SESSIONEND_LOCK="$SANDBOX/save.lock"
SNAP="$SANDBOX/snap.txt"
# The stub ALWAYS drains stdin first (real claude reads its prompt from stdin): a stub
# that exits early leaves `sed` writing into a closed pipe, and under pipefail the
# producer's pipeline reports 141 (SIGPIPE) instead of the stub's exit code — seen as a
# load-dependent flake in the yield cell before this line existed.
snapshot_stub() { # snapshot_stub EXIT-CODE [EXTRA-LINE]
    printf '#!/bin/bash\ncat >> "%s/replay-stdin.txt"\n{ echo "== run $(date +%%s) ==" ; ls "$MQ_ROOT/jobs"; cat "$MQ_ROOT"/jobs/*/meta 2>/dev/null; } >> "%s"\n%s\nexit %s\n' \
        "$SANDBOX" "$SNAP" "${2:-:}" "$1" > "$SANDBOX/bin/claude"
    chmod +x "$SANDBOX/bin/claude"
}
snapshot_stub 1
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
[ "$(sed -n 's/^NEXT_AFTER=//p' "$PJOB/meta")" -le "$(date +%s)" ]; check "precompact: enqueue-on-failure job is due now (TA-6)" $?

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
# Write-ahead (2026-10-05): the job is persisted BEFORE the live attempt with a
# 1800 s delay; a FAILED attempt must pull it forward so the next tick runs it.
[ "$(sed -n 's/^NEXT_AFTER=//p' "$SJOB/meta" 2>/dev/null)" -le "$(date +%s)" ] 2>/dev/null; check "sessionend: failed save makes the write-ahead job due now" $?
grep -q "SessionEndSave | STAGED:" "$HOME/.claude/hooks/hook-execution.log" 2>/dev/null; check "sessionend: STAGED line logged before the live save" $?
L_START=$(grep -n "session=tsess2" "$HOME/.claude/hooks/hook-execution.log" | grep "START: helper running" | head -1 | cut -d: -f1)
L_STAGED=$(grep -n "session=tsess2" "$HOME/.claude/hooks/hook-execution.log" | grep "STAGED:" | head -1 | cut -d: -f1)
[ -n "$L_START" ] && [ -n "$L_STAGED" ] && [ "$L_START" -lt "$L_STAGED" ]; check "sessionend: START line precedes STAGED (SLA-3, order pinned)" $?
# Order pin (TA-1): the stub's snapshot must show a sessionend-save job at claude-run time,
# and (TA-2) its NEXT_AFTER must carry the re-armed delay (> now+500 with the 600 s default).
grep -q "sessionend-save" "$SNAP" 2>/dev/null; check "writeahead: job existed when claude ran (failure path, TA-1)" $?
SNAP_NA=$(grep -h "^NEXT_AFTER=" "$SNAP" | tail -1 | cut -d= -f2)
[ -n "$SNAP_NA" ] && [ "$SNAP_NA" -gt $(( $(date +%s) + 500 )) ]; check "writeahead: delay in force at claude-run time (TA-2)" $?
grep -q "REPLAY NOTE" "$SJOB/prompt.txt" 2>/dev/null; check "writeahead: replay prompt carries the [replay] marker (SFH-5)" $?
grep -q "flock -n" "$SJOB/job.sh" 2>/dev/null; check "writeahead: job.sh yields to a live save (flock -n)" $?

# ── E2E replay: worker resolves the token to the MOVED job's excerpt ─────
# Swap the shim for a capturing success stub and run the real worker over the
# two producer jobs. Pins the whole chain: enqueue → move → job.sh run-time
# substitution → claude stdin references a path that actually exists.
snapshot_stub 0 "cat >> \"$SANDBOX/replay-stdin.txt\""
bash "$WORKER"
[ "$(cat "$MQ_ROOT/last-save/tsess2" 2>/dev/null)" = "$(sha256sum <(tail -300 "$TRANSCRIPT") | cut -d' ' -f1)" ]; check "replay: successful replay records the excerpt HASH (SFH-4, content pinned)" $?
grep -q -- "$SJOB/excerpt.jsonl" "$SANDBOX/replay-stdin.txt" 2>/dev/null; check "replay: sessionend prompt resolves to the moved excerpt path" $?
grep -q -- "$PJOB/excerpt.jsonl" "$SANDBOX/replay-stdin.txt" 2>/dev/null; check "replay: precompact prompt resolves to the moved excerpt path" $?
[ ! -d "$SJOB" ] && [ ! -d "$PJOB" ]; check "replay: successful jobs dequeued" $?

# ── Write-ahead success path: live save wins → replay job cancelled ──────
# Still on the success stub. The helper must stage a job, run the save, and
# remove the job again, leaving nothing for the worker to replay twice.
SNAP_BEFORE=$(grep -c "^== run" "$SNAP")
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess3" "$TRANSCRIPT" "$HOME/Claude"
HLOG="$HOME/.claude/hooks/hook-execution.log"
# TA-3: assert on THIS session's queue id, not on an empty directory.
QID3=$(grep "session=tsess3" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
[ -n "$QID3" ] && [ ! -d "$MQ_ROOT/jobs/$QID3" ]; check "writeahead: successful save cancels ITS replay job (TA-3)" $?
grep -q "session=tsess3" <<< "$(grep "SessionEndSave | OK: save completed; replay job cancelled (queue=$QID3)" "$HLOG")"; check "writeahead: OK line names the cancelled job (SLA-2)" $?
if grep "session=tsess3" "$HLOG" | grep -q -E "QUEUED|WARN"; then false; else true; fi
check "writeahead: no QUEUED/WARN for a clean success (TA-3)" $?
grep -q "transcript-excerpt-tsess3.jsonl" "$SANDBOX/replay-stdin.txt" 2>/dev/null; check "writeahead: live save ran with the live excerpt" $?
[ "$(grep -c "^== run" "$SNAP")" -eq $(( SNAP_BEFORE + 1 )) ] && tail -n +"$(grep -n "^== run" "$SNAP" | tail -1 | cut -d: -f1)" "$SNAP" | grep -q "$QID3"
check "writeahead: job existed when claude ran (success path, TA-1)" $?
[ "$(cat "$MQ_ROOT/last-save/tsess3" 2>/dev/null)" = "$(sha256sum <(tail -300 "$TRANSCRIPT") | cut -d' ' -f1)" ]; check "writeahead: live success records the excerpt hash (SFH-4)" $?

# ── Hash-skip: an unchanged excerpt is not re-saved; a changed one is ────
SNAP_BEFORE=$(grep -c "^== run" "$SNAP")
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess3" "$TRANSCRIPT" "$HOME/Claude"
grep -q "session=tsess3" <<< "$(grep "SessionEndSave | SKIP: excerpt unchanged" "$HLOG")"; check "hash-skip: unchanged excerpt logs SKIP (SFH-4)" $?
[ "$(grep -c "^== run" "$SNAP")" -eq "$SNAP_BEFORE" ]; check "hash-skip: unchanged excerpt runs no claude and stages no job" $?
if ls "$MQ_ROOT/jobs/"*sessionend-save* >/dev/null 2>&1; then false; else true; fi
check "hash-skip: no job left behind by the skip" $?
echo '{"line":13}' >> "$TRANSCRIPT"
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess3" "$TRANSCRIPT" "$HOME/Claude"
[ "$(grep -c "^== run" "$SNAP")" -eq $(( SNAP_BEFORE + 1 )) ]; check "hash-skip: changed excerpt saves again" $?

# ── Lib absent: write-ahead disabled LOUDLY (SFH-1) ──────────────────────
mv "$HOME/.claude/hooks/memory-queue-lib.sh" "$SANDBOX/lib-aside.sh"
snapshot_stub 1
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess4" "$TRANSCRIPT" "$HOME/Claude"
grep "session=tsess4" "$HLOG" | grep -q "WARN: queue lib missing"; check "lib-absent: WARN that write-ahead is disabled (SFH-1)" $?
grep "session=tsess4" "$HLOG" | grep -q "WARN: save failed and no replay job was staged"; check "lib-absent: failed save says the tail is lost" $?
if ls "$MQ_ROOT/jobs/"*sessionend-save* >/dev/null 2>&1; then false; else true; fi
check "lib-absent: nothing enqueued" $?
mv "$SANDBOX/lib-aside.sh" "$HOME/.claude/hooks/memory-queue-lib.sh"

# ── Kill cell (a): helper killed while waiting for the lock (the incident) ──
# Pre-hold the sandbox lock, launch the helper, wait (bounded) for STAGED, SIGKILL it,
# release the lock. The job must be on disk, carrying its delay, with no outcome line;
# then a make_due + worker tick must replay it from the moved excerpt (TA-4a).
exec 7>"$SESSIONEND_LOCK"; flock 7
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess5" "$TRANSCRIPT" "$HOME/Claude" &
HPID=$!
for _ in $(seq 1 40); do grep "session=tsess5" "$HLOG" 2>/dev/null | grep -q STAGED && break; sleep 0.25; done
kill -9 "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null
flock -u 7
QID5=$(grep "session=tsess5" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
[ -n "$QID5" ] && [ -d "$MQ_ROOT/jobs/$QID5" ]; check "kill-a: job survives a SIGKILL during the lock wait" $?
[ "$(sed -n 's/^NEXT_AFTER=//p' "$MQ_ROOT/jobs/$QID5/meta")" -gt $(( $(date +%s) + 500 )) ]; check "kill-a: killed helper's job keeps its staging delay" $?
if grep "session=tsess5" "$HLOG" | grep -q -E "OK:|FAIL:|QUEUED:"; then false; else true; fi
check "kill-a: no outcome line (the silent shape the queue now covers)" $?
snapshot_stub 0 "cat >> \"$SANDBOX/replay-stdin.txt\""
mq_make_due "$MQ_ROOT/jobs/$QID5"
bash "$WORKER"
grep -q -- "$MQ_ROOT/jobs/$QID5/excerpt.jsonl" "$SANDBOX/replay-stdin.txt"; check "kill-a: worker replays the killed save from the moved excerpt" $?
[ ! -d "$MQ_ROOT/jobs/$QID5" ]; check "kill-a: replayed job dequeued" $?

# ── Kill cell (c): helper dies between claude exit 0 and mq_cancel (TA-4c) ──
# The stub kills its grandparent (the helper; its parent is `timeout`) and exits 0.
# The stub's parent is `timeout`, its grandparent the helper (bash forks each pipeline
# element and the child execs the command directly). The walk kills every ancestor
# whose cmdline is the helper script, so it is robust to either process shape. The
# stub writes a "committed" marker first: what this cell pins is that a kill landing
# AFTER the save's output exists but BEFORE the helper's bookkeeping leaves a replay
# job on disk (STA-9/XFA-6: the precise exit-0-to-cancel instant cannot be hit from
# outside; the hash check in job.sh makes that window a no-op replay, see below).
snapshot_stub 0 'echo committed > "$SNAPDIR/committed-tsess6"; p=$PPID; while [ "$p" -gt 1 ]; do tr "\\0" " " < /proc/$p/cmdline 2>/dev/null | grep -q sessionend-save.sh && kill -9 $p; p=$(ps -o ppid= -p $p 2>/dev/null | tr -d " "); [ -n "$p" ] || break; done'
export SNAPDIR="$SANDBOX"
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess6" "$TRANSCRIPT" "$HOME/Claude" 2>/dev/null
QID6=$(grep "session=tsess6" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
[ -f "$SANDBOX/committed-tsess6" ] && [ -n "$QID6" ] && [ -d "$MQ_ROOT/jobs/$QID6" ]; check "kill-c: save output committed, helper killed before cancel, replay job survives" $?
if grep "session=tsess6" "$HLOG" | grep -q "OK:"; then false; else true; fi
check "kill-c: no OK line when the helper died before logging" $?
[ -n "$QID6" ] && rm -rf "$MQ_ROOT/jobs/$QID6"

# ── Skip-if-gone: the worker consumed the job while the helper waited ────
snapshot_stub 0
SNAP_BEFORE=$(grep -c "^== run" "$SNAP")
exec 7>"$SESSIONEND_LOCK"; flock 7
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess7" "$TRANSCRIPT" "$HOME/Claude" &
HPID=$!
for _ in $(seq 1 40); do grep "session=tsess7" "$HLOG" 2>/dev/null | grep -q STAGED && break; sleep 0.25; done
QID7=$(grep "session=tsess7" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
[ -n "$QID7" ] && rm -rf "$MQ_ROOT/jobs/$QID7"          # simulate: worker replayed and dequeued it
flock -u 7; wait "$HPID" 2>/dev/null
grep "session=tsess7" "$HLOG" | grep -q "SKIP: replay job already consumed"; check "skip-if-gone: live save skipped when the replay already ran (CR-1/SLA-1)" $?
[ "$(grep -c "^== run" "$SNAP")" -eq "$SNAP_BEFORE" ]; check "skip-if-gone: no live claude run" $?

# ── Yield: a due replay job does not run beside a live save (flock -n in job.sh) ──
snapshot_stub 1
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess8" "$TRANSCRIPT" "$HOME/Claude"   # fails -> job due now
QID8=$(grep "session=tsess8" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
exec 7>"$SESSIONEND_LOCK"; flock 7
snapshot_stub 0
bash "$WORKER"
flock -u 7
[ -d "$MQ_ROOT/jobs/$QID8" ] && grep "$QID8" "$MQ_LOGFILE" | grep -q "INFO: job .* yielded to a live save"; check "yield: replay exits 75 and stays queued while a live save holds the lock" $?
grep -q "^ATTEMPTS=0$" "$MQ_ROOT/jobs/$QID8/meta"; check "yield: a yield does not count as an attempt (XFK-6)" $?
NA8=$(sed -n 's/^NEXT_AFTER=//p' "$MQ_ROOT/jobs/$QID8/meta"); NOW=$(date +%s)
[ "$NA8" -gt $(( NOW + 200 )) ] && [ "$NA8" -le $(( NOW + 300 )) ]; check "yield: deferred ~5 min, not backed off" $?
sed -i 's/^NEXT_AFTER=.*/NEXT_AFTER=0/' "$MQ_ROOT/jobs/$QID8/meta"
bash "$WORKER"
[ ! -d "$MQ_ROOT/jobs/$QID8" ]; check "yield: replay runs once the lock is free" $?

# ── Re-arm: delay measured from the lock, not from staging (CR-1/SLA-1) ──
# Hold the lock 3 s with a 1 s delay: without the re-arm the snapshot would show a
# NEXT_AFTER already in the past when claude ran.
export SESSIONEND_WRITEAHEAD_DELAY=2
snapshot_stub 0
exec 7>"$SESSIONEND_LOCK"; flock 7
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess9" "$TRANSCRIPT" "$HOME/Claude" &
HPID=$!
for _ in $(seq 1 40); do grep "session=tsess9" "$HLOG" 2>/dev/null | grep -q STAGED && break; sleep 0.25; done
QID9=$(grep "session=tsess9" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
NA_STAGED=$(sed -n 's/^NEXT_AFTER=//p' "$MQ_ROOT/jobs/$QID9/meta")
# Hold the lock until the STAGED deadline has passed, so a missing re-arm would leave
# NEXT_AFTER in the past at claude-run time (STA-5: a delta, not a timing inference).
while [ "$(date +%s)" -le "$NA_STAGED" ]; do sleep 0.25; done
T_RELEASE=$(date +%s); flock -u 7; wait "$HPID" 2>/dev/null
SNAP_NA=$(grep -h "^NEXT_AFTER=" "$SNAP" | tail -1 | cut -d= -f2)
[ -n "$SNAP_NA" ] && [ "$SNAP_NA" -gt "$NA_STAGED" ] && [ "$SNAP_NA" -ge "$T_RELEASE" ] && [ "$SNAP_NA" -le $(( T_RELEASE + 2 + 2 )) ]
check "re-arm: NEXT_AFTER re-stamped from the lock acquisition with the seam's delay" $?
unset SESSIONEND_WRITEAHEAD_DELAY

# ── XFK-1: a replay whose live save already completed is a no-op (hash check in job.sh) ──
snapshot_stub 1
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess10" "$TRANSCRIPT" "$HOME/Claude"   # fails -> due job
QID10=$(grep "session=tsess10" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
mkdir -p "$MQ_ROOT/last-save"; sha256sum <(tail -300 "$TRANSCRIPT") | cut -d' ' -f1 > "$MQ_ROOT/last-save/tsess10"
SNAP_BEFORE=$(grep -c "^== run" "$SNAP")
snapshot_stub 0
bash "$WORKER"
[ ! -d "$MQ_ROOT/jobs/$QID10" ] && [ "$(grep -c "^== run" "$SNAP")" -eq "$SNAP_BEFORE" ]; check "xfk-1: replay skips claude and dequeues when the live save already recorded this excerpt" $?

# ── XFA-1: replay must create the lock's parent dir (a reboot erases /tmp/claude) ──
echo '{"line":16}' >> "$TRANSCRIPT"
SAVED_LOCK="$SESSIONEND_LOCK"; export SESSIONEND_LOCK="$SANDBOX/not-yet/lock"
snapshot_stub 1
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess14" "$TRANSCRIPT" "$HOME/Claude"   # stages job.sh with the new lock path, fails -> due
QID14=$(grep "session=tsess14" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
rm -rf "$SANDBOX/not-yet"                      # the parent is gone when the replay runs
snapshot_stub 0
bash "$WORKER"
[ -n "$QID14" ] && [ ! -d "$MQ_ROOT/jobs/$QID14" ] && [ -e "$SANDBOX/not-yet/lock" ]; check "xfa-1: replay creates the lock dir and succeeds when /tmp/claude is absent" $?
export SESSIONEND_LOCK="$SAVED_LOCK"

# ── XFA-3/XFK-3: .done marker closes the replay-exit -> dequeue gap ──
STAGE=$(mq_new_staging "t-done"); printf '#!/bin/bash\nexit 0\n' > "$STAGE/job.sh"; mq_enqueue "$STAGE" 30
DONEJOB="$MQ_LAST_JOB"
mq_job_present "$DONEJOB"; check "done-marker: job without marker is present" $?
touch "$DONEJOB/.done"
if mq_job_present "$DONEJOB"; then false; else true; fi
check "done-marker: a completed job reads as consumed before the worker removes it (XFA-3/XFK-3)" $?
rm -rf "$DONEJOB"

# ── job.sh writes the .done marker itself on success (run it directly: the worker would rm the dir) ──
echo '{"line":17}' >> "$TRANSCRIPT"
snapshot_stub 1
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess15" "$TRANSCRIPT" "$HOME/Claude"   # fails -> due job
QID15=$(grep "session=tsess15" "$HLOG" | grep -o "STAGED: .*queue=[^)]*" | sed 's/.*queue=//')
snapshot_stub 0
bash "$MQ_ROOT/jobs/$QID15/job.sh" >/dev/null 2>&1
[ -n "$QID15" ] && [ -e "$MQ_ROOT/jobs/$QID15/.done" ]; check "done-marker: job.sh marks itself done on success (XFA-3/XFK-3)" $?
[ "$(cat "$MQ_ROOT/last-save/tsess15" 2>/dev/null)" = "$(sha256sum <(tail -300 "$TRANSCRIPT") | cut -d' ' -f1)" ]; check "done-marker: job.sh records the excerpt hash on success" $?
rm -rf "$MQ_ROOT/jobs/$QID15"

# ── STA-3: the three producer branches that only execute when the job vanishes mid-run ──
# (a) success, job gone -> OK "already gone — may have written a duplicate"
snapshot_stub 0 'rm -rf "$MQ_ROOT"/jobs/*sessionend-save*'
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess11" "$TRANSCRIPT" "$HOME/Claude"
grep "session=tsess11" "$HLOG" | grep -q "OK: save completed; replay job was already gone"; check "sta-3a: success with a vanished job logs the possible duplicate" $?
# (b) failure, job gone -> WARN "already gone — the worker replayed it"
echo '{"line":14}' >> "$TRANSCRIPT"
snapshot_stub 1 'rm -rf "$MQ_ROOT"/jobs/*sessionend-save*'
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess12" "$TRANSCRIPT" "$HOME/Claude"
grep "session=tsess12" "$HLOG" | grep -q "WARN: save failed but the replay job is already gone"; check "sta-3b: failure with a vanished job says the worker replayed it" $?
# (c) success, cancel fails -> WARN "could not be removed"
echo '{"line":15}' >> "$TRANSCRIPT"
snapshot_stub 0 'chmod a-w "$MQ_ROOT/jobs"'
bash "$HOME/.claude/hooks/sessionend-save.sh" "tsess13" "$TRANSCRIPT" "$HOME/Claude" 2>/dev/null
chmod u+w "$MQ_ROOT/jobs"
grep "session=tsess13" "$HLOG" | grep -q "WARN: save completed but the replay job could not be removed"; check "sta-3c: a failed cancel is a WARN, not a false OK" $?
rm -rf "$MQ_ROOT"/jobs/*sessionend-save*

# ── Lib: initial delay + cancel + make_due ───────────────────────────────
STAGE=$(mq_new_staging "t-delay"); printf '#!/bin/bash\nexit 0\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30 1800
DJOB="$MQ_ROOT/jobs/$(basename "$STAGE")"
NA=$(sed -n 's/^NEXT_AFTER=//p' "$DJOB/meta"); NOW=$(date +%s)
[ "$NA" -gt $(( NOW + 1700 )) ] && [ "$NA" -le $(( NOW + 1800 )) ]; check "lib: initial delay sets NEXT_AFTER ~1800 s ahead" $?
bash "$WORKER"
[ -d "$DJOB" ]; check "lib: delayed job is skipped by the worker (not due)" $?
mq_defer "$DJOB" 300
NA=$(sed -n 's/^NEXT_AFTER=//p' "$DJOB/meta"); NOW=$(date +%s)
[ "$NA" -gt $(( NOW + 290 )) ] && [ "$NA" -le $(( NOW + 300 )) ]; check "lib: mq_defer re-stamps NEXT_AFTER from now" $?
mq_make_due "$DJOB"
NA=$(sed -n 's/^NEXT_AFTER=//p' "$DJOB/meta"); NOW=$(date +%s)
[ "$NA" -le "$NOW" ] && [ "$NA" -gt $(( NOW - 5 )) ]; check "lib: mq_make_due stamps the job due NOW (not a literal 0; XFA-4)" $?
mq_job_present "$DJOB"; check "lib: mq_job_present sees a live job" $?
# rm failure must be REPORTED (CR-3): make the jobs dir read-only so rm -rf fails.
chmod a-w "$MQ_ROOT/jobs"
if mq_cancel "$DJOB"; then false; else true; fi
check "lib: mq_cancel returns nonzero when the job could not be removed (CR-3)" $?
chmod u+w "$MQ_ROOT/jobs"
mq_cancel "$DJOB"
[ ! -d "$DJOB" ]; check "lib: mq_cancel removes the job" $?
mq_cancel "$DJOB"; check "lib: mq_cancel is idempotent on a missing dir" $?
mq_cancel ""; check "lib: mq_cancel tolerates an empty path" $?
if mq_make_due "$DJOB"; then false; else true; fi
check "lib: mq_make_due reports a consumed job (CR-3)" $?
if mq_job_present "$DJOB"; then false; else true; fi
check "lib: mq_job_present is false for a consumed job" $?
STAGE=$(mq_new_staging "t-empty"); : > "$STAGE/job.sh"
if mq_enqueue "$STAGE" 30; then false; else true; fi
check "lib: mq_enqueue refuses an EMPTY job.sh (SFH-6)" $?
STAGE=$(mq_new_staging "t-lastjob"); printf '#!/bin/bash\nexit 0\n' > "$STAGE/job.sh"
mq_enqueue "$STAGE" 30 && [ -d "$MQ_LAST_JOB" ] && [ "$MQ_LAST_JOB" = "$MQ_ROOT/jobs/$(basename "$STAGE")" ]
check "lib: mq_enqueue exposes the published path in MQ_LAST_JOB (CR-4)" $?
rm -rf "$MQ_LAST_JOB"

echo "---"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
