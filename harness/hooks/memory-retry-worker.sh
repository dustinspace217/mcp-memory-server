#!/bin/bash
# memory-retry-worker.sh — drains the memory retry queue (see memory-queue-lib.sh).
#
# Run by systemd user timer memory-retry.timer (every 20 min + 5 min after boot).
# Plain bash + systemd: the SCHEDULER has zero Claude dependency, so a killed
# memory save (usage-limit exhaustion, timeout, teardown) is retried until
# Claude usage opens back up — the retry survives reboots because both the
# queue (~/.local/state) and the timer (Persistent=true) do.
#
# Per job: run job.sh under its own JOB_TIMEOUT. Exit 0 → job removed (done).
# Non-zero → exponential backoff (15 min doubling, capped at 8 h), so a
# multi-day usage outage costs ~3 attempts/day, each failing fast at the CLI's
# limit error. Gives up after MAX_ATTEMPTS or TTL_SECS and moves the job to
# failed/ with a FAIL line in hook-execution.log — session-health-check.py
# surfaces those at the next session start, so a permanently-stuck save is
# loud, never silent.
#
# Logs: hook-execution.log, source "RetryQueue" (the health-check's parser
# accepts any source; FAIL/WARN prefixes are what it keys on).

set -uo pipefail

# Both env-overridable so tests run against a sandbox queue + log instead of
# the real ones (QA 2026-07-02). Production (systemd) never sets either.
MQ_ROOT="${MQ_ROOT:-$HOME/.local/state/claude-memory-queue}"
LOGFILE="${MQ_LOGFILE:-$HOME/.claude/hooks/hook-execution.log}"

MAX_ATTEMPTS=24          # with the 8h backoff cap this spans ~7 days of outage
TTL_SECS=$(( 7 * 24 * 3600 ))
BACKOFF_BASE=900         # 15 min; doubles per attempt
BACKOFF_CAP=28800        # 8 h
MAX_JOBS_PER_TICK=10     # bound one tick's work (Power-of-Ten rule 2); the
                         # timer re-fires in 20 min, so a backlog still drains
YIELD_DEFER=300          # rc=75 (replay yielded to a live save): retry in 5 min

# write_meta JOB_DIR — rewrite meta ATOMICALLY (temp file + rename). The
# producer may be editing the same file at the same moment (mq_defer /
# mq_make_due use sed -i, which also renames); a plain `>` truncate-then-write
# could leave an EMPTY meta if the two interleave (cross-family QA 2026-10-05,
# XFA-2). Last writer still wins, but every observable state is complete.
write_meta() {
    local jobdir="$1"
    {
        echo "LABEL='${LABEL}'"
        echo "CREATED=${CREATED}"
        echo "ATTEMPTS=${ATTEMPTS}"
        echo "NEXT_AFTER=${NEXT_AFTER}"
        echo "JOB_TIMEOUT=${JOB_TIMEOUT}"
    } > "$jobdir/meta.tmp" && mv -f "$jobdir/meta.tmp" "$jobdir/meta"
}

log() {
    echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') | RetryQueue | $1" >> "$LOGFILE"
}

mkdir -p "$MQ_ROOT/jobs" "$MQ_ROOT/failed" "$MQ_ROOT/staging"

# Single-flight: overlapping ticks (or a manual run beside the timer) must not
# double-run a job. Non-blocking — if another worker holds the lock, this tick
# simply yields to it.
exec 9>"$MQ_ROOT/.worker.lock"
if ! flock -n 9; then
    exit 0
fi

NOW=$(date +%s)
processed=0

for jobdir in "$MQ_ROOT/jobs"/*/; do
    [ -d "$jobdir" ] || continue

    if [ "$processed" -ge "$MAX_JOBS_PER_TICK" ]; then
        log "WARN: tick cap reached ($MAX_JOBS_PER_TICK jobs) — remainder next tick"
        break
    fi

    jobid="$(basename "$jobdir")"

    # meta is written by mq_enqueue; a job without one is unrunnable debris.
    if [ ! -f "$jobdir/meta" ]; then
        log "FAIL: job $jobid has no meta — moved to failed/"
        mv "$jobdir" "$MQ_ROOT/failed/$jobid" 2>/dev/null || true
        continue
    fi

    # Defaults guard against a hand-edited/truncated meta (source would leave
    # variables unset and -u would kill the whole worker for one bad job).
    ATTEMPTS=0; NEXT_AFTER=0; CREATED=$NOW; JOB_TIMEOUT=420; LABEL="$jobid"
    # shellcheck disable=SC1091
    source "$jobdir/meta" 2>/dev/null || true

    # Not due yet?
    if [ "$NOW" -lt "$NEXT_AFTER" ]; then
        continue
    fi

    # Give up: too old or too many attempts. Loud, never silent.
    if [ $(( NOW - CREATED )) -gt "$TTL_SECS" ] || [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
        log "FAIL: job $jobid gave up after ${ATTEMPTS} attempts / $(( (NOW - CREATED) / 3600 ))h — moved to failed/ (payload kept 30d)"
        mv "$jobdir" "$MQ_ROOT/failed/$jobid" 2>/dev/null || true
        continue
    fi

    processed=$(( processed + 1 ))

    # Run the attempt. job.sh finds its payload via $(dirname "$0").
    # -k 15: SIGKILL 15s after the timeout's SIGTERM if the job ignores it.
    # 9>&- closes the worker's lock fd for the job's process tree: a daemonized
    # descendant inheriting it would hold the single-flight lock forever and
    # silently stop all future ticks (flock -n loser exits 0). QA 2026-07-02.
    echo "=== attempt $(( ATTEMPTS + 1 )) at $(date -u '+%Y-%m-%d %H:%M:%S UTC') ===" >> "$jobdir/run.log"
    # A yield is signalled out of band (see the rc 75 branch); clear any marker a
    # previous attempt left so only THIS attempt's yield counts.
    rm -f "$jobdir/.yield"
    timeout -k 15 "$JOB_TIMEOUT" bash "$jobdir/job.sh" >> "$jobdir/run.log" 2>&1 9>&-
    rc=$?
    # The job's directory can vanish DURING the attempt: a replay that yielded
    # (touched .yield, exit 75) lets the live session-end save finish, and that
    # save cancels the job (mq_cancel). Nothing is left to count or reschedule;
    # without this check the marker is gone with the directory and a legitimate
    # yield would be logged as a failed attempt (cross-family review XFK-1).
    if [ "$rc" -ne 0 ] && [ ! -d "$jobdir" ]; then
        log "INFO: job $jobid was cancelled during its attempt (rc=$rc) — nothing to reschedule"
        continue
    fi

    if [ "$rc" -eq 0 ]; then
        log "OK: job $jobid succeeded on attempt $(( ATTEMPTS + 1 ))"
        rm -rf "$jobdir"
    elif [ "$rc" -eq 75 ] && [ -e "$jobdir/.yield" ]; then
        rm -f "$jobdir/.yield"
        # Exit code 75 counts as a yield ONLY with the .yield marker the job writes
        # just before yielding (issue #99 FR-5, fixed at the root on review CR-1):
        # a job's own child (claude, or run-consolidation.sh, which exits with
        # claude's code) can also return 75, and without the marker that would
        # retry every few minutes, uncounted, until the TTL. Without the marker, 75
        # is an ordinary failed attempt (the else branch).
        # A session-end replay YIELDED because a live save holds the save lock
        # (job.sh exits 75 on `flock -n` failure). Not a failed attempt: defer
        # a few minutes without touching ATTEMPTS or the backoff, so a job that
        # keeps landing behind live saves cannot burn its budget and give up
        # (cross-family QA 2026-10-05, XFK-6).
        NEXT_AFTER=$(( NOW + YIELD_DEFER ))
        write_meta "$jobdir"
        log "INFO: job $jobid yielded to a live save — retry in $(( YIELD_DEFER / 60 ))m (attempts unchanged)"
    else
        ATTEMPTS=$(( ATTEMPTS + 1 ))
        # Exponential backoff: BACKOFF_BASE * 2^(ATTEMPTS-1), capped.
        backoff=$(( BACKOFF_BASE * (1 << (ATTEMPTS - 1)) ))
        if [ "$backoff" -gt "$BACKOFF_CAP" ]; then backoff=$BACKOFF_CAP; fi
        NEXT_AFTER=$(( NOW + backoff ))
        write_meta "$jobdir"
        # WARN (not FAIL): a retryable miss is degraded operation, not a loss —
        # FAIL is reserved for gave-up jobs so the health-check alarm stays
        # meaningful. rc=124 is the job's own timeout.
        log "WARN: job $jobid attempt ${ATTEMPTS} failed (rc=$rc) — next try in $(( backoff / 60 ))m"
    fi
done

# Prune forensics after 30 days; stale staging dirs (a producer died mid-build)
# after 1 day. -mindepth/-maxdepth pin the depth so this can never walk wider
# than the queue's own layout.
find "$MQ_ROOT/failed" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
find "$MQ_ROOT/staging" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
# last-save/<session-id> holds the excerpt hashes of each session's last 20
# completed saves, one per line (sessionend-save.sh skips an excerpt whose hash is
# in the set; issue #99 FR-4). One small file per session id; a write or a skip
# refreshes its age, so prune after 30 days untouched (QA 2026-10-05, SFH-4/SLA;
# also removes *.tmp.PID files orphaned by a killed writer).
find "$MQ_ROOT/last-save" -mindepth 1 -maxdepth 1 -type f -mtime +30 -delete 2>/dev/null || true

exit 0
