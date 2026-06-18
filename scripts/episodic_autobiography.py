#!/usr/bin/env python3
"""
Episodic autobiography — the COMPRESSED-tail store + load-view + weekly work plan.

Plan: docs/superpowers/plans/2026-06-10-episodic-decay-gradient.md (Phase 1+2).

The decay gradient has two halves:
  - episodic_decay.py (Phase 0): deterministic group-by-day + tier-by-age. It reads
    the raw `session-narratives` and says which DAY is fresh/gist/era.
  - THIS module (Phase 1+2): the derived `episodic-autobiography` entity that holds
    the COMPRESSED gist/era text (one observation per aged day), plus the read side
    the SessionStart load hook uses, plus the idempotent work plan the weekly
    consolidation agent follows to compress newly-aged days.

Division of labour (why this split):
  - FRESH days (< 14d) are NEVER stored here — they load verbatim straight from
    `session-narratives` (via episodic_decay.roll_up's `merged`). Storing them would
    duplicate the raw log. So this entity holds ONLY the compressed tail.
  - The actual gist/era *text* is LLM-synthesised (a coherent day-narrative, not a
    truncation), which only the consolidation agent can do. This module never writes
    — it plans the work (which days, from which originals) and reads the result back.
    `plan_work` is the deterministic "what needs compressing"; the agent does the prose.

Storage format (one observation per aged day, on entity `episodic-autobiography`):
    [YYYY-MM-DD · gist] <one compressed paragraph>
    [YYYY-MM-DD · era]  <one compressed line>
The leading [date · tier] is the KEY: it makes the obs idempotent (one per day),
tier-aware (re-derive when a day crosses gist→era), and orderable (newest first) —
all without a separate metadata column. `STORED_RE` tolerates any separator between
the date and the tier word so a hand-edited "·"/"|"/space never breaks parsing.

Stdlib-only (re, sqlite3, datetime, pathlib) so the SessionStart load hook can import
it before any virtualenv exists — same constraint episodic_decay.py honours.
"""
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# Import the deterministic rollup. Same directory, both stdlib-only. The load hook
# adds this directory to sys.path before importing this module, so a bare import works
# whether run as __main__ here or imported from the hook.
from episodic_decay import roll_up, FRESH_DAYS, ERA_DAYS

DB_PATH = Path.home() / ".claude" / "memory.db"

# The single global entity holding the compressed tail. One entity (not per-day) per
# the plan's storage recommendation: simpler to load and supersede-in-place.
STORE_ENTITY = "episodic-autobiography"

# Parse a stored obs's leading "[YYYY-MM-DD · tier]" key. Tolerant of the separator
# (·, |, space, etc.) so the key survives hand-edits: match the date, then the first
# fresh|gist|era word before the closing ']'.
STORED_RE = re.compile(r"^\[\s*(\d{4}-\d{2}-\d{2})[^\]]*\b(fresh|gist|era)\b[^\]]*\]\s*(.*)", re.DOTALL)


def build_stored_content(day, tier, text):
    """Compose the canonical stored-obs content for a day. `text` is the LLM gist/era
    prose (no key prefix); we prepend the parseable [date · tier] key."""
    return f"[{day} · {tier}] {text.strip()}"


def parse_stored_content(content):
    """Return (day, tier, text) parsed from a stored obs, or None if it doesn't match
    the keyed format (defensive — a malformed/hand-broken obs is skipped, not crashed
    on)."""
    m = STORED_RE.match(content or "")
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3).strip()


def read_stored(conn):
    """Return (out, malformed): `out` is {day: (tier, full_content)} for ACTIVE
    observations on the episodic-autobiography entity; `malformed` is the COUNT of active
    obs whose `[date · tier]` key did not parse.

    An unparseable obs is still skipped (one bad key must not crash a SessionStart load),
    but the count is RETURNED rather than swallowed: a corrupted key would otherwise be
    invisible to `plan_work`, which would then classify the day as `create` and write a
    duplicate — an un-collectable leak nothing logged (QA silent-failure + adversarial 5b).
    Surfacing the count lets the work plan flag it for hand-inspection. If two active obs
    somehow share a day (should not happen — supersede-in-place keeps one), ASC + dict
    overwrite makes the newest by created_at win."""
    cur = conn.cursor()
    rows = cur.execute(
        """SELECT o.content, o.created_at
           FROM observations o JOIN entities e ON o.entity_id = e.id
           WHERE e.name = ?
             AND (o.superseded_at IS NULL OR o.superseded_at = '')
             AND (o.tombstoned_at IS NULL OR o.tombstoned_at = '')
             AND (e.superseded_at IS NULL OR e.superseded_at = '')
           ORDER BY o.created_at ASC""", (STORE_ENTITY,)).fetchall()
    out = {}
    malformed = 0
    for content, _ in rows:               # ASC + overwrite ⇒ newest wins per day
        parsed = parse_stored_content(content)
        if parsed:
            day, tier, _text = parsed
            out[day] = (tier, content)
        else:
            malformed += 1
    return out, malformed


def plan_work(conn, now=None):
    """The idempotent compression plan for the weekly agent.

    Diffs what roll_up SAYS each aged day's tier should be against what is actually
    stored, and returns ONLY the days that need the agent to (re)write prose:
      action 'create'     — aged day with no stored obs yet (compress from raw).
      action 'recompress' — stored tier is stale (day crossed gist→era); the new tier
                            is derived from the ORIGINAL raw again, never the old gist.
    Days already stored at the correct tier are skipped (the idempotency that lets the
    weekly run be a cheap no-op once the tail is current). Each item carries `raw` (the
    day's original narratives) so the agent compresses from source, and `old_content`
    on a recompress so it can supersede the exact prior obs.

    Returns (work, orphans, malformed): `work` as above; `orphans` = stored days the rollup
    no longer backs at a compressible tier (narratives removed, OR the day is now fresh) —
    surfaced for the agent to prune, never auto-deleted here (this module does not write);
    `malformed` = count of stored obs whose key didn't parse (from read_stored)."""
    if now is None:
        now = datetime.now(timezone.utc)
    stored, malformed = read_stored(conn)
    entries = roll_up(conn, now)
    rolled_days = {e["day"] for e in entries}
    rolled_tier = {e["day"]: e["tier"] for e in entries}
    work = []
    for e in entries:
        if e["tier"] == "fresh":
            continue                      # fresh loads verbatim; never stored
        day = e["day"]
        item = {"day": day, "tier": e["tier"], "age_days": e["age_days"],
                "sessions": e["sessions"], "raw": e["raw"]}
        if day not in stored:
            item["action"] = "create"
            work.append(item)
        elif stored[day][0] != e["tier"]:
            item["action"] = "recompress"
            item["old_content"] = stored[day][1]
            work.append(item)
        # else: stored at the correct tier already → no work
    # Orphans = stored days the rollup no longer backs at a compressible tier:
    #   (a) day absent from the rollup (its narratives were removed), OR
    #   (b) day rolled up as FRESH — a clock moving backward, or a new narrative added to
    #       an old day, makes a once-aged day "young" again; its stored gist/era obs is now
    #       a zombie that load_view bypasses (fresh loads verbatim) and nothing else prunes
    #       (QA adversarial CASE 4). Surfaced here so the weekly agent removes it.
    orphans = [d for d in stored
               if d not in rolled_days or rolled_tier.get(d) == "fresh"]
    return work, orphans, malformed


def load_view(conn, now=None):
    """The read side for the SessionStart load hook.

    Returns {'fresh': [...], 'tail': [...]} newest-first:
      fresh: (day, age_days, sessions, merged)         — verbatim, straight from raw.
      tail:  (day, tier, age_days, sessions, text, source) where
               source 'stored'   → text is the compressed gist/era prose.
               source 'fallback' → the day has aged past FRESH but no compressed obs
                                    exists yet (the weekly agent hasn't run since it
                                    crossed). We show the raw merged narratives so the
                                    day is never INVISIBLE — bounded by the hook's
                                    chunking — flagged so the un-compressed state is
                                    obvious. Graceful degradation, not data loss."""
    if now is None:
        now = datetime.now(timezone.utc)
    stored, _malformed = read_stored(conn)
    entries = roll_up(conn, now)
    fresh, tail = [], []
    for e in entries:
        if e["tier"] == "fresh":
            fresh.append((e["day"], e["age_days"], e["sessions"], e["merged"]))
            continue
        day = e["day"]
        if day in stored:
            stored_tier, content = stored[day]
            parsed = parse_stored_content(content)
            text = parsed[2] if parsed else content
            # stored_tier != the rolled-up tier ⇒ the day crossed a boundary (e.g. gist→era)
            # but the weekly agent hasn't recompressed yet, so the stored text is a longer-tier
            # paragraph under a shorter-tier label. Mark 'stored-stale' so render_blocks flags
            # it, instead of silently rendering an ERA-labeled gist paragraph (QA CASE 8).
            src = "stored" if stored_tier == e["tier"] else "stored-stale"
            tail.append((day, e["tier"], e["age_days"], e["sessions"], text, src))
        else:
            merged = "\n\n".join(e["raw"])
            tail.append((day, e["tier"], e["age_days"], e["sessions"], merged, "fallback"))
    return {"fresh": fresh, "tail": tail}


def _format_plan(work, orphans, malformed=0):
    """Render the work plan as text for the weekly consolidation agent to read (it is
    written to a file by run-consolidation.sh; the agent `cat`s it). Includes each day's
    ORIGINAL narratives so the agent compresses from source, never a re-gist. A nonzero
    `malformed` count is surfaced loudly so a corrupted stored key gets hand-fixed instead
    of silently spawning a duplicate (QA)."""
    lines = [f"# EPISODIC AUTOBIOGRAPHY — compression work plan",
             f"# FRESH<{FRESH_DAYS}d (loaded verbatim, not stored) · "
             f"GIST {FRESH_DAYS}-{ERA_DAYS}d (paragraph) · ERA>={ERA_DAYS}d (one line)",
             f"# {len(work)} day(s) need prose; {len(orphans)} orphan(s); "
             f"{malformed} malformed key(s).", ""]
    if malformed:
        lines.append(f"MALFORMED: {malformed} active obs on `{STORE_ENTITY}` have an unparseable "
                     f"`[date · tier]` key — hand-inspect and fix or prune them (an unreadable key "
                     f"is invisible to this plan and causes a duplicate `create`).")
        lines.append("")
    if orphans:
        lines.append(f"ORPHANS (stored but no longer in the rollup — consider pruning): "
                     f"{', '.join(sorted(orphans))}")
        lines.append("")
    for it in work:
        lines.append(f"===== {it['day']}  {it['action'].upper()} → {it['tier'].upper()}  "
                     f"(age {it['age_days']}d, {it['sessions']} session(s)) =====")
        if it["action"] == "recompress":
            lines.append(f"  (supersede this exact stored obs:)\n  {it['old_content']}")
        for i, narr in enumerate(it["raw"], 1):
            lines.append(f"--- original narrative {i}/{len(it['raw'])} ---")
            lines.append(narr)
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Episodic autobiography store helper")
    p.add_argument("--plan", action="store_true",
                   help="Print the compression work plan (days needing gist/era prose).")
    p.add_argument("--view", action="store_true",
                   help="Print the assembled load view (fresh verbatim + compressed tail).")
    args = p.parse_args()
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    # One invalid-UTF-8 byte in a single obs must not crash the whole plan/view — replace
    # bad bytes for that obs rather than letting the fetch raise (QA adversarial CASE 6).
    conn.text_factory = lambda b: b.decode("utf-8", "replace")
    try:
        if args.view:
            v = load_view(conn)
            for day, age, sess, merged in v["fresh"]:
                print(f"[FRESH {day} age {age}d {sess}s] {len(merged)} chars")
            for day, tier, age, sess, text, src in v["tail"]:
                print(f"[{tier.upper()} {day} age {age}d {sess}s {src}] {text[:80]}...")
        else:                              # default to --plan
            work, orphans, malformed = plan_work(conn)
            print(_format_plan(work, orphans, malformed))
    finally:
        conn.close()
