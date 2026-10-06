# shellcheck shell=bash
# memory-queue-lib.sh — shared enqueue helpers for the memory retry queue.
# (No shebang on purpose: this file is SOURCED by producers, never executed.)
#
# Sourced (not executed) by producers: pre-compact-agent.sh, sessionend-save.sh,
# run-consolidation.sh. The consumer is memory-retry-worker.sh (systemd timer
# memory-retry.timer, every 20 min).
#
# WHY THIS EXISTS (2026-07-02): memory saves run as claude -p children, and a
# child can die mid-save — internal timeout (PreCompact's chronic 240s kills),
# weekly usage-limit exhaustion (the June 2026 consolidation failure cluster),
# or teardown races. Before this queue, a killed save was simply LOST unless
# the in-context session happened to checkpoint. The queue makes the save
# durable: the producer persists the job's full payload (prompt + transcript
# excerpt) to disk, and a systemd timer — plain bash, NO Claude dependency —
# retries it until usage/capacity comes back. Only the worker's job.sh touches
# claude; the scheduling layer survives any usage outage.
#
# Queue layout (~/.local/state — persistent across reboots, same convention as
# the sibling claude-memory-backups dir; NOT /tmp, which reboot wipes):
#   $MQ_ROOT/staging/<jobid>/   half-built jobs (invisible to the worker)
#   $MQ_ROOT/jobs/<jobid>/      ready jobs: job.sh + meta + payload files
#   $MQ_ROOT/failed/<jobid>/    given-up jobs, kept 30 days for forensics
#
# A job directory contains:
#   job.sh   self-contained re-run script; exit 0 = success. Locates its own
#            payload via $(dirname "$0") so the staging→jobs mv is transparent.
#   meta     shell-sourceable: LABEL, CREATED, ATTEMPTS, NEXT_AFTER, JOB_TIMEOUT
#   run.log  appended output of each attempt (worker-managed)
#
# Enqueue is ATOMIC: producers build in staging/ and mq_enqueue mv's the dir
# into jobs/ — same filesystem, so the worker can never see a half-written job.

# env-overridable so tests can point at a sandbox queue instead of the real
# one (QA 2026-07-02: the hardcoded path made the mechanics test execute any
# REAL pending jobs). Production callers never set MQ_ROOT.
MQ_ROOT="${MQ_ROOT:-$HOME/.local/state/claude-memory-queue}"

# mq_new_staging LABEL — create a staging dir, echo its path.
# LABEL becomes part of the jobid: <utc-timestamp>-<label>-<pid> is unique
# enough for this queue's volume (a handful of jobs a week).
mq_new_staging() {
    local label="$1"
    local jobid
    jobid="$(date -u +%Y%m%dT%H%M%SZ)-${label}-$$"
    local dir="$MQ_ROOT/staging/$jobid"
    mkdir -p "$dir"
    echo "$dir"
}

# mq_enqueue STAGING_DIR JOB_TIMEOUT_SECS [INITIAL_DELAY_SECS] — finalize a staged job.
# Writes meta, marks job.sh executable, atomically publishes to jobs/.
# Returns non-zero if the staging dir is missing job.sh (refuse to enqueue
# a job that can never run — explicit recovery per Power-of-Ten rule 5).
# INITIAL_DELAY_SECS (default 0 = due at the next worker tick) exists for the
# WRITE-AHEAD pattern (2026-10-05): a producer persists the job BEFORE its live
# attempt and cancels it on success, so the job must not become due while the
# live attempt is still running or waiting on the save lock.
# On success the published path is left in MQ_LAST_JOB (a variable, not stdout:
# pre-compact-agent.sh's stdout IS the hook's instruction payload, so the lib
# must never print). Callers that need the job dir read MQ_LAST_JOB instead of
# rebuilding the layout by hand (QA 2026-10-05, CR-4).
MQ_LAST_JOB=""
mq_enqueue() {
    local staging="$1"
    local job_timeout="${2:-420}"
    local initial_delay="${3:-0}"
    MQ_LAST_JOB=""
    # -s, not -f: an EMPTY job.sh exits 0 under bash and the worker would log a
    # success for a save that never ran (QA 2026-10-05, SFH-6).
    if [ ! -s "$staging/job.sh" ]; then
        return 1
    fi
    local jobid
    jobid="$(basename "$staging")"
    {
        echo "LABEL='${jobid}'"
        echo "CREATED=$(date +%s)"
        echo "ATTEMPTS=0"
        echo "NEXT_AFTER=$(( $(date +%s) + initial_delay ))"
        echo "JOB_TIMEOUT=${job_timeout}"
    } > "$staging/meta"
    [ -s "$staging/meta" ] || return 1          # a short write here would strand the job
    chmod +x "$staging/job.sh"
    mkdir -p "$MQ_ROOT/jobs"
    mv "$staging" "$MQ_ROOT/jobs/$jobid" || return 1
    MQ_LAST_JOB="$MQ_ROOT/jobs/$jobid"
}

# mq_cancel JOB_DIR — remove a published job that is no longer needed (the
# write-ahead producer's live attempt succeeded). Returns 0 when the dir is
# gone afterwards (removed now, or already dequeued by the worker — the caller
# can tell the two apart with mq_job_present before calling), nonzero when the
# dir still exists because rm failed. Status is propagated so the caller never
# logs OK over a job that will replay as a duplicate (QA 2026-10-05, CR-3).
mq_cancel() {
    local jobdir="$1"
    [ -n "$jobdir" ] || return 0
    [ -d "$jobdir" ] || return 0
    rm -rf "$jobdir"
    [ ! -d "$jobdir" ]
}

# mq_job_present JOB_DIR — 0 if the published job still exists AND has not been
# completed. The write-ahead producer uses it after taking the save lock: a
# missing job means the worker already replayed this save, so the live attempt
# must be skipped. The `.done` marker closes the gap between job.sh releasing
# the lock (process exit) and the worker removing the dir: job.sh touches it as
# its last act while still holding the lock, so a helper that wakes in that gap
# sees "completed", not "present" (cross-family QA 2026-10-05, XFA-3/XFK-3).
mq_job_present() {
    if [ -n "${1:-}" ] && [ -d "$1" ] && [ ! -e "$1/.done" ]; then
        return 0
    fi
    return 1
}

# mq_make_due JOB_DIR — pull a job forward so the next worker tick runs it (the
# write-ahead producer's live attempt FAILED; retry as soon as possible, exactly
# as the old enqueue-on-failure path did). Nonzero when meta is missing (job
# already consumed) or the rewrite failed, so the caller can log the truth.
mq_make_due() {
    # Stamps NOW, not a literal 0: the worker treats both as due, but a real
    # timestamp lets the health check measure how long the job has actually
    # been waiting (a 0 reads as "overdue since 1970"; XFA-4).
    mq_defer "${1:-}" 0
}

# mq_defer JOB_DIR SECS — set NEXT_AFTER to now+SECS. The write-ahead producer
# calls it right after acquiring the save lock, so the delay is measured from
# the start of the bounded live attempt (<= 310 s) instead of from enqueue,
# where an unbounded lock wait could outlast it (QA 2026-10-05, CR-1/SLA-1).
mq_defer() {
    local jobdir="$1" secs="${2:-0}"
    if [ -z "$jobdir" ] || [ ! -f "$jobdir/meta" ]; then
        return 1
    fi
    sed -i "s/^NEXT_AFTER=.*/NEXT_AFTER=$(( $(date +%s) + secs ))/" "$jobdir/meta"
}

# mq_has_job LABEL_SUBSTRING — 0 if any pending job's id contains the substring.
# Used by run-consolidation.sh to avoid stacking duplicate consolidation
# retries (one pending retry is enough; the job is self-canceling anyway).
mq_has_job() {
    local needle="$1"
    local d
    for d in "$MQ_ROOT/jobs/"*"$needle"*/; do
        [ -d "$d" ] && return 0
    done
    return 1
}
