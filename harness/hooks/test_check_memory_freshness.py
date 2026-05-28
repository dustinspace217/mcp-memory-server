#!/usr/bin/env python3
"""
Smoke tests for check-memory-freshness.py (Tier 1 of memory freshness system).

Run:
    python3 /home/dustin/.claude/hooks/test_check_memory_freshness.py

Or via unittest discovery:
    python3 -m unittest /home/dustin/.claude/hooks/test_check_memory_freshness.py

These tests use a temp SQLite database (so the live memory.db is never
touched) and monkey-patch ALLOW_LIST_ROOTS / PROJECT_ROOT_BASE_RESOLVED on
the imported hook module so file-existence checks land in a temp directory.

Coverage matrix (Step 10 of the 2026-04-11 hardening pass) — each test
pins behavior introduced or verified by a specific deployment step:

  Step 1 (schema_version envelope)        → TestEnvelopeContract
  Step 2 (sentinel quarantine)            → TestSentinelQuarantine
  Step 3 (atomic envelope, schema probe)  → TestErrorPaths, TestSchemaDrift
  Step 4 (Path: regex tightening)         → TestExtractPath
  Step 4b (multi-root allow-list)         → TestExtractPath
  Step 5 (bundled, project scope, dedup)  → TestProjectScope, TestFindStaleEntities
  Step 6 (json_group_array / char(30))    → TestParseObsContents
  Step 7 (unparseable_timestamps)         → TestUnparseableTimestamps

Steps 8 (envelope verification) and 9 (watermark relocation) live in the
PreCompact prompt and audit-memory SKILL.md respectively, NOT in the
Python hook, so they have no automated test here. Their verification is
covered by the re-read-as-document rule from feedback_prompt_self_review.md.

These are SMOKE tests, not exhaustive unit tests. The aim is regression
safety on the documented contract. Edge cases beyond the contract live in
the inline comments of check-memory-freshness.py itself.
"""

# Standard library imports — no third-party dependencies, so this can run
# on a fresh Fedora install with just `python3` available. Each import is
# explained where its usage isn't immediately obvious.
import importlib.util  # for loading the hyphenated hook filename as a module
import json            # for parsing the envelope JSON the hook emits
import os              # for HOME env override and os.utime
import shutil          # for cleaning up temp dirs in tearDown
import sqlite3         # for building the in-process test DB
import subprocess      # for end-to-end tests that invoke the actual script
import sys             # for sys.exit on direct invocation
import tempfile        # for isolated per-test temp dirs
import unittest        # stdlib test framework — no pytest install needed
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Path to the hook script under test. Hardcoded because this test is
# colocated with the script and intended to be run from anywhere.
HOOK_PATH = Path("/home/dustin/.claude/hooks/check-memory-freshness.py")


def import_hook():
	"""
	Imports check-memory-freshness.py as a Python module despite the hyphen.

	Hyphens are not valid in Python module identifiers, so a normal `import`
	statement won't work on this filename. We use importlib.util.spec_from_
	file_location to load the file directly under a sanitized module name.

	Why a fresh import per call: tests monkey-patch module-level globals
	(ALLOW_LIST_ROOTS, PROJECT_ROOT_BASE_RESOLVED, OBS_AGG_SQL). Returning a
	fresh module copy on each call would prevent test-to-test leakage, but
	module re-execution costs ~50ms because of the SQLite version probe. We
	compromise by importing ONCE at module load and having tests that mutate
	globals restore them in tearDown.

	Returns: the loaded `check_memory_freshness` module object.
	"""
	spec = importlib.util.spec_from_file_location(
		"check_memory_freshness", HOOK_PATH
	)
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


# Single shared module instance used by every in-process test. Tests that
# mutate globals on this instance MUST restore them in tearDown.
hook = import_hook()


def build_test_db(db_path):
	"""
	Builds a fresh SQLite database matching the live memory.db schema.

	The schema mirrors what verify_schema() in the hook expects:
	  - entities table needs at least: id, name (verified by PRAGMA), plus
	    entity_type because the live DB has it as NOT NULL
	  - observations table needs at least: entity_id, content, created_at,
	    superseded_at (all four verified by PRAGMA)

	Other columns the live DB has (importance, context_layer, memory_type,
	updated_at, etc.) are intentionally omitted — the hook doesn't read
	them, so the test schema can be minimal. If verify_schema is ever
	extended to require more columns, this builder must be updated to match.

	Args:
	  db_path: filesystem path where the SQLite database will be created.

	Returns: an open sqlite3.Connection ready for INSERT statements.
	"""
	# sqlite3.connect creates the file if it doesn't exist
	conn = sqlite3.connect(db_path)
	cur = conn.cursor()
	# entities table: minimal columns to satisfy verify_schema + the live
	# DB's NOT NULL constraint on entity_type
	cur.execute("""
		CREATE TABLE entities (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			entity_type TEXT NOT NULL DEFAULT 'test'
		)
	""")
	# observations table: minimal columns + the empty-string default for
	# superseded_at that matches the live DB convention
	cur.execute("""
		CREATE TABLE observations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entity_id INTEGER NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			superseded_at TEXT NOT NULL DEFAULT ''
		)
	""")
	conn.commit()
	return conn


def insert_entity(conn, name, observations):
	"""
	Inserts an entity and its observations into the test database.

	Args:
	  conn: sqlite3.Connection from build_test_db
	  name: entity name (often an absolute file path for these tests, since
	        find_stale_entities treats abs-path names as candidate 1)
	  observations: list of (content, created_at_iso) tuples — content is
	                the observation text, created_at_iso is an ISO-8601
	                UTC timestamp string

	Returns: the new entity's id (lastrowid).
	"""
	cur = conn.cursor()
	cur.execute(
		"INSERT INTO entities (name, entity_type) VALUES (?, 'test')",
		(name,)
	)
	# lastrowid is the integer primary key of the row we just inserted
	entity_id = cur.lastrowid
	for content, created_at in observations:
		cur.execute(
			"INSERT INTO observations (entity_id, content, created_at) "
			"VALUES (?, ?, ?)",
			(entity_id, content, created_at)
		)
	conn.commit()
	return entity_id


def iso_hours_ago(hours):
	"""
	Returns an ISO-8601 UTC timestamp `hours` hours in the past.

	Used for synthesizing observation timestamps relative to "now" so the
	tests don't depend on absolute dates. `hours` can be a float for
	sub-hour offsets (e.g. 0.5 for 30 minutes ago).
	"""
	delta = timedelta(hours=hours)
	return (datetime.now(timezone.utc) - delta).isoformat()


def open_test_db_readonly(db_path):
	"""
	Opens the test database in read-only mode (matching how the hook
	opens the live DB).

	Why read-only: the hook itself uses uri=True with mode=ro, so testing
	against a writable connection would mask any "tried to write to a
	read-only DB" bugs. The test DB is built and populated via a separate
	writable connection that's closed before this is called.
	"""
	return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


# ─── tests ─────────────────────────────────────────────────────────────────


class TestEnvelopeContract(unittest.TestCase):
	"""
	End-to-end subprocess tests on the hook script.

	These run the actual script with subprocess.run and assert the output
	envelope matches the documented Claude Code SessionStart hook contract.
	They use the live memory.db (read-only) so they're sensitive to the
	live state — but they only assert structural facts (key presence,
	exit code, schema_version=1), not flag content, so they're stable
	across the day-to-day drift the freshness system is designed to track.
	"""

	def test_subprocess_emits_valid_envelope(self):
		"""
		Pipes a SessionStart payload through the actual hook script and
		verifies the stdout JSON parses and has the expected top-level
		envelope shape. The hook contract: always exit 0, always emit a
		valid envelope.
		"""
		proc = subprocess.run(
			["python3", str(HOOK_PATH)],
			input='{"cwd": "/home/dustin/Claude"}',
			capture_output=True,
			text=True,
			timeout=10,
		)
		self.assertEqual(
			proc.returncode, 0,
			f"hook must always exit 0; got {proc.returncode}, stderr={proc.stderr!r}"
		)
		envelope = json.loads(proc.stdout)
		self.assertIn("hookSpecificOutput", envelope)
		self.assertEqual(
			envelope["hookSpecificOutput"]["hookEventName"],
			"SessionStart"
		)
		self.assertIn("additionalContext", envelope["hookSpecificOutput"])

	def test_subprocess_writes_flags_file_with_documented_shape(self):
		"""
		Verifies the hook writes /tmp/claude/memory-stale-flags.json with
		the documented top-level shape — schema_version FIRST, counters
		nested under stats. Step 1 of the hardening pass made schema_version
		the first key for partial-read detection; this test pins that.
		"""
		flags_path = Path("/tmp/claude/memory-stale-flags.json")
		# Run the hook to generate a fresh report
		subprocess.run(
			["python3", str(HOOK_PATH)],
			input='{"cwd": "/home/dustin/Claude"}',
			capture_output=True,
			text=True,
			timeout=10,
		)
		self.assertTrue(
			flags_path.exists(),
			"hook must write /tmp/claude/memory-stale-flags.json"
		)
		report = json.loads(flags_path.read_text())
		# schema_version must be the FIRST key (Step 1) — Python dicts
		# preserve insertion order, so iter() gives the on-disk order
		first_key = next(iter(report))
		self.assertEqual(
			first_key, "schema_version",
			f"schema_version must be the first key for partial-read detection; "
			f"got {first_key!r}"
		)
		self.assertEqual(report["schema_version"], 1)
		# Required top-level keys
		for key in (
			"generated_at", "cwd", "project",
			"drift_threshold_hours", "flag_count", "stats", "flags",
		):
			self.assertIn(
				key, report,
				f"missing top-level envelope key: {key}"
			)
		# Counters live nested under stats — NOT at top level (this is the
		# inaccuracy the design doc previously had)
		for stat_key in (
			"sentinel_excluded", "scanned", "errors",
			"unparseable_timestamps",
		):
			self.assertIn(
				stat_key, report["stats"],
				f"missing stats key: {stat_key}"
			)


class _MonkeypatchedRootMixin:
	"""
	Mixin for tests that need to redirect ALLOW_LIST_ROOTS at a temp dir.

	Why a mixin instead of inheritance: TestCase already inherits from
	unittest.TestCase, and Python's MRO makes setUp chaining via
	super().setUp() the standard pattern. This mixin provides setUp/tearDown
	that any TestCase can mix in to get a temp test root.
	"""

	def setUp(self):
		# Each test gets its own temp directory so parallel runs don't
		# clobber each other (unittest doesn't parallelize by default, but
		# pytest does, and someone might convert these later).
		self.tmp = Path(tempfile.mkdtemp(prefix="freshness-test-"))
		self.test_root = self.tmp / "allowed-root"
		self.test_root.mkdir()
		self.db_path = self.tmp / "memory.db"
		# Save originals so tearDown can restore them. Without this, a test
		# that mutates ALLOW_LIST_ROOTS leaves the module in a broken state
		# for subsequent tests.
		self._orig_allow_list = hook.ALLOW_LIST_ROOTS
		self._orig_root_resolved = hook.PROJECT_ROOT_BASE_RESOLVED
		self._orig_root = hook.PROJECT_ROOT_BASE
		# Redirect the hook at our temp dir
		hook.PROJECT_ROOT_BASE = self.test_root
		hook.PROJECT_ROOT_BASE_RESOLVED = self.test_root.resolve()
		hook.ALLOW_LIST_ROOTS = (self.test_root.resolve(),)

	def tearDown(self):
		# Restore the module globals so the next test sees the real values
		hook.ALLOW_LIST_ROOTS = self._orig_allow_list
		hook.PROJECT_ROOT_BASE_RESOLVED = self._orig_root_resolved
		hook.PROJECT_ROOT_BASE = self._orig_root
		# rm -rf the temp dir; ignore_errors so a held-open file in the
		# test doesn't prevent cleanup of the rest
		shutil.rmtree(self.tmp, ignore_errors=True)

	def make_file(self, name, mtime_hours_ago):
		"""
		Creates a real file under self.test_root with a controlled mtime.

		Args:
		  name: relative filename (e.g. "drifted.md")
		  mtime_hours_ago: how far in the past the file's mtime should be

		Returns: the absolute path of the created file as a string.
		"""
		fpath = self.test_root / name
		fpath.write_text("test content")
		# os.utime takes (access_time, modify_time) as seconds-since-epoch
		# floats. We set both to the same value so atime doesn't drift
		# from mtime in ways that confuse anyone reading these files later.
		ts = (
			datetime.now(timezone.utc) - timedelta(hours=mtime_hours_ago)
		).timestamp()
		os.utime(fpath, (ts, ts))
		return str(fpath)


class TestFindStaleEntities(_MonkeypatchedRootMixin, unittest.TestCase):
	"""
	In-process tests on find_stale_entities() with a controlled temp DB.

	These cover the core mtime drift detection: file newer than obs by more
	than DRIFT_THRESHOLD_HOURS → flag, otherwise → no flag.
	"""

	def test_flag_when_file_newer_than_obs_by_more_than_threshold(self):
		"""File mtime now, obs 3h old → drift 3h > 1h threshold → flagged."""
		fpath = self.make_file("drifted.md", mtime_hours_ago=0)
		conn = build_test_db(self.db_path)
		insert_entity(conn, fpath, [
			("[old] some observation", iso_hours_ago(3)),
		])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(len(flags), 1)
		self.assertEqual(flags[0]["entity"], fpath)
		self.assertGreater(flags[0]["drift_hours"], 1.0)

	def test_no_flag_when_obs_newer_than_file(self):
		"""File 5h old, obs now → no drift → no flag."""
		fpath = self.make_file("fresh.md", mtime_hours_ago=5)
		conn = build_test_db(self.db_path)
		insert_entity(conn, fpath, [
			("[recent] just updated", iso_hours_ago(0)),
		])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(len(flags), 0)

	def test_no_flag_when_drift_below_threshold(self):
		"""File now, obs 30 min old → 0.5h < 1.0h threshold → no flag."""
		fpath = self.make_file("borderline.md", mtime_hours_ago=0)
		conn = build_test_db(self.db_path)
		insert_entity(conn, fpath, [
			("[recent]", iso_hours_ago(0.5)),
		])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(len(flags), 0)

	def test_scanned_counter_increments_per_unique_file(self):
		"""scanned should reflect every entity that got past dedup checks."""
		fpath1 = self.make_file("one.md", mtime_hours_ago=0)
		fpath2 = self.make_file("two.md", mtime_hours_ago=10)
		conn = build_test_db(self.db_path)
		insert_entity(conn, fpath1, [("a", iso_hours_ago(5))])
		insert_entity(conn, fpath2, [("b", iso_hours_ago(0))])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(stats["scanned"], 2)


class TestSentinelQuarantine(_MonkeypatchedRootMixin, unittest.TestCase):
	"""
	Tests on the BACKFILL_SENTINEL quarantine (Step 2 of hardening pass).

	The sentinel is the synthetic timestamp 2026-04-01T00:00:00.000Z that
	was assigned to 790 observations whose original created_at was 'unknown'.
	The hook MUST exclude these from flags and instead count them in
	stats['sentinel_excluded']. Without this, every session would flag ~790
	entities forever.
	"""

	def test_sentinel_obs_excluded_from_flags(self):
		fpath = self.make_file("sentinel.md", mtime_hours_ago=0)
		conn = build_test_db(self.db_path)
		insert_entity(conn, fpath, [
			("backfilled obs", hook.BACKFILL_SENTINEL),
		])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(len(flags), 0)
		self.assertEqual(stats["sentinel_excluded"], 1)

	def test_sentinel_obs_does_not_increment_scanned(self):
		"""
		Sentinel quarantine happens BEFORE the candidate-build loop, so
		scanned should NOT increment. This is what makes the perf win
		(no stat() call for ~790 entities every session).
		"""
		fpath = self.make_file("sentinel2.md", mtime_hours_ago=0)
		conn = build_test_db(self.db_path)
		insert_entity(conn, fpath, [
			("backfilled obs", hook.BACKFILL_SENTINEL),
		])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(stats["scanned"], 0)


class TestProjectScope(_MonkeypatchedRootMixin, unittest.TestCase):
	"""
	Tests on the project_name scope filter in find_stale_entities (Step 5b).

	When called with project_name=X, the function should only flag files
	whose resolved path is under PROJECT_ROOT_BASE_RESOLVED/X. This is the
	per-session focus filter — distinct from the multi-root allow-list,
	which is a safety filter and stays single-root by design.
	"""

	def test_project_scope_excludes_out_of_project_files(self):
		# Create two project subdirs
		(self.test_root / "proj_a").mkdir()
		(self.test_root / "proj_b").mkdir()
		# File under proj_a → should be flagged when project=proj_a
		fpath_a = self.test_root / "proj_a" / "file_a.md"
		fpath_a.write_text("a")
		ts = (datetime.now(timezone.utc)).timestamp()
		os.utime(fpath_a, (ts, ts))
		# File under proj_b → should NOT be flagged when project=proj_a
		fpath_b = self.test_root / "proj_b" / "file_b.md"
		fpath_b.write_text("b")
		os.utime(fpath_b, (ts, ts))

		conn = build_test_db(self.db_path)
		insert_entity(conn, str(fpath_a), [("a obs", iso_hours_ago(3))])
		insert_entity(conn, str(fpath_b), [("b obs", iso_hours_ago(3))])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, "proj_a")
		finally:
			conn.close()
		# Only proj_a file should be flagged
		self.assertEqual(len(flags), 1)
		self.assertEqual(flags[0]["entity"], str(fpath_a))


class TestExtractPath(unittest.TestCase):
	"""
	Tests on extract_path_from_text — multi-root allow-list (Step 4b),
	single-char trailing strip (Step 4), and prefix-match attack guards.
	"""

	def test_path_under_project_root_accepted(self):
		"""Standard project file path is accepted."""
		result = hook.extract_path_from_text(
			"Path: /home/dustin/Claude/dustin-space/foo.md"
		)
		self.assertEqual(result, "/home/dustin/Claude/dustin-space/foo.md")

	def test_path_under_dot_claude_root_accepted(self):
		"""Step 4b: paths under /home/dustin/.claude/ are now accepted."""
		result = hook.extract_path_from_text(
			"Path: /home/dustin/.claude/hooks/check-memory-freshness.py"
		)
		self.assertEqual(
			result,
			"/home/dustin/.claude/hooks/check-memory-freshness.py"
		)

	def test_etc_path_rejected(self):
		"""Phantom system path from prose: 'Path: /etc/shadow' → rejected."""
		result = hook.extract_path_from_text("Path: /etc/shadow")
		self.assertIsNone(result)

	def test_no_path_in_text(self):
		"""Text without a Path: line returns None."""
		result = hook.extract_path_from_text("just some text")
		self.assertIsNone(result)

	def test_trailing_dot_stripped(self):
		"""Sentence-ending dot stripped: 'Path: /foo/bar.md.' → '/foo/bar.md'."""
		result = hook.extract_path_from_text(
			"Path: /home/dustin/Claude/notes.md."
		)
		self.assertEqual(result, "/home/dustin/Claude/notes.md")

	def test_only_one_trailing_char_stripped(self):
		"""
		Step 4: only ONE trailing char stripped (vs the previous rstrip
		which stripped any combination). Path ending in `).` should keep
		the `)` and only strip the `.`.
		"""
		result = hook.extract_path_from_text(
			"Path: /home/dustin/Claude/foo.md)."
		)
		self.assertEqual(result, "/home/dustin/Claude/foo.md)")

	def test_prefix_match_attack_blocked_dotclaude(self):
		"""
		`.claudefoo` should NOT match `.claude` even though it starts with
		the same string. The allow-list check uses startswith(root + '/')
		precisely to block this prefix-match attack class.
		"""
		result = hook.extract_path_from_text(
			"Path: /home/dustin/.claudefoo/secret"
		)
		self.assertIsNone(result)

	def test_prefix_match_attack_blocked_claude(self):
		"""Same prefix attack but on the project root."""
		result = hook.extract_path_from_text(
			"Path: /home/dustin/Claudefoo/secret"
		)
		self.assertIsNone(result)


class TestParseObsContents(unittest.TestCase):
	"""
	Tests on parse_obs_contents — the dispatch helper for json_group_array
	(SQLite ≥ 3.38) vs char(30)-delimited GROUP_CONCAT (fallback). Step 6.

	Implementation note: parse_obs_contents dispatches on the module-level
	constant `_SQLITE_HAS_JSON_GROUP_ARRAY` (True/False), NOT on the
	OBS_AGG_SQL string. Setting OBS_AGG_SQL would only affect SQL string
	generation, not the parser dispatch — the parser is decoupled from the
	SQL builder so a future caller can pick a different path without
	rebuilding the SQL. Tests must monkey-patch the bool flag.
	"""

	def setUp(self):
		# Save the dispatch flag — parse_obs_contents reads this directly,
		# OBS_AGG_SQL is unrelated to the parser branch.
		self._orig_flag = hook._SQLITE_HAS_JSON_GROUP_ARRAY

	def tearDown(self):
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = self._orig_flag

	def test_json_path_parses_list(self):
		"""json_group_array returns a JSON array string → json.loads."""
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = True
		result = hook.parse_obs_contents('["a", "b", "c"]')
		self.assertEqual(result, ["a", "b", "c"])

	def test_char30_path_parses_split(self):
		"""GROUP_CONCAT(char(30)) returns 0x1E-delimited → str.split."""
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = False
		result = hook.parse_obs_contents("a\x1eb\x1ec")
		self.assertEqual(result, ["a", "b", "c"])

	def test_json_path_handles_special_chars(self):
		"""
		Content with newlines, pipes, tabs, and the old `|||` sentinel
		survives the json round-trip. This is the regression test for
		why we replaced `|||` with json_group_array — `|||` would silently
		split observations that legitimately contained the sentinel.
		"""
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = True
		original = ["a|||b", "line1\nline2", "tab\there", "{json}"]
		encoded = json.dumps(original)
		result = hook.parse_obs_contents(encoded)
		self.assertEqual(result, original)

	def test_json_path_returns_empty_on_malformed(self):
		"""
		Malformed JSON should return [] silently (the only error class
		parse_obs_contents swallows). The cost of the swallow is bounded:
		at worst we miss Path: markers in that entity, producing a false
		negative on the next session — caught by the next session's run.
		"""
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = True
		result = hook.parse_obs_contents("not json at all")
		self.assertEqual(result, [])

	def test_none_input_returns_empty(self):
		"""None input (edge case where the JOIN somehow yields no obs)
		returns [] without raising, regardless of dispatch path."""
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = True
		self.assertEqual(hook.parse_obs_contents(None), [])
		hook._SQLITE_HAS_JSON_GROUP_ARRAY = False
		self.assertEqual(hook.parse_obs_contents(None), [])


class TestUnparseableTimestamps(_MonkeypatchedRootMixin, unittest.TestCase):
	"""
	Tests on the unparseable_timestamps counter (Step 7).

	If an observation's max(created_at) can't be parsed by parse_iso_timestamp,
	the entity is silently skipped (can't compute drift without a timestamp)
	but counted in stats['unparseable_timestamps'] with the first offender
	captured in stats['first_unparseable']. This was a silent-failure fix:
	previously a schema migration that broke timestamp parsing would empty
	the flag list and the hook would cheerfully report 'all clean.'
	"""

	def test_unparseable_increments_counter(self):
		fpath = self.make_file("garbage_ts.md", mtime_hours_ago=0)
		conn = build_test_db(self.db_path)
		# 'not-a-date' will fail parse_iso_timestamp's fromisoformat call
		insert_entity(conn, fpath, [("obs with bad ts", "not-a-date")])
		conn.close()
		conn = open_test_db_readonly(self.db_path)
		try:
			flags, stats = hook.find_stale_entities(conn, None)
		finally:
			conn.close()
		self.assertEqual(len(flags), 0)
		self.assertEqual(stats["unparseable_timestamps"], 1)
		self.assertIsNotNone(stats["first_unparseable"])
		# The triage string should include the entity name and the raw value
		self.assertIn("garbage_ts.md", stats["first_unparseable"])
		self.assertIn("not-a-date", stats["first_unparseable"])


class TestErrorPaths(unittest.TestCase):
	"""
	Tests on the 'always exit 0 with valid envelope' invariant (Step 3).

	The hook MUST never break session start. Even hard errors (missing DB,
	schema drift, unhandled exceptions) must produce a degraded envelope
	and exit 0. These tests use subprocess so DB_PATH is recomputed in the
	child process from a fresh HOME env, exercising the missing-DB branch.
	"""

	def test_missing_db_returns_zero_with_valid_envelope(self):
		with tempfile.TemporaryDirectory() as tmphome:
			# Override HOME so the child's Path.home() / '.claude' / 'memory.db'
			# resolves to a path that doesn't exist
			env = os.environ.copy()
			env["HOME"] = tmphome
			proc = subprocess.run(
				["python3", str(HOOK_PATH)],
				input='{"cwd": "/tmp"}',
				capture_output=True,
				text=True,
				timeout=10,
				env=env,
			)
			# Must exit 0 even though the DB is missing
			self.assertEqual(
				proc.returncode, 0,
				f"hook must exit 0 on missing DB; got {proc.returncode}"
			)
			# stdout must still be a valid envelope
			envelope = json.loads(proc.stdout)
			self.assertIn("hookSpecificOutput", envelope)
			self.assertEqual(
				envelope["hookSpecificOutput"]["hookEventName"],
				"SessionStart"
			)
			# additionalContext should mention the missing DB so the user
			# can tell what happened — exact wording isn't pinned, but
			# the message should be non-empty
			ctx = envelope["hookSpecificOutput"]["additionalContext"]
			self.assertTrue(
				len(ctx) > 0,
				"degraded envelope must include a non-empty additionalContext"
			)


class TestSchemaDrift(unittest.TestCase):
	"""
	Tests on verify_schema → SchemaDriftError (Step 3).

	A DB missing one of the required columns should raise SchemaDriftError
	with the missing column name in the message. This is what lets the
	main() wrapper distinguish 'MCP migrated and we need to update the
	hook' from 'transient DB lock' from 'generic Python error.'
	"""

	def test_missing_name_column_raises_schema_drift(self):
		with tempfile.TemporaryDirectory() as tmp:
			db_path = Path(tmp) / "broken.db"
			conn = sqlite3.connect(db_path)
			cur = conn.cursor()
			# Build a broken schema: entities table missing the 'name' column
			cur.execute(
				"CREATE TABLE entities (id INTEGER PRIMARY KEY, entity_type TEXT)"
			)
			# Build a complete observations table so the failure is
			# unambiguously the entities.name column
			cur.execute(
				"CREATE TABLE observations ("
				"  id INTEGER PRIMARY KEY, entity_id INTEGER, content TEXT, "
				"  created_at TEXT, superseded_at TEXT)"
			)
			conn.commit()
			# verify_schema should raise SchemaDriftError naming 'name'
			with self.assertRaises(hook.SchemaDriftError) as ctx:
				hook.verify_schema(conn)
			self.assertIn("name", str(ctx.exception))
			conn.close()

	def test_missing_observations_table_raises_schema_drift(self):
		"""
		If the observations table is missing entirely, PRAGMA returns an
		empty result and verify_schema should raise with a 'table not
		found' message rather than a generic 'missing column' message.
		"""
		with tempfile.TemporaryDirectory() as tmp:
			db_path = Path(tmp) / "no_obs.db"
			conn = sqlite3.connect(db_path)
			cur = conn.cursor()
			cur.execute(
				"CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT)"
			)
			conn.commit()
			with self.assertRaises(hook.SchemaDriftError) as ctx:
				hook.verify_schema(conn)
			self.assertIn("observations", str(ctx.exception))
			conn.close()


if __name__ == "__main__":
	# verbosity=2 prints one line per test name; useful for catching which
	# specific test failed without scrolling. exit_on_failure semantics:
	# unittest.main() returns nonzero on failure by default.
	unittest.main(verbosity=2)
