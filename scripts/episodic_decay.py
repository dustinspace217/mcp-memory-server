#!/usr/bin/env python3
"""
Episodic decay gradient — day-rollup + tier assignment (the deterministic core).

Plan: docs/superpowers/plans/2026-06-10-episodic-decay-gradient.md

Reads the raw per-session `session-narratives` and groups them into per-DAY entries
(concurrent sessions are parallel stories about ONE day; the unit is the day, not the
session — a person's memory doesn't fork by terminal window). Each day is assigned a
compression TIER purely by AGE:

    FRESH (age < FRESH_DAYS)              full day-entry (the day's narratives, merged)
    GIST  (FRESH_DAYS <= age < ERA_DAYS)  needs LLM compression to a short paragraph
    ERA   (age >= ERA_DAYS)               needs collapse to a one-line era marker

This module owns the DETERMINISTIC part (group-by-day + tier-by-age + the verbatim
FRESH merge). The LLM text-compression for GIST/ERA is the weekly consolidation
agent's job; this hands it exactly which days need compressing and to which tier, so
the agent never re-reads the whole history — and ALWAYS derives a tier from the
ORIGINAL day's narratives, never a gist-of-a-gist (the drift rule from the spec).
"""
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path.home() / ".claude" / "memory.db"

# Dustin's gradient: verbatim for two weeks, then gist, then a one-line era by ~3 months.
FRESH_DAYS = 14
ERA_DAYS = 90

# Narratives are authored with a leading [YYYY-MM-DD] (the session's date); that is the
# day the work happened, which is what we group on (created_at is the write time, often
# the next day after a late session).
_DATE_RE = re.compile(r"\[(\d{4}-\d{2}-\d{2})")
# Bare YYYY-MM-DD (no leading bracket) — used to validate the created_at fallback slice.
# _DATE_RE can't do this: it requires a leading '[', which the created_at slice lacks.
_DATE_ONLY = re.compile(r"\d{4}-\d{2}-\d{2}$")


def _day_of(content, created_at):
    """The day a narrative belongs to: the [YYYY-MM-DD] the author stamped in the
    content, else the created_at date. If NEITHER yields a digit-shaped date (an
    undated narrative with a null/odd created_at), return the sentinel '0000-00-00'
    rather than '' — an empty day key produced a malformed '### · FRESH' header and a
    phantom day that never aged (QA adversarial CASE 1). The sentinel is visibly bogus,
    sorts last, and routes the same as any unparseable date."""
    m = _DATE_RE.match(content.strip())
    if m:
        return m.group(1)
    ca = (created_at or "")[:10]
    return ca if _DATE_ONLY.match(ca) else "0000-00-00"


def load_session_narratives(conn):
    """Return [(day, content, created_at)] for ACTIVE session-narratives observations."""
    cur = conn.cursor()
    rows = cur.execute(
        """SELECT o.content, o.created_at
           FROM observations o JOIN entities e ON o.entity_id = e.id
           WHERE e.name = 'session-narratives'
             AND (o.superseded_at IS NULL OR o.superseded_at = '')
             AND (o.tombstoned_at IS NULL OR o.tombstoned_at = '')
           ORDER BY o.created_at ASC""").fetchall()
    return [(_day_of(c, ca), c, ca) for c, ca in rows]


def tier_for(day, now):
    """fresh / gist / era from a day's age. `day` is 'YYYY-MM-DD', `now` is aware UTC."""
    try:
        d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return "fresh"   # unparseable date -> don't try to age/compress it
    # max(0, …): a FUTURE-dated day (typo, or a session whose local date ran ahead of
    # UTC) yields a negative age; clamping treats it as age 0 (fresh now, ageable as real
    # time passes) instead of a confusing negative (QA adversarial CASE 2).
    age = max(0, (now - d).days)
    if age < FRESH_DAYS:
        return "fresh"
    if age < ERA_DAYS:
        return "gist"
    return "era"


def roll_up(conn, now=None):
    """Group session-narratives by day and assign each day its tier.

    Returns day-entries (newest first):
      {day, tier, age_days, sessions, needs_compression,
       merged (verbatim — FRESH only) | raw ([narratives] — GIST/ERA, the agent's source)}.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    by_day = {}
    for day, content, _ in load_session_narratives(conn):
        by_day.setdefault(day, []).append(content)

    entries = []
    for day in sorted(by_day, reverse=True):
        narrs = by_day[day]
        tier = tier_for(day, now)
        try:
            age = max(0, (now - datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)).days)
        except ValueError:
            age = -1   # sentinel/unparseable day ('0000-00-00') — visibly bogus, stays fresh
        entry = {
            "day": day, "tier": tier, "age_days": age, "sessions": len(narrs),
            "needs_compression": tier in ("gist", "era"),
        }
        if tier == "fresh":
            entry["merged"] = "\n\n".join(narrs)   # the full day-entry, no LLM needed
        else:
            entry["raw"] = narrs                   # source the agent compresses from
        entries.append(entry)
    return entries


if __name__ == "__main__":
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        entries = roll_up(conn)
        counts = {"fresh": 0, "gist": 0, "era": 0}
        for e in entries:
            counts[e["tier"]] += 1
            flag = "  [needs compression]" if e["needs_compression"] else ""
            print(f"{e['day']}  age {e['age_days']:>3}d  {e['tier'].upper():5}  {e['sessions']} session(s){flag}")
        print(f"\n{len(entries)} day-entries  ·  fresh {counts['fresh']} / gist {counts['gist']} / era {counts['era']}")
    finally:
        conn.close()
