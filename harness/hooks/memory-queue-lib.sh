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

# mq_enqueue STAGING_DIR JOB_TIMEOUT_SECS — finalize a staged job.
# Writes meta, marks job.sh executable, atomically publishes to jobs/.
# Returns non-zero if the staging dir is missing job.sh (refuse to enqueue
# a job that can never run — explicit recovery per Power-of-Ten rule 5).
mq_enqueue() {
    local staging="$1"
    local job_timeout="${2:-420}"
    if [ ! -f "$staging/job.sh" ]; then
        return 1
    fi
    local jobid
    jobid="$(basename "$staging")"
    {
        echo "LABEL='${jobid}'"
        echo "CREATED=$(date +%s)"
        echo "ATTEMPTS=0"
        echo "NEXT_AFTER=0"
        echo "JOB_TIMEOUT=${job_timeout}"
    } > "$staging/meta"
    chmod +x "$staging/job.sh"
    mkdir -p "$MQ_ROOT/jobs"
    mv "$staging" "$MQ_ROOT/jobs/$jobid"
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
