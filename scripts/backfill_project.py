#!/usr/bin/env python3
"""
Backfill the entities.project field for memories saved GLOBAL (project=NULL) that clearly
belong to a specific project — the accumulated mapping gap from sessions started in ~/Claude
(global cwd) where the project scope wasn't set at entity-creation time.

Why: ~68% of active entities are project=NULL, and ~87+ of those have a NAME that names a
project (astroplan_task1_logging, dustin-space-css, ...). NULL-project entities are missed by
project-scoped recall (search_nodes(projectId=...), the L1 lane). There is no MCP tool to set
an entity's project after creation (same gap that BLOCKED the rig-telemetry fix), so this is a
guarded direct migration.

DETERMINISTIC + CONSERVATIVE rules (no LLM judgment):
  1. PREFIX — a NULL-project entity whose normalized name starts with a known project's
     normalized key (longest match wins; key length >= 5 to avoid spurious short matches)
     -> set project to that project.
  2. CONTINUITY-THREAD — a NULL-project '<x>-continuity-thread' entity -> project '<x>'
     (definitionally what a continuity thread is for; also fixes rig-telemetry-continuity-thread).

SAFETY: dry-run by default (prints the plan). --apply takes a CONSISTENT backup first (the
SQLite online-backup API, WAL-safe), then UPDATEs only NULL-project rows — never overwrites an
existing project, never touches observations/relations. Idempotent + re-runnable, so it also
works as a weekly consolidation pre-step for the ongoing case.
"""
import argparse
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB = Path.home() / ".claude" / "memory.db"
BACKUP_DIR = Path.home() / ".local" / "state" / "claude-memory-backups"
SUFFIX = "-continuity-thread"


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def plan(conn):
    """Return [(entity_id, name, new_project, rule)] for NULL-project entities a rule matches."""
    cur = conn.cursor()
    ae = "(superseded_at IS NULL OR superseded_at='') AND (tombstoned_at IS NULL OR tombstoned_at='')"
    projects = [r[0] for r in cur.execute(
        f"SELECT DISTINCT project FROM entities WHERE project IS NOT NULL AND project!='' AND {ae}").fetchall()]
    pkeys = sorted(((norm(p), p) for p in projects if len(norm(p)) >= 5),
                   key=lambda kp: len(kp[0]), reverse=True)            # longest key first
    rows = cur.execute(
        f"SELECT id, name, normalized_name FROM entities "
        f"WHERE (project IS NULL OR project='') AND {ae}").fetchall()
    out = []
    for eid, name, nn in rows:
        newp = rule = None
        for pk, p in pkeys:                                            # rule 1: prefix
            if nn and nn.startswith(pk):
                newp, rule = p, "prefix"
                break
        if newp is None and name and name.endswith(SUFFIX):           # rule 2: continuity-thread
            derived = name[:-len(SUFFIX)]
            if derived:
                newp, rule = derived, "continuity-thread"
        if newp:
            out.append((eid, name, newp, rule))
    return out


def backup():
    """Consistent WAL-safe snapshot via the SQLite online-backup API, BEFORE any write."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    dest = BACKUP_DIR / f"memory-prebackfill-{stamp}.db"
    src = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="apply the UPDATEs (default: dry-run)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB, timeout=5)
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        changes = plan(conn)
        byrule = {}
        for _, _, _, rule in changes:
            byrule[rule] = byrule.get(rule, 0) + 1
        print(f"{len(changes)} NULL-project entities match a backfill rule  {byrule}")
        for eid, name, newp, rule in changes:
            print(f"  [{rule:16}] '{name}'  ->  project '{newp}'")
        if not args.apply:
            print("\nDRY RUN — re-run with --apply to back up + write.")
            return
        if not changes:
            print("nothing to backfill — no changes.")   # no-op: skip the backup (weekly-safe)
            return
        dest = backup()
        print(f"\nbacked up -> {dest}")
        cur = conn.cursor()
        for eid, name, newp, rule in changes:
            cur.execute("UPDATE entities SET project=? WHERE id=? AND (project IS NULL OR project='')",
                        (newp, eid))
        conn.commit()
        print(f"applied {len(changes)} project backfills.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
