#!/usr/bin/env python3
"""
SessionStart hook: load MCP memory L0 (and active-project L1) into Claude's context.

Replaces the previous static "you MUST load memory" reminder with content actually
injected into the conversation, removing the bypass path that produced the
2026-05-20 incident where Claude skipped MCP context loading on a "what do you
know about me" query.

Reads memory.db directly via SQLite (NOT via MCP server, which docs warn may not
be connected yet at SessionStart). Output is a `hookSpecificOutput.additionalContext`
JSON envelope.

# Why this script accepts `--chunk=N` and why settings.json has multiple entries

Claude Code caps each hook invocation's stdout at 10,000 characters (verified at
code.claude.com/docs/en/hooks). The cap is per-stdout, not per-envelope-field —
a single invocation can't loop and emit multiple envelopes to escape it. The only
way to inject more than 10K chars at session start is multiple HOOK INVOCATIONS,
which compose per the docs: "When several hooks return additionalContext for the
same event, Claude receives all of the values."

So settings.json declares N SessionStart hook entries, each invoking this script
with a different `--chunk` index. Each invocation is stateless: it walks
observations in a deterministic order (importance desc, then created_at desc),
groups them into chunks that each fit within ~9500 chars, and emits the chunk
matching its index. Invocations past the end of the data emit nothing.

# Why direct SQLite read instead of MCP

Docs warn: "SessionStart and Setup typically fire before servers finish
connecting, so hooks on these events should expect the 'not connected' error on
first run." Direct read at ~/.claude/memory.db is race-proof. This is a narrowly
scoped exception to MCP-is-canonical — every other code path uses MCP normally.

# Skip-on-resume

When source=="resume", prior session context is preserved by Claude Code itself,
so re-injecting L0 would just duplicate what's already there. Chunk 0 emits a
brief skip marker; subsequent chunks stay silent.

Always exits 0. Errors degrade to a labeled envelope so the
"always inject a valid envelope or nothing" invariant is preserved.
"""

# Standard library only — hook must run from any python3, no pip deps.
import argparse
import json
import os
import sqlite3
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path


# ─── configuration ────────────────────────────────────────────────────────────

# Path to the SQLite-backed memory database the MCP memory server uses.
# Verified via the windows-claude-install-decisions-2026-05-03 memory:
# MEMORY_FILE_PATH=/home/dustin/.claude/memory.db is the canonical location.
DB_PATH = Path.home() / ".claude" / "memory.db"

# Where exception tracebacks go. Stdout is reserved for the hook envelope; if
# we wrote tracebacks there it'd corrupt the JSON.
ERROR_LOG_PATH = Path("/tmp/claude/load-l0-errors.log")

# Per-invocation payload budget. The Claude Code cap on hook output is 10,000
# chars total (stdout). 9500 leaves ~500 chars for the JSON envelope wrapping
# overhead (keys, quotes, escaping) plus a small safety margin.
PAYLOAD_BUDGET = 9500

# Workspace root for deriving the active project name from cwd. Matches
# check-memory-freshness.py for consistency across hooks.
PROJECT_ROOT_BASE = Path("/home/dustin/Claude")

# Header reminder appended to chunk 0 only. Items that aren't in the DB but
# Claude should be aware of at session start. Kept short — counts against
# chunk 0's budget.
CHUNK0_HEADER_NOTE = (
	"_Briefly state what's loaded and any warnings before responding. "
	"Anti-sycophancy file at ~/.claude/projects/-home-dustin-Claude/memory/"
	"feedback_anti_sycophancy_system.md — re-read if relational or strategic "
	"work follows. Code changes → run the Post-Coding Process (CLAUDE.md)._"
)


# ─── exception types ──────────────────────────────────────────────────────────

class SchemaDriftError(Exception):
	"""
	Raised when memory.db schema doesn't have a column this script depends on.
	Distinguished from sqlite3.Error so the failure envelope can name the
	specific class of problem (schema migration vs lock contention vs other).
	"""
	pass


# ─── input handling ───────────────────────────────────────────────────────────

def parse_args():
	"""
	Parses CLI args.

	--chunk=N : zero-based chunk index. Each settings.json hook entry passes
	  a different N (0..max_entries-1) so the entries collectively cover the
	  full L0+L1 dataset.

	--max-entries=M : the total number of SessionStart entries pointing at
	  this script. Used to detect overflow — when actual chunks needed
	  exceeds M, the last configured entry (chunk == M-1) appends a visible
	  warning so future L0 growth produces a loud alert at session start
	  instead of silent data loss. Default 999 = effectively no warning,
	  for manual single-shot testing.
	"""
	p = argparse.ArgumentParser(description="Load L0+project-L1 into hook context")
	# type=int forces validation; bad input crashes early rather than emitting
	# a confusing chunk 0 output when N was supposed to be 4.
	p.add_argument("--chunk", type=int, default=0,
		help="Zero-based chunk index. Multiple hook entries pass 0..N-1.")
	p.add_argument("--max-entries", type=int, default=999,
		help="Number of configured SessionStart entries. Triggers overflow warning when total chunks exceed this.")
	return p.parse_args()


def read_payload():
	"""
	Reads the SessionStart hook payload from stdin.

	Claude Code passes JSON with cwd, session_id, hook_event_name, source, model.
	We use `cwd` (for project derivation) and `source` (for resume skip).
	source ∈ {startup, resume, clear, compact}.

	Falls back to benign defaults if stdin is empty or malformed.
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
	Maps a working directory to a project name, or None for global.

	Walks up from cwd; the first directory under PROJECT_ROOT_BASE is the
	project. Same logic as check-memory-freshness.py.

	Examples:
	  /home/dustin/Claude/dustin-space/src  → "dustin-space"
	  /home/dustin/Claude                   → None (global)
	  /home/dustin                          → None (outside workspace)
	"""
	try:
		rel = Path(cwd).resolve().relative_to(PROJECT_ROOT_BASE)
		if rel.parts:
			return rel.parts[0]
	except (ValueError, OSError):
		pass
	return None


# ─── schema verification ─────────────────────────────────────────────────────

def verify_schema(conn):
	"""
	Verifies memory.db has the columns this script depends on.

	Raises SchemaDriftError on any missing table/column so a future MCP schema
	migration produces a clear envelope rather than an opaque OperationalError.

	Note: SQLite doesn't allow `?` placeholders for table names. The f-string
	interpolation is safe ONLY because the dict keys are module constants.
	"""
	expected = {
		"entities": {"id", "name", "project", "superseded_at"},
		"observations": {
			"entity_id", "content", "context_layer", "importance",
			"memory_type", "superseded_at", "tombstoned_at", "created_at",
		},
	}
	cur = conn.cursor()
	for table, needed in expected.items():
		cur.execute(f"PRAGMA table_info({table})")
		actual = {row[1] for row in cur.fetchall()}
		if not actual:
			raise SchemaDriftError(f"table not found: {table}")
		missing = needed - actual
		if missing:
			raise SchemaDriftError(
				f"missing column(s) in {table}: {', '.join(sorted(missing))}"
			)


# ─── observation fetching ────────────────────────────────────────────────────

def fetch_observations(conn, project):
	"""
	Returns the ordered list of observations to chunk and emit.

	Each row is (layer_label, entity_name, memory_type, importance, content).
	L0 first (always loaded, global scope), then project L1 (if a project is
	active). Within each layer, importance desc then created_at desc — same
	ordering get_context_layers uses, so chunks are deterministic.

	Filters: observation is active (superseded_at + tombstoned_at empty),
	entity is active. The "= '' OR IS NULL" pattern accepts both the current
	'' sentinel and a hypothetical future NULL — defensive against migration.
	"""
	cur = conn.cursor()
	rows = []
	# L0 — always loaded, no project filter
	cur.execute("""
		SELECT 'L0', e.name, o.memory_type, o.importance, o.content
		FROM observations o
		JOIN entities e ON o.entity_id = e.id
		WHERE o.context_layer = 'L0'
		  AND (o.superseded_at IS NULL OR o.superseded_at = '')
		  AND (o.tombstoned_at IS NULL OR o.tombstoned_at = '')
		  AND (e.superseded_at IS NULL OR e.superseded_at = '')
		ORDER BY o.importance DESC, o.created_at DESC
	""")
	rows.extend(cur.fetchall())
	# L1 — project-scoped, only loaded when cwd is inside a project
	if project:
		cur.execute("""
			SELECT 'L1', e.name, o.memory_type, o.importance, o.content
			FROM observations o
			JOIN entities e ON o.entity_id = e.id
			WHERE o.context_layer = 'L1'
			  AND e.project = ?
			  AND (o.superseded_at IS NULL OR o.superseded_at = '')
			  AND (o.tombstoned_at IS NULL OR o.tombstoned_at = '')
			  AND (e.superseded_at IS NULL OR e.superseded_at = '')
			ORDER BY o.importance DESC, o.created_at DESC
		""", (project,))
		rows.extend(cur.fetchall())
	return rows


# ─── output formatting ───────────────────────────────────────────────────────

def format_observation(layer, entity_name, mtype, importance, content):
	"""
	Formats one observation as a markdown block with a layer-tagged header.

	Importance: whole numbers render without ".0" (5.0 → 5), fractional values
	keep one decimal (4.5 stays 4.5).
	"""
	mtype_str = mtype or "?"
	if importance == int(importance):
		imp_str = str(int(importance))
	else:
		imp_str = f"{importance:g}"
	return f"### [{layer}] {entity_name} ({mtype_str}, imp={imp_str})\n{content}\n"


def plan_chunks(rows, project):
	"""
	Walks observations in order and groups them into chunks that each fit the
	budget. Returns a list of lists of row indices.

	Algorithm: open a chunk with its header in the running length. Add
	observations one at a time; when adding the next would exceed budget,
	close the current chunk and start a new one with just that observation.
	No observation is split across chunks.

	Chunk 0 reserves CHUNK0_HEADER_NOTE space; chunks 1+ get the full budget.
	This avoids the "find the last chunk to inject a tail" complexity — the
	important session-start instructions go up-front in chunk 0.
	"""
	chunks = []
	current = []
	# Per-chunk fixed header: "# MEMORY (chunk X of Y, project=Z)\n\n"
	# Use a stable upper estimate so planning is consistent. ~80 chars covers
	# "# MEMORY (chunk 99 of 99, project=longer-project-name)" + two newlines.
	header_size = 80
	chunk0_extra = len(CHUNK0_HEADER_NOTE) + 4  # +4 for surrounding blank lines

	# Budget for the current chunk — different for chunk 0.
	def chunk_budget(chunk_idx):
		return PAYLOAD_BUDGET - header_size - (chunk0_extra if chunk_idx == 0 else 0)

	current_len = 0
	current_budget = chunk_budget(0)
	for i, row in enumerate(rows):
		obs_text = format_observation(*row)
		# +1 for the newline between this observation and the previous content.
		add_size = len(obs_text) + 1
		if current_len + add_size > current_budget and current:
			# Close current chunk, open a new one with this observation as its
			# first content. The new chunk's budget is the non-chunk-0 size.
			chunks.append(current)
			current = [i]
			current_budget = chunk_budget(len(chunks))
			current_len = add_size
		else:
			current.append(i)
			current_len += add_size
	if current:
		chunks.append(current)
	return chunks


def build_chunk_text(rows, chunks, chunk_index, project):
	"""
	Builds the additionalContext text for one chunk.

	Returns the text, or empty string for past-end chunks (signals the caller
	to emit an empty envelope or skip).

	Chunk 0 includes CHUNK0_HEADER_NOTE up front; chunks 1+ are just header +
	observations. Every chunk indicates its position ("chunk X of Y") so Claude
	can see when content ends.
	"""
	total = len(chunks)
	if chunk_index >= total:
		return ""  # past the end — emit empty/no-op

	indices = chunks[chunk_index]
	parts = [
		f"# MEMORY (chunk {chunk_index + 1} of {total}, project={project or 'global'})",
		""
	]
	if chunk_index == 0:
		parts.append(CHUNK0_HEADER_NOTE)
		parts.append("")
	for i in indices:
		parts.append(format_observation(*rows[i]))
	return "\n".join(parts)


# ─── envelope helpers ────────────────────────────────────────────────────────

def build_envelope(text):
	"""
	Builds the Claude Code SessionStart hook envelope. Verified shape:
	  {"hookSpecificOutput": {
	      "hookEventName": "SessionStart",
	      "additionalContext": "..."
	  }}

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
	Degraded envelope when the hook fails. Label classifies the failure
	class (SCHEMA DRIFT, DB ERROR, FAILED) so the user can tell at a glance
	whether to look at migrations, locks, or some other Python error.
	"""
	return build_envelope(f"MEMORY L0 LOAD [{label}]: {detail}")


def log_error():
	"""
	Best-effort traceback dump. Never raises — if logging fails the envelope
	still gets written. Traceback is a debugging convenience; the envelope
	is the contract.
	"""
	try:
		ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
		with ERROR_LOG_PATH.open("a") as fh:
			fh.write(f"\n--- {datetime.now(timezone.utc).isoformat()} ---\n")
			traceback.print_exc(file=fh)
	except Exception:
		# Intentional: logging is best-effort.
		pass


# ─── entry point ─────────────────────────────────────────────────────────────

def _main_inner(args):
	"""
	The actual loader logic. Returns the envelope text. Allowed to raise.
	"""
	payload = read_payload()
	source = payload.get("source", "unknown")

	# Skip reload on resume — prior session context is preserved by Claude
	# Code itself, so re-injecting would just duplicate. Chunk 0 emits a
	# brief marker; chunks 1+ stay silent (empty envelope, no injection).
	if source == "resume":
		if args.chunk == 0:
			return build_envelope(
				"MEMORY: resume detected, prior context preserved (no reload)."
			)
		return ""  # silent — no additionalContext injection

	if not DB_PATH.exists():
		# Fresh install or DB moved. Chunk 0 reports; others silent.
		if args.chunk == 0:
			return build_envelope(
				f"MEMORY: memory.db not found at {DB_PATH}, skipping load."
			)
		return ""

	project = derive_project(payload["cwd"])

	# Read-only connection — this hook should never modify the DB.
	conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
	try:
		verify_schema(conn)
		rows = fetch_observations(conn, project)
	finally:
		conn.close()

	if not rows:
		if args.chunk == 0:
			return build_envelope(
				f"MEMORY: no active L0/L1 observations found (project={project or 'global'})."
			)
		return ""

	chunks = plan_chunks(rows, project)
	text = build_chunk_text(rows, chunks, args.chunk, project)
	if not text:
		# Past-end chunk. Stay silent (empty stdout) so the env is uncluttered.
		return ""

	# Overflow safety check: when total chunks exceed configured entries, the
	# trailing chunks never run and their data is silently lost. We catch this
	# by having the LAST configured chunk (chunk == max_entries - 1) check
	# whether more data exists than it can deliver, and appending a visible
	# warning. Future L0 growth then produces a loud alert at session start
	# instead of quietly dropping observations.
	#
	# This guard is the systemic protection that lets us configure exactly the
	# number of entries we need today (3) without risking data loss when L0
	# grows past that threshold.
	if len(chunks) > args.max_entries and args.chunk == args.max_entries - 1:
		missing_chunks = len(chunks) - args.max_entries
		# Sum observation count across the chunks that won't run.
		missing_obs = sum(
			len(chunks[i]) for i in range(args.max_entries, len(chunks))
		)
		text += (
			f"\n\n---\n"
			f"⚠️ MEMORY CONFIG WARNING: L0+L1 needs {len(chunks)} chunks but only "
			f"{args.max_entries} SessionStart entries are configured. "
			f"{missing_obs} observations across {missing_chunks} chunk(s) are NOT "
			f"loaded. Add {missing_chunks} more `load-l0-context.py --chunk=N "
			f"--max-entries=M` entries to settings.json (or call "
			f"mcp__memory__get_context_layers for the missing content)."
		)

	return build_envelope(text)


def main():
	"""
	Hook entry point. Wraps _main_inner in typed exception handlers so the
	"always exit 0" invariant survives any failure mode.
	"""
	args = parse_args()
	envelope_text = None
	try:
		envelope_text = _main_inner(args)
	except SchemaDriftError as exc:
		envelope_text = build_error_envelope(
			"SCHEMA DRIFT", f"memory.db schema mismatch: {exc}"
		)
		log_error()
	except sqlite3.Error as exc:
		envelope_text = build_error_envelope(
			"DB ERROR", f"{type(exc).__name__}: {exc}"
		)
		log_error()
	except Exception as exc:
		envelope_text = build_error_envelope(
			"FAILED", f"{type(exc).__name__}: {exc}"
		)
		log_error()
	finally:
		# Past-end chunks return "" — write nothing to stdout (silent skip).
		# Errors and content return a JSON envelope.
		if envelope_text is None:
			envelope_text = build_error_envelope(
				"FAILED", "hook exited without producing an envelope (bug)"
			)
		if envelope_text:
			sys.stdout.write(envelope_text + "\n")
			sys.stdout.flush()
	return 0


if __name__ == "__main__":
	sys.exit(main())
