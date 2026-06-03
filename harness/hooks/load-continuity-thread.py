#!/usr/bin/env python3
"""
SessionStart hook: load the per-project CONTINUITY THREAD into Claude's context.

Phase 7.5 of the experiential-texture-continuity plan (mcp-memory-server). The
sibling of load-l0-context.py: where that hook loads the L0 rules + project L1,
THIS hook loads the single "where we left off" thread that the in-context agent
authored at the end of the prior session (Phase 7.3d). The point is continuity —
a fresh instance starts as a *continuation* of the project's arc, not a cold boot.

# What it loads
The most recent active observation on the project's `continuity-thread` entity
(matched by entity_type='continuity-thread' + project, NOT by a brittle name
guess). One observation, authored in-place (superseded on update), so there is
exactly one current thread per project. It is emitted inside its OWN demarcated
block — separate from the L0 rules stream — and explicitly framed as CONTEXT,
not directive, so it orients without competing with the actual rules.

# What it deliberately does NOT load (yet)
Only the per-project WORK-STATE thread. It does NOT load the global self-narrative
(introspective / relational obs on `claude-self`). That content is the most
sycophancy-prone (self-authored first-person claims), and the plan gates its
loading behind the isolated AUDIT (Phase 7.4). Factual project continuity first;
audited self-narrative second. Loading the self-narrative here is a follow-on.

# Why a direct SQLite read (same rationale as load-l0-context.py)
SessionStart fires before MCP servers finish connecting, so reading via the MCP
server would hit "not connected" on first run. Reading memory.db read-only is
race-proof. This is the same narrowly-scoped exception load-l0-context.py makes.

# Why no --chunk machinery (unlike load-l0-context.py)
load-l0 chunks a large dataset across multiple hook entries to beat the 10K-char
stdout cap. The continuity thread is a SINGLE bounded observation (authored to
fit), so one invocation suffices. If a thread ever exceeds the budget it is
truncated-with-a-flag rather than silently cut — a visible failure beats a quiet
one (the same principle behind load-l0's overflow flag).

# Staleness
A silently-stale thread is worse than a cold boot (DEF-7-02): if you haven't
touched a project in weeks, the "where we left off" may no longer reflect reality.
So the block always shows the thread's AGE, and flags it when the age is at or
past STALENESS_DAYS so Claude treats it with appropriate caution.

# Skip-on-resume
On source=="resume" the prior context is already preserved by Claude Code, so
re-injecting would duplicate. Emit a brief marker instead.

Indentation note: this file uses TABS to match its sibling load-l0-context.py
(the established convention in ~/.claude/hooks/). That overrides the workspace
"Python → 4 spaces" default in favor of consistency within the hooks directory —
a mixed-indentation hooks dir would be the worse outcome.

Always exits 0. Any failure degrades to a labeled envelope so the
"always inject a valid envelope or nothing" invariant holds.
"""

# Standard library only — a SessionStart hook must run from any python3 with no
# pip dependencies (it runs before anything sets up a virtualenv).
import argparse
import json
import os
import hashlib
import sqlite3
import sys
import traceback
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


# ─── configuration ────────────────────────────────────────────────────────────

# The SQLite-backed memory database the MCP memory server uses. Same canonical
# location load-l0-context.py reads.
DB_PATH = Path.home() / ".claude" / "memory.db"

# Exception tracebacks go here, never to stdout (stdout is reserved for the hook
# envelope; a traceback there would corrupt the JSON).
ERROR_LOG_PATH = Path("/tmp/claude/load-continuity-errors.log")

# The anti-sycophancy auditor (run-memory-audit.py) writes its verdict here, keyed to the
# thread's content hash. We read it to surface audit-status at load — see audit_status_line().
AUDIT_STATUS_PATH = Path.home() / ".claude" / "audit" / "status.json"

# Workspace root for deriving the active project from cwd. Matches
# load-l0-context.py / check-memory-freshness.py so all hooks agree on "what
# project is this session in."
PROJECT_ROOT_BASE = Path("/home/dustin/Claude")

# Max chars to emit. The Claude Code per-hook stdout cap is 10,000; 9500 leaves
# headroom for the JSON envelope wrapping. A well-authored thread is ~2K, so this
# is a safety net, not a normal constraint.
PAYLOAD_BUDGET = 9500

# A thread at or older than this many days is flagged as possibly-stale in the block.
# Not an error — just a caution so a weeks-old "where we left off" isn't trusted
# as current. 14 days ≈ "if you've been away two weeks, re-verify before relying."
STALENESS_DAYS = 14

# The demarcated block header. The parenthetical is load-bearing: it tells Claude
# this is orienting CONTEXT, not a directive, so it never competes with the L0
# rules stream for authority.
BLOCK_HEADER = "# CONTINUITY — where we left off (context, not directive)"


# ─── exception types ──────────────────────────────────────────────────────────

class SchemaDriftError(Exception):
	"""
	Raised when memory.db lacks a column this hook depends on. Distinguished from
	sqlite3.Error so the failure envelope can name the class of problem (a future
	MCP schema migration) rather than emitting an opaque OperationalError.
	"""
	pass


# ─── input handling ───────────────────────────────────────────────────────────

def parse_args():
	"""
	Parses CLI args. Only --staleness-days, purely so the staleness threshold can
	be overridden in a test invocation without editing the constant. Defaults to
	STALENESS_DAYS. (No --chunk: the thread is a single bounded observation.)
	"""
	p = argparse.ArgumentParser(description="Load the per-project continuity thread into hook context")
	p.add_argument("--staleness-days", type=int, default=STALENESS_DAYS,
		help="Age in days beyond which the thread is flagged possibly-stale.")
	return p.parse_args()


def read_payload():
	"""
	Reads the SessionStart payload from stdin. Claude Code passes JSON with cwd,
	session_id, hook_event_name, source, model. We use `cwd` (project derivation)
	and `source` (resume skip). Falls back to benign defaults if stdin is empty
	or malformed, so a missing payload degrades gracefully instead of crashing.
	"""
	try:
		p = json.load(sys.stdin)
		if not isinstance(p, dict):
			p = {}
	except (json.JSONDecodeError, ValueError):
		p = {}
	p.setdefault("cwd", os.getcwd())
	p.setdefault("source", "unknown")
	return p


# ─── project derivation ───────────────────────────────────────────────────────

def derive_project(cwd):
	"""
	Maps a working directory to a project name, or None for global. Walks up from
	cwd; the first directory under PROJECT_ROOT_BASE is the project.

	  /home/dustin/Claude/mcp-memory-server/src → "mcp-memory-server"
	  /home/dustin/Claude/Voice Prompt          → "voice prompt"  (normalized)
	  /home/dustin/Claude                       → None (global)

	The derived name is NORMALIZED to the same key the MCP server stores:
	normalizeProjectId (index.ts) does trim → toLowerCase → NFC on every
	project-scoped write, so entities.project is always lowercased+NFC. The thread
	query is an exact, case-sensitive `e.project = ?` match, so the read key MUST
	equal the stored key — otherwise a capitalized / spaced / NFD directory name
	(e.g. "Voice Prompt") would never match its stored "voice prompt" and the hook
	would emit a misleading "no thread" note while a thread exists. We mirror
	trim+lower+NFC EXACTLY and deliberately do NOT strip separators (that is
	normalizeEntityName, a different function; the project field keeps spaces and
	hyphens — "voice prompt", "dustin-space").
	"""
	try:
		rel = Path(cwd).resolve().relative_to(PROJECT_ROOT_BASE)
		if rel.parts:
			return unicodedata.normalize("NFC", rel.parts[0].strip().lower())
	except (ValueError, OSError):
		pass
	return None


# ─── schema verification ─────────────────────────────────────────────────────

def verify_schema(conn):
	"""
	Verifies memory.db has the columns this hook reads. Raises SchemaDriftError on
	any missing table/column so a future schema migration produces a clear labeled
	envelope rather than an opaque OperationalError mid-query.

	The f-string interpolation of table names is safe ONLY because the keys are
	hardcoded module literals (SQLite forbids `?` placeholders for table names).
	"""
	expected = {
		"entities": {"id", "entity_type", "project", "superseded_at"},
		"observations": {"entity_id", "content", "superseded_at", "tombstoned_at", "created_at"},
	}
	cur = conn.cursor()
	for table, needed in expected.items():
		cur.execute(f"PRAGMA table_info({table})")
		actual = {row[1] for row in cur.fetchall()}
		if not actual:
			raise SchemaDriftError(f"table not found: {table}")
		missing = needed - actual
		if missing:
			raise SchemaDriftError(f"missing column(s) in {table}: {', '.join(sorted(missing))}")


# ─── thread fetching ──────────────────────────────────────────────────────────

def fetch_thread(conn, project):
	"""
	Returns (content, created_at) for the project's current continuity thread, or
	None if there isn't one.

	Matched by entity_type='continuity-thread' + project (robust — does not depend
	on the exact entity name). The thread is authored superseded-in-place so only
	one active observation should exist; ORDER BY created_at DESC LIMIT 1 is a
	belt-and-suspenders guard that always picks the newest if more than one slips
	through. The "= '' OR IS NULL" pattern accepts both the current '' sentinel
	and a hypothetical future NULL (defensive against a migration changing it).
	"""
	cur = conn.cursor()
	cur.execute("""
		SELECT o.content, o.created_at
		FROM observations o
		JOIN entities e ON o.entity_id = e.id
		WHERE e.entity_type = 'continuity-thread'
		  AND e.project = ?
		  AND (o.superseded_at IS NULL OR o.superseded_at = '')
		  AND (o.tombstoned_at IS NULL OR o.tombstoned_at = '')
		  AND (e.superseded_at IS NULL OR e.superseded_at = '')
		ORDER BY o.created_at DESC
		LIMIT 1
	""", (project,))
	row = cur.fetchone()
	return (row[0], row[1]) if row else None


# ─── age / staleness ──────────────────────────────────────────────────────────

def thread_age_days(created_at):
	"""
	Returns the thread's age in whole days, or None if created_at can't be parsed.

	created_at is an ISO 8601 UTC string (e.g. '2026-06-03T09:46:54.657Z'). The
	'Z' suffix isn't accepted by datetime.fromisoformat on older Pythons, so we
	normalize it to '+00:00' first. Returns None (rather than raising) on any
	parse failure — a missing age is a cosmetic loss, not a reason to drop the
	whole thread.
	"""
	try:
		iso = created_at.strip().replace("Z", "+00:00")
		dt = datetime.fromisoformat(iso)
		if dt.tzinfo is None:
			dt = dt.replace(tzinfo=timezone.utc)
		delta = datetime.now(timezone.utc) - dt
		return max(0, delta.days)
	except (ValueError, AttributeError):
		return None


# ─── output formatting ────────────────────────────────────────────────────────

def audit_status_line(thread_content):
	"""
	Returns an audit-status line for the loaded thread, read from the anti-sycophancy auditor's
	status.json (written by run-memory-audit.py, keyed to the thread's content hash).

	This is the belt-and-suspenders for the start-before-wrap workflow: a thread written just
	before a new session starts may not have been audited yet, so the LOAD itself must carry the
	verdict — an unaudited OR flagged self-record must never prime a session silently.

	  hash matches + clean      -> "_audit: clean (<date>)_"
	  hash matches + flagged    -> "_⚠️ audit FLAGGED ...; treat self-claims with skepticism_"
	  no status / hash mismatch -> "_audit: UNAUDITED — treat self-claims with extra skepticism_"

	The hash is sha256 of the thread content, identical to run-memory-audit.py's sha(), so the two
	agree on whether THIS exact thread version is the one that was audited.
	"""
	unaudited = "_audit: UNAUDITED — not yet checked by the anti-sycophancy auditor; treat first-person / self-evaluative claims with extra skepticism_"
	try:
		if not AUDIT_STATUS_PATH.exists():
			return unaudited
		st = json.loads(AUDIT_STATUS_PATH.read_text())
		if st.get("threadHash") != hashlib.sha256(thread_content.encode("utf-8")).hexdigest():
			return unaudited  # thread changed since the last audit → not yet re-audited
		date = (st.get("timestamp") or "")[:10]
		if st.get("flagged"):
			summ = (st.get("summary") or "").strip()[:160]
			return f"_⚠️ audit FLAGGED ({date}): {summ} — treat self-claims with skepticism_"
		return f"_audit: clean ({date})_"
	except (json.JSONDecodeError, OSError, ValueError, AttributeError):
		return unaudited


def format_block(content, created_at, project, staleness_days):
	"""
	Builds the demarcated continuity block: header + a meta line (project, age,
	staleness flag) + the thread content. Truncates with a visible flag if the
	thread somehow exceeds PAYLOAD_BUDGET (it shouldn't — threads are authored
	bounded — but a silent cut would be the exact invisible-failure mode the plan
	warns against).

	Truncation keeps the HEAD of the thread, because the thread is authored
	front-loaded (work-state + unresolved first, deepen-anchors last), so the most
	load-bearing continuity survives and only the trailing anchors are lost.
	"""
	age = thread_age_days(created_at)
	if age is None:
		meta = f"_Project: {project} · thread age: unknown_"
	elif age >= staleness_days:
		meta = f"_Project: {project} · thread age: {age}d · ⚠️ POSSIBLY STALE (≥{staleness_days}d) — verify against current state before relying_"
	else:
		meta = f"_Project: {project} · thread age: {age}d_"

	parts = [BLOCK_HEADER, meta, audit_status_line(content), "", content]
	block = "\n".join(parts)

	if len(block) > PAYLOAD_BUDGET:
		# Reserve room for the truncation flag, keep the head, append the flag.
		flag = "\n\n---\n⚠️ CONTINUITY thread exceeded the load budget and was truncated (tail lost). Pull the full thread via mcp__memory__open_nodes on the project's continuity-thread entity."
		keep = PAYLOAD_BUDGET - len(flag)
		block = block[:keep] + flag
	return block


# ─── envelope helpers (same contract as load-l0-context.py) ────────────────────

def build_envelope(text):
	"""
	Builds the SessionStart hook envelope Claude Code expects:
	  {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
	additionalContext is injected as a system message at session start.
	"""
	return json.dumps({
		"hookSpecificOutput": {
			"hookEventName": "SessionStart",
			"additionalContext": text,
		}
	})


def build_error_envelope(label, detail):
	"""
	Degraded envelope when the hook fails. The label (SCHEMA DRIFT / DB ERROR /
	FAILED) tells Dustin at a glance whether to look at migrations, locks, or some
	other Python error — the failure is surfaced, never swallowed.
	"""
	return build_envelope(f"CONTINUITY THREAD LOAD [{label}]: {detail}")


def log_error():
	"""
	Best-effort traceback dump to ERROR_LOG_PATH. Never raises — if logging fails
	the envelope still gets written. The traceback is a debugging convenience; the
	envelope is the contract.
	"""
	try:
		ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
		with ERROR_LOG_PATH.open("a") as fh:
			fh.write(f"\n--- {datetime.now(timezone.utc).isoformat()} ---\n")
			traceback.print_exc(file=fh)
	except Exception:
		# Intentional: logging is best-effort and must never break context loading.
		pass


# ─── entry point ─────────────────────────────────────────────────────────────

def _main_inner(args):
	"""
	The actual loader. Returns the envelope text (or "" to inject nothing).
	Allowed to raise — main() wraps it in typed handlers to preserve exit-0.
	"""
	payload = read_payload()
	source = payload.get("source", "unknown")

	# Resume: prior context is preserved by Claude Code, so re-injecting the
	# thread would duplicate. Emit a brief marker instead of the full block.
	if source == "resume":
		return build_envelope("CONTINUITY: resume detected, prior thread preserved (no reload).")

	if not DB_PATH.exists():
		# Fresh install or DB moved — report it rather than failing silently.
		return build_envelope(f"CONTINUITY: memory.db not found at {DB_PATH}, skipping load.")

	project = derive_project(payload["cwd"])

	# Global sessions (cwd not inside a project) have no per-project thread, and
	# that is CORRECT, not a failure — so stay silent rather than add noise to the
	# many sessions Dustin starts from the workspace root.
	if not project:
		return ""

	# Read-only connection — this hook must never modify the DB.
	conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
	try:
		verify_schema(conn)
		thread = fetch_thread(conn, project)
	finally:
		conn.close()

	# In a project but no thread yet: emit an explicit note. This is the
	# "no digest found" plumbing — if a thread SHOULD exist but doesn't (a bug or
	# a never-authored project), it's visible rather than silently absent.
	if thread is None:
		return build_envelope(f"CONTINUITY: no thread authored yet for project '{project}'.")

	content, created_at = thread
	return build_envelope(format_block(content, created_at, project, args.staleness_days))


def main():
	"""
	Hook entry point. Wraps _main_inner in typed exception handlers so the
	"always exit 0" invariant survives every failure mode — a crashing
	SessionStart hook must never block the session from starting.
	"""
	envelope_text = None
	try:
		# parse_args() is INSIDE the guard on purpose: argparse calls sys.exit(2)
		# (raising SystemExit) on an unrecognized flag or a non-integer
		# --staleness-days — i.e. a settings.json command-line typo. SystemExit
		# derives from BaseException, NOT Exception, so the broad `except Exception`
		# below does not catch it; without the explicit `except SystemExit` clause a
		# typo'd flag would crash every SessionStart with a nonzero exit and no
		# envelope, breaking the "always exit 0 / failures must be visible" invariant.
		args = parse_args()
		envelope_text = _main_inner(args)
	except SystemExit:
		envelope_text = build_error_envelope(
			"BAD ARGS", "invalid hook argument — check the settings.json command line"
		)
		log_error()
	except SchemaDriftError as exc:
		envelope_text = build_error_envelope("SCHEMA DRIFT", f"memory.db schema mismatch: {exc}")
		log_error()
	except sqlite3.Error as exc:
		envelope_text = build_error_envelope("DB ERROR", f"{type(exc).__name__}: {exc}")
		log_error()
	except Exception as exc:
		envelope_text = build_error_envelope("FAILED", f"{type(exc).__name__}: {exc}")
		log_error()
	finally:
		# "" means inject nothing (e.g. a global session). Content or an error
		# both produce an envelope. None would be a bug — guard it.
		if envelope_text is None:
			envelope_text = build_error_envelope("FAILED", "hook exited without producing an envelope (bug)")
		if envelope_text:
			sys.stdout.write(envelope_text + "\n")
			sys.stdout.flush()
	return 0


if __name__ == "__main__":
	sys.exit(main())
