#!/usr/bin/env python3
"""
SessionStart hook: detect memory observations stale relative to file mtimes.

Runs at session start (or whenever invoked manually). Identifies the project
scope from the cwd, queries the SQLite memory database for entities tied to
files in or under the project, and flags any entity whose most-recent active
observation predates the file it describes.

The drift threshold is 1 hour by default — anything more is treated as a
candidate for re-verification. This is the data-driven part: file mtimes
are an objective signal, no time-based guessing about staleness.

Side effects:
  1. Writes a detailed JSON report to /tmp/claude/memory-stale-flags.json
  2. Prints a hookSpecificOutput JSON envelope to stdout for Claude Code to
     inject the summary as additionalContext at session start

Always exits 0 — this hook is informational, not blocking.

Performance target: under 1 second for typical memory.db sizes (~2000 obs).
The single SQL query plus per-file os.stat() calls keeps it cheap.
"""

# Standard library imports — no external deps so the hook runs from any python3
import json
import os
import re
import sqlite3
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path


# ─── exception types ──────────────────────────────────────────────────────────

class SchemaDriftError(Exception):
	"""
	Raised by verify_schema() when the memory.db schema doesn't have one of
	the columns we depend on. Distinguished from sqlite3.Error so the main()
	wrapper can emit a "SCHEMA DRIFT" envelope rather than a generic
	"DB ERROR" — schema migrations are a different failure class than
	transient lock contention or corruption, and the user should know which
	is happening so they look in the right place.
	"""
	pass

# ─── configuration ────────────────────────────────────────────────────────────

# Path to the SQLite-backed memory database used by the MCP memory server.
# This is hardcoded because the hook runs without environment context.
DB_PATH = Path.home() / ".claude" / "memory.db"

# Where the detailed flag report is written. The PreCompact hook (Tier 2) reads
# this file to decide whether a deep audit is warranted.
FLAGS_PATH = Path("/tmp/claude/memory-stale-flags.json")

# Where tracebacks from main()'s exception wrapper get written. We can't print
# them to stderr or they'd interleave with the JSON envelope on a busy PTY,
# and we can't print to stdout because the envelope is the only thing allowed
# there. The log is append-only and best-effort — if writing fails (e.g.
# tmpfs full), the wrapper still emits a degraded envelope.
ERROR_LOG_PATH = Path("/tmp/claude/memory-freshness-errors.log")

# Drift threshold in hours. A file modified more than this many hours after
# the most recent observation about it is flagged. Set to 1 hour because
# during active development a file can change many times in a single session.
DRIFT_THRESHOLD_HOURS = 1.0

# Cap on how many flags we summarize in the additionalContext output.
# The full list always goes to FLAGS_PATH; this just keeps the inline
# summary readable inside the conversation.
MAX_INLINE_FLAGS = 10

# Root directory under which projects live. Entity names that look like
# relative paths (e.g. "dustin-space/src/foo.js") get joined to this.
PROJECT_ROOT_BASE = Path("/home/dustin/Claude")

# Allow-list of root directories for the Path: extractor in
# extract_path_from_text(). A candidate path pulled from observation prose
# must start with one of these resolved roots, or it gets rejected as a
# phantom (e.g. "Path: /etc/shadow yesterday" or a JSON-quote over-consume).
#
# Why TWO roots and not one:
#   The first version of this allow-list (step 4 of the freshness fixes)
#   used only PROJECT_ROOT_BASE = /home/dustin/Claude/. That had a side
#   effect: any file-backed entity whose Path: lives under /home/dustin/.claude/
#   silently failed the allow-list and was dropped from the scan. The
#   freshness system itself lives under /home/dustin/.claude/ (this hook,
#   /home/dustin/.claude/skills/audit-memory/SKILL.md, the PreCompact prompt
#   in /home/dustin/.claude/settings.json), so step 4 had the unintended
#   effect of hiding drift on the very files that implement the system.
#   Adding /home/dustin/.claude/ as a second allow-list root fixes that
#   without weakening the safety guard against /etc/* phantoms.
#
# Both roots are .resolve()'d once at module load (cheap, avoids per-call
# symlink walks).
#
# IMPORTANT: This allow-list is for the Path: EXTRACTOR only. The
# project-scope filter inside find_stale_entities() (which limits a session
# to drift in the active project) stays SINGLE-root — that filter exists
# to keep session output focused, not to enforce safety.
ALLOW_LIST_ROOTS = (
	PROJECT_ROOT_BASE.resolve(),
	Path("/home/dustin/.claude").resolve(),
)

# Backwards-compat alias: callers that need the active-project resolved
# root (find_stale_entities project-scope filter) read it as the first
# entry of ALLOW_LIST_ROOTS so the allow-list and the scope filter share
# the same normalised path. A symlinked project dir thus passes both or
# neither — never one but not the other.
PROJECT_ROOT_BASE_RESOLVED = ALLOW_LIST_ROOTS[0]

# Sentinel timestamp written by the 2026-04-01 backfill that replaced 790
# 'unknown' observation timestamps. Any entity whose most-recent observation
# still equals this exact value has never had a real timestamp recorded —
# its drift number is meaningless. We quarantine those into a separate
# counter (sentinel_excluded) instead of flagging them, otherwise the report
# is dominated by hundreds of entities that all "drift" by exactly the same
# amount and the real signals get drowned out.
# A future migration that re-times these entities will produce timestamps
# different from this string, at which point they'll start being checked
# normally with no code change required.
BACKFILL_SENTINEL = "2026-04-01T00:00:00.000Z"


# ─── SQL aggregation strategy ────────────────────────────────────────────────
#
# We need to fetch every active observation per entity in a single query so we
# can scan their content for "Path:" markers without N round-trips. The naive
# approach used by step 1-5 was `GROUP_CONCAT(o.content, '|||')` and then
# Python `.split('|||')`. Three independent agents in the Phase 1 review
# (silent-failure M2, code-reviewer C2, performance #1, adversarial #7)
# flagged that as unsafe: observation content can legitimately contain the
# string `|||` (code blocks, ASCII art, markdown tables, regex), so the split
# silently produces wrong fragments and a path lookup either misses or flags
# the wrong file.
#
# Two safer aggregation options exist. We pick at module load based on the
# SQLite version Python's sqlite3 module is linked against:
#
#   1. SQLite >= 3.38.0: `json_group_array(o.content)` returns a JSON array
#      string, parsed by `json.loads`. JSON-quoted strings can contain ANY
#      byte safely — no delimiter collision is possible.
#
#   2. SQLite < 3.38.0: `GROUP_CONCAT(o.content, char(30))` uses ASCII 0x1E
#      (Record Separator), a control character that effectively never
#      appears in human-readable observation content. Not as bulletproof as
#      JSON but vastly safer than `|||`.
#
# Both queries also use the defensive `(o.superseded_at IS NULL OR = '')`
# filter (silent-failure H3): the current MCP schema stores '' as the active
# sentinel, but a future migration could switch to NULL and a strict `= ''`
# filter would silently return zero rows. Accepting both shapes survives
# that migration with no code change.
#
# IMPORTANT: the SQL string is built with f-strings to interpolate the
# aggregation expression. This is safe ONLY because the interpolated value
# is one of two module-level string constants WE control — never user input,
# never anything from the database. Do NOT add any external value to the
# f-string interpolation here.

# True if Python's sqlite3 module was linked against SQLite >= 3.38.0,
# which is when json_group_array was added.
_SQLITE_HAS_JSON_GROUP_ARRAY = sqlite3.sqlite_version_info >= (3, 38, 0)

# The SQL fragment that aggregates observation contents for one entity.
# Picked once at module load so we don't re-check the version on every call.
if _SQLITE_HAS_JSON_GROUP_ARRAY:
	OBS_AGG_SQL = "json_group_array(o.content)"
else:
	# char(30) is ASCII 0x1E (Record Separator). Never appears in normal
	# observation prose, so the split below can rely on it.
	OBS_AGG_SQL = "GROUP_CONCAT(o.content, char(30))"

# Defensive filter for the active-observation predicate. Accepts both the
# current sentinel ('' for active) and a hypothetical future schema that
# uses NULL — silent-failure H3.
ACTIVE_OBS_FILTER = "(o.superseded_at IS NULL OR o.superseded_at = '')"


def parse_obs_contents(raw):
	"""
	Splits the aggregated observation contents from one row of the SQL
	above into a list of individual observation strings.

	Picks the parser to match whichever aggregation expression we used at
	module load:
	  - json_group_array → json.loads (returns a Python list)
	  - GROUP_CONCAT(char(30)) → str.split('\x1e')

	Receives: the raw value from cursor.fetchall() row[2], which is either
	a JSON-array string (modern SQLite) or a delimited blob string (older).
	None is possible if the entity has zero active observations, though the
	JOIN in the query should make that case unreachable in practice.

	Returns: list of observation content strings. Empty list on None input
	or unparseable JSON, never raises.
	"""
	if raw is None:
		return []
	if _SQLITE_HAS_JSON_GROUP_ARRAY:
		try:
			# json.loads on a string returns whatever was encoded. For our
			# query that's always a list of strings.
			return json.loads(raw)
		except (json.JSONDecodeError, ValueError):
			# Defensive: if the DB ever returns malformed JSON, don't crash
			# the hook over it — silently treat as no observations. This
			# is the only error class we swallow, and it's bounded to
			# "we couldn't extract Path: markers from this entity," which
			# at worst causes us to miss a candidate (false negative).
			return []
	# Pre-3.38 fallback: split on the Record Separator we asked GROUP_CONCAT
	# to use. Plain str.split — never raises.
	return raw.split("\x1e")


# ─── input handling ───────────────────────────────────────────────────────────

def read_hook_input():
	"""
	Reads the SessionStart hook payload from stdin.

	Claude Code passes a JSON object on stdin describing the session context.
	The fields we care about are `cwd` (the working directory at session start)
	and `session_id` (just for logging). If stdin is empty or invalid we fall
	back to os.getcwd() so the script still works when invoked manually.

	Returns: dict with at least `cwd` key.
	"""
	try:
		# json.load reads from a file-like object. sys.stdin is the hook payload.
		payload = json.load(sys.stdin)
		# Defensive: payload may not have cwd if hook is run outside Claude Code
		if not isinstance(payload, dict):
			payload = {}
	except (json.JSONDecodeError, ValueError):
		# Empty stdin or non-JSON input — manual run, use current directory
		payload = {}

	# Default to actual cwd if hook payload didn't provide one
	payload.setdefault("cwd", os.getcwd())
	return payload


# ─── project derivation ───────────────────────────────────────────────────────

def derive_project_name(cwd):
	"""
	Maps a working directory to a project name.

	Walks up from cwd until it hits PROJECT_ROOT_BASE (/home/dustin/Claude),
	then takes the immediate child directory as the project name. For example:
	  /home/dustin/Claude/dustin-space/src/foo  →  "dustin-space"
	  /home/dustin/Claude/Voice Prompt          →  "Voice Prompt"
	  /home/dustin                              →  None (no project scope)

	Returns: project name string, or None if cwd is outside PROJECT_ROOT_BASE.
	"""
	try:
		# Path.resolve() normalizes symlinks and ".."
		# Path.relative_to() raises ValueError if not under the base
		rel = Path(cwd).resolve().relative_to(PROJECT_ROOT_BASE)
		# rel.parts is a tuple like ("dustin-space", "src", "foo")
		# The first element is the project directory name
		if rel.parts:
			return rel.parts[0]
	except (ValueError, OSError):
		pass
	return None


# ─── path extraction from observation content ────────────────────────────────

# Regex to find "Path: /some/file" in observation text. The convention used
# by SessionEnd memory writes is to include a "Path: <absolute-path>" line
# in file-backed entity observations. This regex pulls it out.
#   - `Path:\s*` matches the literal "Path:" with optional whitespace
#   - `(/\S+)` captures the absolute path (no spaces allowed in the path)
#   - We strip trailing punctuation in code below
PATH_PATTERN = re.compile(r"Path:\s*(/\S+)")


def extract_path_from_text(text):
	"""
	Looks for a "Path: /..." line in observation content.

	Why: many entities have a friendly name like "dustin-space-image-njk"
	but the actual file path lives in one of their observations. This lets
	us match those entities to their files.

	Two safety guards (added 2026-04-11 from review findings):

	1. Trailing-character strip: only ONE trailing character at most, and
	   only if it's in the set `"'`]>.,;)`. The previous version used
	   `rstrip(".,;)")` which strips any *combination* of those characters,
	   so a path like "/home/foo).." became "/home/foo" — clobbering the
	   real `)` in the filename. Single-char strip undoes the common
	   sentence-ending case ("Path: /foo/bar.md.") without that risk.

	2. Allow-list: the path must start with ONE of the resolved roots in
	   ALLOW_LIST_ROOTS (currently /home/dustin/Claude and /home/dustin/.claude).
	   This blocks two failure modes flagged by the adversarial review:
	     a) Phantom system paths from observation prose like
	        "Path: /etc/shadow yesterday" — these used to be stat()'d and
	        compared against unrelated entities, producing nonsense flags.
	     b) JSON-quoted paths where the regex over-consumes the closing
	        quote: '"Path": "/x/y.js",' → captures '/x/y.js",' → strip
	        removes the comma → '/x/y.js"' → fails the allow-list cleanly.
	   Two roots are needed because Claude config (this hook, skills,
	   settings.json) lives under /home/dustin/.claude/, not the project
	   root — see the ALLOW_LIST_ROOTS comment block for the full rationale.

	Returns: absolute path string under one of ALLOW_LIST_ROOTS, or None.
	"""
	match = PATH_PATTERN.search(text or "")
	if not match:
		return None
	candidate = match.group(1)
	# Single-character trailing strip. Done as an explicit if-check on the
	# last char (NOT rstrip) so we never strip more than one character.
	if candidate and candidate[-1] in "\"'`]>.,;)":
		candidate = candidate[:-1]
	# Allow-list: reject anything outside the allowed roots. This is the
	# critical guard against phantom /etc/* paths and JSON over-consume.
	# any() short-circuits, so the typical case (project root, first entry)
	# returns after one comparison.
	if not any(candidate.startswith(str(root) + "/") for root in ALLOW_LIST_ROOTS):
		return None
	return candidate


# ─── timestamp parsing ────────────────────────────────────────────────────────

def parse_iso_timestamp(ts):
	"""
	Parses an ISO 8601 timestamp from the memory database.

	The MCP memory server stores timestamps as ISO strings ending in 'Z'
	(e.g. "2026-04-10T23:42:35.996Z"). Python's fromisoformat() doesn't
	accept 'Z' until 3.11+, so we replace it with '+00:00' for safety.
	The backfill sentinel "2026-04-01T00:00:00.000Z" parses the same way.

	Returns: tz-aware datetime, or None if parsing fails.
	"""
	if not ts:
		return None
	try:
		return datetime.fromisoformat(ts.replace("Z", "+00:00"))
	except (ValueError, AttributeError):
		return None


# ─── schema verification ─────────────────────────────────────────────────────

def verify_schema(conn):
	"""
	Verifies memory.db has the columns find_stale_entities() depends on.

	Uses `PRAGMA table_info(<table>)`, which returns one row per column with
	the column name in position 1 of the tuple. We compare the actual column
	set against the columns the rest of this script names directly.

	Why this exists: a future MCP server schema migration could rename or
	drop one of these columns, and the resulting `sqlite3.OperationalError:
	no such column` would surface as a generic "DB ERROR" envelope. Catching
	the mismatch up front lets us emit a clearer "SCHEMA DRIFT" envelope
	naming the missing column, so the user knows to look at the MCP server
	migration history rather than at lock contention or corruption.

	Why PRAGMA-based and not `PRAGMA user_version`-based: contract checking
	is what we actually want. user_version requires hardcoding an
	accept-list of compatible numbers and updating it on every release; the
	column-name approach directly checks what we depend on with no
	maintenance overhead.

	Note on the f-string: SQLite does not allow `?` placeholders for table
	names (they're DDL identifiers, not values). Hardcoding the table names
	in the `expected` dict makes f-string interpolation safe — there's no
	user input here.

	Raises: SchemaDriftError naming the missing column or table.
	"""
	expected = {
		"entities": {"id", "name"},
		"observations": {"entity_id", "content", "created_at", "superseded_at"},
	}
	cur = conn.cursor()
	for table, needed in expected.items():
		cur.execute(f"PRAGMA table_info({table})")
		# PRAGMA table_info row shape: (cid, name, type, notnull, dflt, pk)
		# We only care about row[1] (the column name).
		actual = {row[1] for row in cur.fetchall()}
		if not actual:
			# Empty result means the table itself doesn't exist
			raise SchemaDriftError(f"table not found: {table}")
		missing = needed - actual
		if missing:
			raise SchemaDriftError(
				f"missing column(s) in {table}: {', '.join(sorted(missing))}"
			)


# ─── core check logic ────────────────────────────────────────────────────────

def find_stale_entities(conn, project_name):
	"""
	Queries memory.db and returns a list of entities whose file mtime is
	more than DRIFT_THRESHOLD_HOURS newer than their most recent observation.

	Algorithm:
	  1. SELECT every entity with at least one active observation, aggregating
	     its active observations into a single column (json_group_array on
	     SQLite >= 3.38, char(30)-delimited GROUP_CONCAT otherwise) so we
	     can scan them for "Path:" markers in a single query. parse_obs_contents
	     turns that column back into a Python list at the call site.
	  2. For each entity, build a list of candidate file paths:
	     a. The entity name itself (if it starts with /)
	     b. PROJECT_ROOT_BASE / entity_name (if name has slashes but not absolute)
	     c. Any "Path: /..." extracted from observation contents
	  3. For each candidate, if the file exists, compare its mtime to
	     MAX(observation.created_at) for that entity.
	  4. Drift > threshold → flag it.

	If project_name is given, restrict to files under PROJECT_ROOT_BASE/project_name.
	If project_name is None, check all entities (global scope).

	Returns: tuple of (flags, stats):
	  - flags: list of flag dicts, sorted by drift descending.
	  - stats: dict of counters surfaced in the envelope. Currently:
	    - sentinel_excluded: entities skipped because their timestamp is
	      the 2026-04-01 backfill sentinel (step 2).
	    - scanned: candidate files we successfully stat()'d AND were in
	      project scope. The user-facing heartbeat — silent-failure C4
	      was "no way to tell crashed from clean." If this stays at 0
	      across runs, something's wrong (broken DB, no entities, etc.).
	    - errors: I/O failures (OSError) hit during is_file/resolve/stat.
	      Surfaced because the previous version's blanket
	      `except (OSError, ValueError)` made these vanish silently.
	    - first_error: human-readable detail of the FIRST OSError so the
	      user has a starting point without opening the JSON.
	    - unparseable_timestamps: entities whose `max(created_at)` couldn't
	      be parsed by parse_iso_timestamp. Step 7. Was a silent skip
	      before — silent-failure C3 / code-reviewer M1 / adversarial #3.
	      A schema migration that switches created_at to NULL or epoch
	      integers would empty the flag list and the old code would
	      cheerfully report zero drift.
	    - first_unparseable: name + raw timestamp value of the FIRST entity
	      whose timestamp failed to parse, for triage.
	"""
	# Step 6: aggregate active observations using whichever SQL fragment was
	# chosen at module load (`json_group_array` on SQLite >= 3.38, char(30)
	# GROUP_CONCAT otherwise) — see the OBS_AGG_SQL comment block for why.
	# The defensive ACTIVE_OBS_FILTER survives a future schema migration
	# from '' to NULL on superseded_at (silent-failure H3).
	#
	# f-string interpolation is safe here ONLY because OBS_AGG_SQL and
	# ACTIVE_OBS_FILTER are module constants we control. NEVER add user
	# input or DB values to this f-string.
	cur = conn.cursor()
	cur.execute(f"""
		SELECT
			e.name,
			MAX(o.created_at) AS max_created,
			{OBS_AGG_SQL}
		FROM entities e
		JOIN observations o ON o.entity_id = e.id
		WHERE {ACTIVE_OBS_FILTER}
		GROUP BY e.id
	""")

	# Step 5b: project scope root. PROJECT_ROOT_BASE_RESOLVED is already
	# symlink-walked at module load (it's an alias for ALLOW_LIST_ROOTS[0]),
	# so joining the project name to it is a pure string concat — NO second
	# .resolve() here. The previous version called .resolve() AGAIN on the
	# join, which had two costs: it stat()'d the project directory on every
	# call (cheap but unnecessary), and it produced an asymmetry with the
	# allow-list constant whenever a project directory itself was a symlink.
	project_root = PROJECT_ROOT_BASE_RESOLVED / project_name if project_name else None

	# Cache the cutoff time once for performance
	now_utc = datetime.now(timezone.utc)
	flags = []
	# stats: counters surfaced in the report envelope.
	#
	# - sentinel_excluded (step 2): backfill-sentinel quarantine count
	# - scanned (step 5f): files actually stat()'d in scope — heartbeat
	# - errors (step 5d): I/O failures, was previously silently swallowed
	# - first_error (step 5d): human-readable first OSError, for triage
	# - unparseable_timestamps (step 7): entities whose max(created_at)
	#   couldn't be parsed; previously a silent skip (silent-failure C3)
	# - first_unparseable (step 7): name + raw value of the first one
	stats = {
		"sentinel_excluded": 0,
		"scanned": 0,
		"errors": 0,
		"first_error": None,
		"unparseable_timestamps": 0,
		"first_unparseable": None,
	}

	for entity_name, max_created, contents_concat in cur.fetchall():
		# Quarantine the backfill sentinel BEFORE parsing — string compare is
		# cheaper than ISO parsing, and we want zero candidate work for these
		# entities. Without this, ~790 backfilled entities flood the report
		# every session start because their files have all been touched since
		# the 2026-04-01 backfill date.
		if max_created == BACKFILL_SENTINEL:
			stats["sentinel_excluded"] += 1
			continue

		obs_dt = parse_iso_timestamp(max_created)
		if obs_dt is None:
			# Step 7: track unparseable so they're visible. Can't compare
			# against mtime without a parseable timestamp, but we want
			# the user to know how many we hit and the FIRST offending
			# entity for triage. The previous code's silent `continue`
			# meant a schema migration that broke timestamp parsing
			# would empty the flag list and the hook would cheerfully
			# report "all clean" (silent-failure C3, code-reviewer M1,
			# adversarial #3).
			stats["unparseable_timestamps"] += 1
			if stats["first_unparseable"] is None:
				stats["first_unparseable"] = (
					f"{entity_name} (raw={max_created!r})"
				)
			continue

		# Build candidate file paths to check
		candidates = []
		# Candidate 1: entity name is itself an absolute path
		if entity_name.startswith("/"):
			candidates.append(entity_name)
		# Candidate 2: entity name is a relative path under PROJECT_ROOT_BASE
		# (e.g. "dustin-space/src/assets/js/detail.js")
		elif "/" in entity_name:
			candidates.append(str(PROJECT_ROOT_BASE / entity_name))
		# Candidate 3: any "Path: /..." line from observation content.
		# Step 6: parse_obs_contents picks json.loads or split('\x1e') based
		# on the SQLite version we probed at module load — no more `|||`
		# delimiter collision risk on observations that legitimately contain
		# code blocks, ASCII art, markdown tables, or regex.
		for obs_text in parse_obs_contents(contents_concat):
			extracted = extract_path_from_text(obs_text)
			if extracted:
				candidates.append(extracted)

		# Step 5e: iterate ALL candidates (no early break) and dedupe by
		# resolved file path so we don't double-flag the same file when an
		# entity has both a name-derived candidate AND a "Path:" line that
		# point to the same file. The previous version had an unconditional
		# `break` on the first existing candidate, which silently hid drift
		# on secondary paths of multi-Path: entities (code-reviewer C1).
		seen_resolved = set()
		for cand in candidates:
			file_path = Path(cand)

			# Step 5c: narrow exception scope. is_file() / resolve() / stat()
			# all do real I/O and can raise OSError (broken symlink, EACCES,
			# stale NFS handle, ELOOP). We catch ONLY OSError here so the
			# project-scope check below can use a normal if-statement instead
			# of a try/except. The previous `except (OSError, ValueError)`
			# conflated I/O failures with "file is in a different project,"
			# silently dropping symlinked project files (perf-analyst #2,
			# silent-failure C2).
			try:
				if not file_path.is_file():
					continue
				resolved_path = file_path.resolve()
				file_stat = file_path.stat()
			except OSError as e:
				# Step 5d: track the failure so it shows up in the envelope
				# instead of vanishing. Capture the FIRST one as a string
				# for the triage line — count alone tells us "something's
				# wrong," the message tells us where to look.
				stats["errors"] += 1
				if stats["first_error"] is None:
					stats["first_error"] = (
						f"{cand}: {type(e).__name__}: {e}"
					)
				continue

			# Project scope filter (single-root by design — see the
			# ALLOW_LIST_ROOTS comment block for why this stays single-root
			# even though the path extractor went multi-root). Uses
			# os.path.commonpath instead of Path.relative_to so a wrong-
			# scope outcome is a normal `if` branch, not a caught exception.
			# commonpath itself can raise ValueError when the two paths
			# share no prefix at all (e.g. mixed absolute/relative on
			# Windows) — that case is also "out of scope," handled in the
			# narrow `except` below.
			if project_root is not None:
				try:
					common = os.path.commonpath(
						[str(resolved_path), str(project_root)]
					)
				except ValueError:
					continue
				if common != str(project_root):
					continue

			# Step 5e: dedupe by resolved path within this entity. Without
			# this, an entity that names the same file twice (e.g. via both
			# its entity name AND a Path: observation) flags it twice.
			resolved_str = str(resolved_path)
			if resolved_str in seen_resolved:
				continue
			seen_resolved.add(resolved_str)

			# Step 5f: scanned counter. Increment AFTER the dedup check so
			# the same physical file isn't double-counted within an entity.
			# This is the heartbeat — if it stays at 0 across runs, the
			# allow-list / project filter / candidate builder is broken.
			stats["scanned"] += 1

			# stat() returns posix mtime as a float (seconds since epoch).
			# We pulled the stat above (under the OSError guard) so we don't
			# repeat the syscall here.
			file_mtime = datetime.fromtimestamp(
				file_stat.st_mtime, tz=timezone.utc
			)
			drift_seconds = (file_mtime - obs_dt).total_seconds()
			drift_hours = drift_seconds / 3600.0

			if drift_hours > DRIFT_THRESHOLD_HOURS:
				flags.append({
					"entity": entity_name,
					"file": str(file_path),
					"obs_max_created": max_created,
					"file_mtime": file_mtime.isoformat(),
					"drift_hours": round(drift_hours, 1),
				})
			# Step 5e: NO `break` here. Keep going through every candidate
			# so secondary paths of multi-Path: entities don't get hidden.

	# Sort highest-drift first so the top of the list is the most urgent
	flags.sort(key=lambda f: f["drift_hours"], reverse=True)
	return flags, stats


# ─── output formatting ───────────────────────────────────────────────────────

def build_summary(flags, stats, project_name):
	"""
	Builds the human-readable summary that gets injected into the session.

	Keep this concise — it ends up in the system prompt and consumes context
	tokens on every session start. The full list lives in FLAGS_PATH for
	on-demand consumption (e.g. by the PreCompact deep-audit logic).

	The `stats` dict surfaces heartbeat counters (scanned, errors,
	sentinel_excluded) on EVERY run — silent-failure C4 was "no way to tell
	a clean run from a crashed-and-empty run." If scanned drops to 0
	unexpectedly, that's a signal that the candidate builder, allow-list,
	or project filter has broken.
	"""
	# Step 5f / step 7: Build the heartbeat line. We show this on BOTH the
	# all-clean branch and the has-flags branch so the counters are always
	# visible. Order: scanned first (the heartbeat itself), then the
	# informational counters, then the alarm counters.
	stats_parts = []
	if stats.get("scanned") is not None:
		stats_parts.append(f"scanned={stats['scanned']}")
	if stats.get("sentinel_excluded"):
		stats_parts.append(f"sentinel_excluded={stats['sentinel_excluded']}")
	if stats.get("unparseable_timestamps"):
		stats_parts.append(f"unparseable_timestamps={stats['unparseable_timestamps']}")
	if stats.get("errors"):
		stats_parts.append(f"errors={stats['errors']}")
	stats_line = (
		f"  Stats: {', '.join(stats_parts)}"
		if stats_parts else None
	)
	# Surface the FIRST OSError detail inline so the user has a starting
	# point without having to open the JSON report. Step 5d.
	first_error_line = (
		f"  First error: {stats['first_error']}"
		if stats.get("first_error") else None
	)
	# Step 7: same idea for the first unparseable timestamp. We surface
	# it as a separate line because the value can be long (entity name +
	# raw timestamp string).
	first_unparseable_line = (
		f"  First unparseable timestamp: {stats['first_unparseable']}"
		if stats.get("first_unparseable") else None
	)

	def _append_stats(line_list):
		"""Local helper: append stats + first_error + first_unparseable."""
		if stats_line:
			line_list.append(stats_line)
		if first_unparseable_line:
			line_list.append(first_unparseable_line)
		if first_error_line:
			line_list.append(first_error_line)

	if not flags:
		base_lines = [
			"MEMORY FRESHNESS CHECK: All file-backed observations are "
			"up-to-date relative to file mtimes."
		]
		_append_stats(base_lines)
		return "\n".join(base_lines)

	lines = [
		f"MEMORY FRESHNESS CHECK ({len(flags)} stale candidates):",
		f"  Project scope: {project_name or 'global'}",
		f"  Drift threshold: {DRIFT_THRESHOLD_HOURS}h (file modified after most recent observation)",
	]
	_append_stats(lines)
	lines.append("  Top flagged entities (verify before recalling as fact):")
	# Show only the top N inline; the rest are in the JSON file
	for f in flags[:MAX_INLINE_FLAGS]:
		lines.append(
			f"    - {f['entity']}  (drift {f['drift_hours']}h)"
		)
	if len(flags) > MAX_INLINE_FLAGS:
		remaining = len(flags) - MAX_INLINE_FLAGS
		lines.append(f"    ... and {remaining} more")
	lines.append(f"  Full report: {FLAGS_PATH}")
	return "\n".join(lines)


def write_flags_file(flags, stats, payload, project_name):
	"""
	Writes the detailed flag report to /tmp/claude/memory-stale-flags.json.

	Includes the cwd, project, threshold, full flag list, and the stats
	counters from find_stale_entities(). The PreCompact hook reads this to
	decide whether to trigger a deep audit.

	The first field is `schema_version`, an integer that increments whenever
	the envelope shape changes. Tier 2 (PreCompact) and Tier 3 (audit-memory
	skill) readers should check this field first and bail out (or warn) on
	an unfamiliar version, rather than silently misreading new fields.
	Current version: 1.
	"""
	# Ensure the parent directory exists — /tmp/claude is convention
	FLAGS_PATH.parent.mkdir(parents=True, exist_ok=True)
	# schema_version is intentionally the FIRST key so a reader can detect
	# the version even from a partial read of the file.
	report = {
		"schema_version": 1,
		"generated_at": datetime.now(timezone.utc).isoformat(),
		"cwd": payload.get("cwd"),
		"project": project_name,
		"drift_threshold_hours": DRIFT_THRESHOLD_HOURS,
		"flag_count": len(flags),
		# Stats from find_stale_entities — sentinel_excluded today, more
		# counters added by later steps in the deployment plan.
		"stats": stats,
		"flags": flags,
	}
	# json.dumps with indent=2 keeps the file readable for manual inspection
	FLAGS_PATH.write_text(json.dumps(report, indent=2))


# ─── envelope helpers ────────────────────────────────────────────────────────

def _build_envelope(summary_text):
	"""
	Builds a Claude Code SessionStart hook envelope as a JSON string.

	Centralized so the success path and the error paths produce identically-
	shaped envelopes. The shape is the Claude Code hook contract:
	`{"hookSpecificOutput": {"hookEventName": "SessionStart",
	"additionalContext": "..."}}`.

	Returns: JSON string ready to be written to stdout.
	"""
	return json.dumps({
		"hookSpecificOutput": {
			"hookEventName": "SessionStart",
			"additionalContext": summary_text,
		}
	})


def _build_error_envelope(label, detail):
	"""
	Builds a degraded envelope when the hook fails.

	The label classifies the failure (SCHEMA DRIFT, DB ERROR, FAILED) so the
	user can tell at a glance whether to look at MCP migrations, lock
	contention, or some other Python error. The detail gives enough info
	to start debugging without having to open the error log.
	"""
	return _build_envelope(f"MEMORY FRESHNESS CHECK [{label}]: {detail}")


def _log_error(exc):
	"""
	Best-effort traceback dump to ERROR_LOG_PATH.

	Never raises — if logging fails (tmpfs full, permission denied, etc.)
	we've already lost a normal envelope; the wrapper still gets to emit a
	degraded envelope as long as logging doesn't crash too. The `with
	suppress(Exception)` style would also work; an explicit try/except is
	used here for clarity about what's being swallowed and why.
	"""
	try:
		ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
		# Append mode so concurrent runs don't clobber each other's logs.
		with ERROR_LOG_PATH.open("a") as fh:
			fh.write(f"\n--- {datetime.now(timezone.utc).isoformat()} ---\n")
			# print_exc writes the traceback for the most recent exception,
			# which is `exc` because we're inside the wrapper's except block.
			traceback.print_exc(file=fh)
	except Exception:
		# Intentional: logging is best-effort. The envelope is the contract,
		# the log is a debugging convenience. Don't sacrifice the contract
		# to preserve the convenience.
		pass


# ─── entry point ─────────────────────────────────────────────────────────────

def _main_inner():
	"""
	The actual freshness check logic. Returns (envelope_text, exit_code).

	Allowed to raise: SchemaDriftError, sqlite3.Error, or any other Exception.
	The main() wrapper translates each into a degraded envelope. Do NOT add
	a broad try/except inside this function — that would defeat the typed
	catch hierarchy in main() and produce uninformative envelopes.
	"""
	payload = read_hook_input()
	cwd = payload["cwd"]
	project_name = derive_project_name(cwd)

	# If the database doesn't exist yet (e.g. fresh install), emit a clear
	# "skipping" envelope and return success. This is not an error — it's
	# the expected state on a brand-new machine before the MCP server has
	# created its DB.
	if not DB_PATH.exists():
		return _build_envelope(
			"MEMORY FRESHNESS CHECK: memory.db not found, skipping."
		), 0

	# Open read-only — this hook should never write to the DB itself
	# (DB writes go through the MCP memory server)
	conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
	try:
		# Verify schema BEFORE running the main query so a missing column
		# raises a clean SchemaDriftError instead of an opaque
		# OperationalError("no such column") deep inside find_stale_entities.
		verify_schema(conn)
		flags, stats = find_stale_entities(conn, project_name)
	finally:
		conn.close()

	# Always write the report file, even if empty — Tier 2 reads it
	write_flags_file(flags, stats, payload, project_name)

	# Build and return the inline summary envelope
	summary = build_summary(flags, stats, project_name)
	return _build_envelope(summary), 0


def main():
	"""
	Hook entry point. Wraps _main_inner() in a top-level exception handler
	so the "always exit 0 with valid JSON envelope" invariant survives any
	failure mode.

	Catch order:
	  1. SchemaDriftError - schema mismatch detected by verify_schema()
	  2. sqlite3.Error    - DB locked, corrupted, or other DB error
	  3. Exception        - everything else (write failures, parse errors, etc.)

	The envelope text is buffered into a local variable and printed inside
	a finally block as a single atomic write. This prevents two failure
	modes:
	  a) An exception thrown after a partial print() would corrupt the
	     envelope on stdout. Buffering means the print only happens once,
	     and only after the full text is known.
	  b) On a busy PTY, stderr (Python tracebacks) and stdout could
	     interleave mid-line. We never write to stderr from this script
	     (tracebacks go to ERROR_LOG_PATH instead), and the single
	     stdout.write+flush is a single syscall.

	Always returns 0. If something goes wrong inside this wrapper itself
	(very unlikely — finally has its own degraded fallback), Python will
	emit a non-zero exit and the user will see a normal traceback at session
	start. That's the only "loud" failure mode left.
	"""
	envelope_text = None
	exit_code = 0
	try:
		envelope_text, exit_code = _main_inner()
	except SchemaDriftError as exc:
		envelope_text = _build_error_envelope(
			"SCHEMA DRIFT", f"memory.db schema mismatch: {exc}"
		)
		_log_error(exc)
	except sqlite3.Error as exc:
		envelope_text = _build_error_envelope(
			"DB ERROR", f"{type(exc).__name__}: {exc}"
		)
		_log_error(exc)
	except Exception as exc:
		envelope_text = _build_error_envelope(
			"FAILED", f"{type(exc).__name__}: {exc}"
		)
		_log_error(exc)
	finally:
		# Defensive: if envelope_text is somehow still None (a bug in the
		# branches above), build a generic one rather than emit nothing.
		# Emitting nothing would violate the "always valid envelope" invariant.
		if envelope_text is None:
			envelope_text = _build_error_envelope(
				"FAILED", "hook exited without producing an envelope (bug)"
			)
		# Single atomic write — no interleaving with anything else.
		sys.stdout.write(envelope_text + "\n")
		sys.stdout.flush()
	return exit_code


if __name__ == "__main__":
	sys.exit(main())
