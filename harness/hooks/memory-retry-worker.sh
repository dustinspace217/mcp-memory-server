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

MQ_ROOT="$HOME/.local/state/claude-memory-queue"
LOGFILE="$HOME/.claude/hooks/hook-execution.log"

MAX_ATTEMPTS=24          # with the 8h backoff cap this spans ~7 days of outage
TTL_SECS=$(( 7 * 24 * 3600 ))
BACKOFF_BASE=900         # 15 min; doubles per attempt
BACKOFF_CAP=28800        # 8 h
MAX_JOBS_PER_TICK=10     # bound one tick's work (Power-of-Ten rule 2); the
                         # timer re-fires in 20 min, so a backlog still drains

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
    echo "=== attempt $(( ATTEMPTS + 1 )) at $(date -u '+%Y-%m-%d %H:%M:%S UTC') ===" >> "$jobdir/run.log"
    timeout -k 15 "$JOB_TIMEOUT" bash "$jobdir/job.sh" >> "$jobdir/run.log" 2>&1
    rc=$?

    if [ "$rc" -eq 0 ]; then
        log "OK: job $jobid succeeded on attempt $(( ATTEMPTS + 1 ))"
        rm -rf "$jobdir"
    else
        ATTEMPTS=$(( ATTEMPTS + 1 ))
        # Exponential backoff: BACKOFF_BASE * 2^(ATTEMPTS-1), capped.
        backoff=$(( BACKOFF_BASE * (1 << (ATTEMPTS - 1)) ))
        if [ "$backoff" -gt "$BACKOFF_CAP" ]; then backoff=$BACKOFF_CAP; fi
        NEXT_AFTER=$(( NOW + backoff ))
        {
            echo "LABEL='${LABEL}'"
            echo "CREATED=${CREATED}"
            echo "ATTEMPTS=${ATTEMPTS}"
            echo "NEXT_AFTER=${NEXT_AFTER}"
            echo "JOB_TIMEOUT=${JOB_TIMEOUT}"
        } > "$jobdir/meta"
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

exit 0
