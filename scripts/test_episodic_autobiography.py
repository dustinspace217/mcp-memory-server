#!/usr/bin/env python3
"""
Tests for the episodic decay gradient Phase 1+2 (store/plan/load + the load hook).

Stdlib-only, no test framework (matches the scripts' zero-dependency style; run with
`python3 test_episodic_autobiography.py`).

Part 1 — episodic_autobiography against a synthetic in-memory DB: tier classification,
idempotency (create/skip/recompress/orphan/zombie), malformed-key surfacing, the
stored-stale tier-mismatch, and _format_plan rendering.
Part 2 — episodic_decay date edges: _day_of fallback/sentinel, tier_for future/unparseable.
Part 3 — the load hook (imported by path): plan_chunks packing + oversized-block truncation,
the overflow warning, render_blocks flags, empty-view skip, and the import-unavailable funnel.
Part 4 — a read-only smoke test of the real hook subprocess against the live memory.db
(exit-0 + bounded + distinguishes a healthy load from a degraded envelope).

Pass F (the consolidation prompt) is LLM synthesis, not unit-testable; the deterministic
boundary it relies on (`--plan` / `_format_plan`) IS covered here.
"""
import importlib.util
import io
import json
import os
import sqlite3
import pathlib
import subprocess
import sys
import time
import types
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import episodic_autobiography as ea
import episodic_decay as ed

# Import the load hook by path (hyphenated filename → not importable normally).
HOOK_PATH = os.path.expanduser("~/.claude/hooks/load-episodic-autobiography.py")
_spec = importlib.util.spec_from_file_location("load_autobio_hook", HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)

NOW = datetime(2026, 6, 18, tzinfo=timezone.utc)
PASS, FAIL = 0, 0


def check(label, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}")


def _day(age):
    return (NOW - timedelta(days=age)).strftime("%Y-%m-%d")


def build_synthetic_db(extra_narr=None, extra_store=None):
    """In-memory DB with just the columns roll_up + read_stored read.
    fresh@2, gist@30 (create), gist@40 (skip, stored), era@100 (recompress, stored as gist)."""
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, superseded_at TEXT, tombstoned_at TEXT);
        CREATE TABLE observations (id INTEGER PRIMARY KEY, entity_id INTEGER, content TEXT,
            created_at TEXT, superseded_at TEXT, tombstoned_at TEXT);
        INSERT INTO entities (id, name) VALUES (1, 'session-narratives'), (2, 'episodic-autobiography');
    """)

    def add_narr(day, text, created_at=None):
        conn.execute("INSERT INTO observations (entity_id, content, created_at) VALUES (1, ?, ?)",
                     (f"[{day}] {text}" if day else text, created_at or f"{day}T12:00:00.000Z"))

    def add_store(content, created_at="2026-06-18T00:00:00.000Z"):
        conn.execute("INSERT INTO observations (entity_id, content, created_at) VALUES (2, ?, ?)",
                     (content, created_at))

    add_narr(_day(2), "fresh work day")
    add_narr(_day(30), "gist day needing first compression")
    add_narr(_day(40), "gist day already stored")
    add_narr(_day(100), "era day stored only as gist")
    add_store(ea.build_stored_content(_day(40), "gist", "already-compressed gist text"))
    add_store(ea.build_stored_content(_day(100), "gist", "stale gist that should become era"))
    add_store(ea.build_stored_content("2025-01-01", "era", "orphan with no narrative"))
    for fn, items in ((add_narr, extra_narr), (add_store, extra_store)):
        for args in (items or []):
            fn(*args)
    conn.commit()
    return conn


# ── Part 1 — module ────────────────────────────────────────────────────────────

def test_format_roundtrip():
    print("format build/parse roundtrip:")
    c = ea.build_stored_content("2026-06-03", "gist", "  hello world  ")
    check("build prepends key + strips text", c == "[2026-06-03 · gist] hello world")
    check("parse recovers day/tier/text",
          ea.parse_stored_content(c) == ("2026-06-03", "gist", "hello world"))
    check("parse tolerates a '|' separator",
          ea.parse_stored_content("[2026-06-03 | era] x") == ("2026-06-03", "era", "x"))
    check("parse keeps a literal ] inside the body",
          ea.parse_stored_content('[2026-06-03 · gist] he said "done]" ok')[2] == 'he said "done]" ok')
    check("parse keeps multi-line body (DOTALL)",
          ea.parse_stored_content("[2026-06-03 · gist] a\nb")[2] == "a\nb")
    check("parse rejects a non-keyed obs", ea.parse_stored_content("no key here") is None)
    check("parse rejects a keyed obs with no tier word", ea.parse_stored_content("[2026-06-03] x") is None)


def test_read_stored_malformed():
    print("read_stored surfaces malformed keys (not silent):")
    conn = build_synthetic_db(extra_store=[("[2026-06-03] missing tier word",),
                                           ("totally unkeyed junk",)])
    out, malformed = ea.read_stored(conn)
    check("good days still parsed", _day(40) in out and "2025-01-01" in out)
    check("malformed count = 2", malformed == 2)
    check("malformed obs absent from dict", "2026-06-03" not in out)
    conn.close()


def test_plan_work():
    print("plan_work idempotency classification:")
    conn = build_synthetic_db()
    work, orphans, malformed = ea.plan_work(conn, now=NOW)
    by_day = {w["day"]: w for w in work}
    check("gist@30 → create", by_day.get(_day(30), {}).get("action") == "create")
    check("era@100 → recompress", by_day.get(_day(100), {}).get("action") == "recompress")
    check("recompress carries old_content", "old_content" in by_day.get(_day(100), {}))
    check("gist@40 (stored at tier) → not in work", _day(40) not in by_day)
    check("fresh@2 → never in work", _day(2) not in by_day)
    check("orphan (no narrative) detected", "2025-01-01" in orphans)
    check("malformed count returned", malformed == 0)
    check("create carries raw originals", isinstance(by_day[_day(30)]["raw"], list) and by_day[_day(30)]["raw"])
    conn.close()


def test_plan_work_era_create():
    print("plan_work true ERA create (age>=90, no stored obs):")
    conn = build_synthetic_db(extra_narr=[(_day(120), "very old day, never stored")])
    work, orphans, _ = ea.plan_work(conn, now=NOW)
    item = {w["day"]: w for w in work}.get(_day(120))
    check("era day with no stored obs → create@era",
          item is not None and item["action"] == "create" and item["tier"] == "era")
    conn.close()


def test_plan_work_zombie_fresh():
    print("plan_work zombie: a stored day that rolled up FRESH → orphan (QA CASE 4):")
    # A stored gist for a day that is actually only 3 days old (clock skew / re-added narrative).
    conn = build_synthetic_db(extra_narr=[(_day(3), "young day")],
                              extra_store=[(ea.build_stored_content(_day(3), "gist", "zombie gist"),)])
    work, orphans, _ = ea.plan_work(conn, now=NOW)
    check("now-fresh stored day flagged as orphan-to-prune", _day(3) in orphans)
    check("now-fresh stored day not queued as work", _day(3) not in {w["day"] for w in work})
    conn.close()


def test_load_view():
    print("load_view fresh + tail (stored / fallback / stored-stale):")
    conn = build_synthetic_db()
    v = ea.load_view(conn, now=NOW)
    check("one fresh day, verbatim", len(v["fresh"]) == 1 and "fresh work day" in v["fresh"][0][3])
    tail = {t[0]: t for t in v["tail"]}
    check("gist@30 falls back (no stored)", tail[_day(30)][5] == "fallback")
    check("gist@40 uses stored text", tail[_day(40)][5] == "stored" and tail[_day(40)][4] == "already-compressed gist text")
    check("era@100 stored-as-gist → 'stored-stale'", tail[_day(100)][5] == "stored-stale")
    check("tail newest-first", [t[0] for t in v["tail"]] == sorted([t[0] for t in v["tail"]], reverse=True))
    conn.close()


def test_format_plan_render():
    print("_format_plan renders create/recompress/orphan/malformed:")
    conn = build_synthetic_db(extra_store=[("junk no key",)])
    work, orphans, malformed = ea.plan_work(conn, now=NOW)
    txt = ea._format_plan(work, orphans, malformed)
    check("header reports malformed count", "malformed key(s)" in txt and "MALFORMED:" in txt)
    check("renders a CREATE block", "CREATE" in txt)
    check("renders the RECOMPRESS supersede pointer", "supersede this exact stored obs" in txt)
    check("lists orphans", "2025-01-01" in txt)
    check("includes original narratives", "era day stored only as gist" in txt)
    conn.close()


# ── Part 2 — episodic_decay date edges ──────────────────────────────────────────

def test_decay_date_edges():
    print("episodic_decay date edges:")
    check("_day_of uses content stamp", ed._day_of("[2026-05-01] x", "2026-06-01T00:00:00Z") == "2026-05-01")
    check("_day_of falls back to created_at", ed._day_of("no stamp", "2026-06-01T09:00:00Z") == "2026-06-01")
    check("_day_of sentinel on null created_at (no empty key)", ed._day_of("no stamp", None) == "0000-00-00")
    check("_day_of sentinel on non-date created_at", ed._day_of("x", "not-a-date") == "0000-00-00")
    check("tier_for future date clamps to fresh (not negative)", ed.tier_for("2026-12-25", NOW) == "fresh")
    check("tier_for unparseable → fresh", ed.tier_for("2026-13-99", NOW) == "fresh")
    check("tier_for gist boundary", ed.tier_for(_day(30), NOW) == "gist")
    check("tier_for era boundary", ed.tier_for(_day(100), NOW) == "era")


# ── Part 3 — the load hook (pure functions) ─────────────────────────────────────

def test_plan_chunks_basic():
    print("hook plan_chunks packing:")
    blocks = [f"### day{i}\n" + "x" * 2000 for i in range(8)]
    chunks = hook.plan_chunks(blocks)
    check("packs into multiple chunks", len(chunks) >= 2)
    for i in range(len(chunks)):
        check(f"chunk {i} within budget", len(hook.build_chunk_text(chunks, i)) <= hook.PAYLOAD_BUDGET)
    check("past-end chunk is empty", hook.build_chunk_text(chunks, len(chunks)) == "")


def test_plan_chunks_oversized_truncation():
    print("hook plan_chunks single oversized block (QA CASE 3):")
    huge = "### giant day\n" + ("y" * 20000)
    chunks = hook.plan_chunks([huge])
    check("oversized block → exactly one chunk", len(chunks) == 1)
    txt = hook.build_chunk_text(chunks, 0)
    check("truncation flag appended", "[truncated" in txt)
    check("chunk stays within stdout budget", len(txt) <= hook.PAYLOAD_BUDGET)


def test_render_blocks_flags():
    print("hook render_blocks flags fallback / stored-stale:")
    view = {"fresh": [("2026-06-17", 1, 2, "verbatim text")],
            "tail": [("2026-05-01", "gist", 48, 1, "g", "stored"),
                     ("2026-04-01", "gist", 78, 1, "f", "fallback"),
                     ("2026-01-01", "era", 168, 1, "s", "stored-stale")]}
    blocks = hook.render_blocks(view)
    joined = "\n".join(blocks)
    check("fresh rendered verbatim", "verbatim text" in joined and "FRESH" in joined)
    check("fallback flagged uncompressed", "uncompressed — pending weekly compression" in joined)
    check("stored-stale flagged pending recompression", "pending recompression" in joined)


def test_hook_overflow_warning():
    print("hook overflow warning fires on last configured chunk (QA gap):")
    big_view = {"fresh": [], "tail": [(f"2026-{m:02d}-01", "gist", 60, 1, "z" * 4000, "stored")
                                      for m in range(1, 13)]}
    fake_ea = types.SimpleNamespace(load_view=lambda conn: big_view)
    orig_helpers, orig_payload = hook.load_helpers, hook.read_payload
    hook.load_helpers = lambda: fake_ea
    hook.read_payload = lambda: {"source": "startup"}
    try:
        # Many 4000-char blocks → far more than 4 chunks. Warning only on chunk == max-1.
        last = hook._main_inner(types.SimpleNamespace(chunk=3, max_entries=4))
        mid = hook._main_inner(types.SimpleNamespace(chunk=0, max_entries=4))
        check("overflow warning present on last configured chunk", "AUTOBIOGRAPHY CONFIG" in last)
        check("no overflow warning on chunk 0", "AUTOBIOGRAPHY CONFIG" not in mid)
    finally:
        hook.load_helpers, hook.read_payload = orig_helpers, orig_payload


def test_hook_empty_view():
    print("hook empty view → benign skip, not an error:")
    fake_ea = types.SimpleNamespace(load_view=lambda conn: {"fresh": [], "tail": []})
    orig_helpers, orig_payload = hook.load_helpers, hook.read_payload
    hook.load_helpers = lambda: fake_ea
    hook.read_payload = lambda: {"source": "startup"}
    try:
        c0 = hook._main_inner(types.SimpleNamespace(chunk=0, max_entries=4))
        c1 = hook._main_inner(types.SimpleNamespace(chunk=1, max_entries=4))
        check("chunk 0 says 'no day-entries'", "no day-entries" in c0)
        check("chunk 1 silent", c1 == "")
    finally:
        hook.load_helpers, hook.read_payload = orig_helpers, orig_payload


def test_hook_import_unavailable():
    print("hook import-unavailable → exit 0 + [UNAVAILABLE] (always-exit-0 contract):")
    orig_helpers, orig_payload = hook.load_helpers, hook.read_payload

    def boom():
        raise hook.AutobiographyUnavailable("ModuleNotFoundError: simulated repo-moved")
    hook.load_helpers = boom
    hook.read_payload = lambda: {"source": "startup"}
    try:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = hook.main()
        out = buf.getvalue()
        check("main() returns 0", rc == 0)
        check("envelope labeled [UNAVAILABLE]", "[UNAVAILABLE]" in out)
    finally:
        hook.load_helpers, hook.read_payload = orig_helpers, orig_payload


def test_warn_if_slow():
    print("hook warn_if_slow fires above the threshold, silent below:")
    orig = hook.HOOK_EXEC_LOG
    tmp = pathlib.Path("/tmp/claude/test_slowwarn.log")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text("")
    hook.HOOK_EXEC_LOG = tmp
    try:
        hook.warn_if_slow(time.monotonic() - 5.0, "TestSlow")   # 5s elapsed → over 4s threshold
        hook.warn_if_slow(time.monotonic(), "TestFast")          # ~0s → silent
        lines = tmp.read_text().splitlines()
        check("slow run wrote exactly one WARN", len([l for l in lines if "slow SessionStart hook" in l]) == 1)
        check("the WARN names the slow hook + is health-check-parseable",
              any("TestSlow" in l and " | WARN:" in l for l in lines))
        check("fast run wrote nothing", not any("TestFast" in l for l in lines))
    finally:
        hook.HOOK_EXEC_LOG = orig
        tmp.unlink(missing_ok=True)


# ── Part 4 — live hook subprocess smoke (read-only) ─────────────────────────────

def _run_hook(chunk, source="startup"):
    payload = json.dumps({"source": source, "cwd": "/home/dustin/Claude"})
    return subprocess.run([sys.executable, HOOK_PATH, f"--chunk={chunk}", "--max-entries=4"],
                          input=payload, capture_output=True, text=True, timeout=30)


def test_live_hook_smoke():
    print("live hook smoke (read-only, real memory.db):")
    r = _run_hook(0)
    check("hook exits 0", r.returncode == 0)
    out = r.stdout.strip()
    check("chunk 0 within stdout cap", len(out) <= 10000)
    try:
        env = json.loads(out.splitlines()[0]) if out else {}
        ctx = env.get("hookSpecificOutput", {}).get("additionalContext", "")
        check("chunk 0 is a valid SessionStart envelope",
              env.get("hookSpecificOutput", {}).get("hookEventName") == "SessionStart")
        # Distinguish a HEALTHY load (chunk framing) from a degraded/error envelope —
        # the previous "EPISODIC AUTOBIOGRAPHY in ctx" assertion was vacuous (every error
        # envelope contains that string too).
        check("chunk 0 is a real load, not an error envelope",
              ("(chunk 1 of" in ctx) or ("no day-entries" in ctx) or ("memory.db not found" in ctx))
        check("no error label in a healthy load",
              not any(lbl in ctx for lbl in ("[FAILED]", "[DB ERROR]", "[UNAVAILABLE]", "[BAD ARGS]")))
    except (json.JSONDecodeError, IndexError):
        check("chunk 0 parses as JSON", False)
    rr = _run_hook(0, source="resume")
    check("resume exits 0 and says 'resume detected'", rr.returncode == 0 and "resume detected" in rr.stdout)
    check("far past-end chunk silent", _run_hook(9).stdout.strip() == "")


if __name__ == "__main__":
    for t in (test_format_roundtrip, test_read_stored_malformed, test_plan_work,
              test_plan_work_era_create, test_plan_work_zombie_fresh, test_load_view,
              test_format_plan_render, test_decay_date_edges, test_plan_chunks_basic,
              test_plan_chunks_oversized_truncation, test_render_blocks_flags,
              test_hook_overflow_warning, test_hook_empty_view, test_hook_import_unavailable,
              test_warn_if_slow, test_live_hook_smoke):
        t()
    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)
