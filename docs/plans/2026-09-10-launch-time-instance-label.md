# Launch-time instance label for memory writes

## Status (updated 2026-09-10 04:20 PT)
Phase: 3 of 3 — BUILT, LIVE-PROVEN, QA fix wave applied (HIGH-RISK panel: 42 findings, manifest 42/42)
Done: everything in the build list plus the fix wave (see QA rulings below); suites: server 8/8 label cases (tsc clean, dist rebuilt), wrappers 48/48, loaders 42/42 + 18/18, setter hook 14/14; DB shows all four launch-time labels
Next: the owner's ruling on the lifecycle-agent label (group 1) and the retry unit's PATH; receipt line; memory reconciliation
Blocked: the one ruling

## Problem (2026-09-10)
The model names recorded on memory rows were wrong: one harness's label named a
model that had never been used. Goal: record the model actually writing each
memory. Approved scope: resolve the model at launch time; a model change in
the middle of a session rarely coincides with a memory save, so that gap is
accepted.

Today `observations.source_instance` is whatever `MEMORY_INSTANCE_NAME` says in
each harness's MCP registration: a string typed at install time. Codex's says
`ChatGPT 5.5`; OpenCode's says the host name (collides with Claude Code, QA CR-1
2026-09-09). Nothing tracks the model.

## Verified facts (2026-09-10, sources cited)
- Server resolves the label PER WRITE, not at startup: `types.ts:679`
  `resolveSourceInstance()`; three call sites in sqlite-store.ts (2081, 2324,
  2682). A per-write file read is therefore possible without restarts.
- Claude Code: stdio MCP servers inherit the parent Claude Code process env
  (docs /env-vars). `${VAR}` expansion is documented for project `.mcp.json`
  only; user-scope `~/.claude.json` is undocumented → do not rely on it.
  SessionStart hook input MAY carry a `model` field ("Claude Code doesn't
  always include it"). SessionStart fires before MCP servers connect.
- Codex: does NOT inherit parent env; `[mcp_servers.<id>]` takes
  `env_vars = ["NAME"]` to whitelist parent vars (learn.chatgpt.com config
  reference; codex-rs/rmcp-client/src/utils.rs `create_env_for_mcp_server`).
  Model: `-m/--model` flag or `model = "..."` in `~/.codex/config.toml` (line 3).
- OpenCode: inherits full `process.env` and layers `environment` on top
  (packages/opencode/src/mcp/index.ts `connectLocal`); `{env:VAR}` substitution
  exists too. Model: `-m/--model` or `"model"` in opencode.jsonc (line 6).
- Kimi Code 0.36.1: inherits full parent env (`mergeStdioEnv` in the installed
  bundle, main.mjs:229624); no substitution. Model: `-m/--model` or
  `default_model` in `~/.kimi-code/config.toml` (line 1).
- Launch paths: all four binaries are updater-managed symlinks in
  `~/.local/bin` (rewritten on update — a wrapper must NOT live there).
  A tmux-based auto-resume launcher runs `claude` via PATH. The desktop URL handler calls
  `~/.local/bin/claude` by absolute path (bypasses any wrapper → fallback label).
  PATH is assembled in `~/.bashrc:10` and `~/.bash_profile:16`.
- Antigravity registers as `Antigravity` (`~/.gemini/config/mcp_config.json`);
  4 rows ever; model source unknown → harness label only, out of scope.

## Design
Label format: `<Harness> <model-as-the-harness-names-it>`, e.g.
`Codex gpt-6-astra`, `Kimi Code kimi-code/k3`, `OpenCode opencode-go/glm-5.2`,
`Claude Code claude-fable-5-1[1m]`. The model string is copied from the flag
or config verbatim; never from the model's self-report.

1. **Server** (`types.ts` `resolveSourceInstance`): if
   `MEMORY_INSTANCE_NAME_FILE` is set and the file reads non-empty after trim,
   return that; else `MEMORY_INSTANCE_NAME`; else `unknown`. Read per call
   (writes are rare; a 40-byte read is nothing). Unreadable file → fall through
   to the env label (loud enough: the static fallback is the harness name).
2. **Wrappers** in `~/.local/wrappers/` (new, prepended to PATH in
   `.bashrc`/`.bash_profile`): `claude`, `codex`, `kimi`, `opencode`. Each:
   parse `-m X` / `--model X` / `--model=X` from argv; else read the harness's
   config default; write `<Harness> <model>` to
   `~/.cache/memory-instance/<harness>-<pid>.label`; export
   `MEMORY_INSTANCE_NAME_FILE`; sweep files older than 7 days (bounded growth,
   Power-of-Ten 3); `exec` the real symlink. Shared helper
   `~/.local/wrappers/lib/memory-instance-label.sh`. Per-launch file, so two
   concurrent sessions of one harness with different models do not clobber
   each other.
3. **Config edits** (static FALLBACK labels become harness names, always true):
   `~/.codex/config.toml` `MEMORY_INSTANCE_NAME = "Codex"` + `env_vars =
   ["MEMORY_INSTANCE_NAME_FILE"]` under `[mcp_servers.memory]`;
   `~/.kimi-code/mcp.json` `"Kimi Code"`; `~/.config/opencode/opencode.jsonc`
   `"OpenCode"` (closes CR-1); `~/.claude.json` and
   `~/.claude/consolidation-mcp.json` `"Claude Code"`.
4. **Loader hooks** (`load-l0-context.py`, `load-inflight-roster.py`): "own"
   = label in {`<host>` (legacy static label), `Claude Code` (fallback), content of
   `$MEMORY_INSTANCE_NAME_FILE` if set}. A row from a Claude Code session on a
   different model (e.g. a stepped-down Opus session) therefore shows as
   `[L0 · Claude Code claude-opus-5]` — the Fable/Opus gap partly closes for
   launch-time model choice. Tests: pin the set, pin the env-file read.
5. **SessionStart hook** (`set-memory-instance-label.py`, type command): if
   stdin carries `model` and `MEMORY_INSTANCE_NAME_FILE` is set, rewrite the
   file as `Claude Code <model>`. Makes flag-less launches exact when Claude
   Code supplies the field. Runs before servers connect, which is fine: the
   server reads the file at write time.

Known gaps, stated: a mid-session `/model` or a silent step-down is not
reflected (accepted by the owner: rare coincidence with a save); launches that bypass
PATH (desktop URL handler) get the harness fallback label; Antigravity stays
static.

## Scope-audit rulings (Architect, 2026-09-10 03:58: SHIP with two conditions)
- Condition 1, part 5 (SessionStart hook) is IN, and the wrapper keeps its
  flag/config parse. They are not duplicates: the wrapper must exist to create
  the per-launch file and export its path (a hook cannot set its parent's
  env), and the hook refines the seed only when Claude Code supplies `model`.
- Condition 2, why a file and not plain env passthrough: a value in the
  environment is frozen at launch; a file can be rewritten later by any hook
  (the SessionStart refinement now, a per-write transcript stamp later without
  a server change). The file is the seam that keeps layer 3 possible.
- Verification cells the audit added: (i) the auto-resume launcher runs `claude` directly under
  `tmux new-session`, whose PATH comes from the tmux SERVER env, not the
  caller's shell → the launcher passes `-e PATH="$PATH"` (one-line edit, recorded
  as a deviation below); (ii) the wrapper dir must precede `~/.local/bin` and
  exec the real symlink by absolute path; (iii) Kimi and OpenCode env
  inheritance is proven by the live write-and-read-back per harness at QA,
  not assumed from source reading.

## QA rulings and accepted limits (HIGH-RISK panel, 2026-09-10; full record kept
outside the repo)
- **Measured, not assumed:** on this machine the SessionStart payload carries
  NO `model` field (keys: cwd, hook_event_name, session_id, source,
  transcript_path; recorded by the setter to `last-sessionstart.json`). The
  setter therefore never fires here today; the wrapper seed is the label.
  Seed, setter and loaders all strip a trailing `[...]`, so the forms agree
  whenever the field does appear.
- **Ownership is race-free:** the loaders add "Claude Code <payload model>"
  from their OWN stdin (union with the file and the static set); the setter's
  parallel rewrite cannot race them.
- **Accepted, same-user boundary:** the label file is writable by the process
  it labels (the DB always was); the label is advisory provenance, not an
  integrity attribute. A 120-char one-line label can still carry text; the
  loaders render it inside `[L0 · …]` verbatim.
- **Accepted launch-time gaps:** Kimi `-r` resume keeps the saved session
  model (wrapper stamps the global default); Codex profiles / CODEX_HOME are
  not consulted; an alias launch (`--model opus`) stamps the alias while
  id-form sessions tag it. A label file deleted mid-session degrades to the
  static label.
- **Bypass paths write the static host label:** desktop URL handler, the consolidator
  service, and `memory-retry.service` (its unit PATH has no wrapper dir). The
  retry case matters: a failed lifecycle save replayed there gets the static
  host label while the first attempt would get `Claude Code claude-sonnet-5`.
- **OPEN — owner's ruling:** the session-end and pre-compact savers run
  `claude -p --model sonnet` through the wrapper and are labeled accurately as
  Sonnet; the loaders then tag those rows in Fable sessions. Keep (head's
  lean) or treat all `Claude Code *` as own. Falsifier after the next session
  end: `SELECT source_instance, COUNT(*) FROM observations WHERE created_at >
  '2026-09-10T11:00' GROUP BY 1`.
- **Probes registered:** `wrapper-shadows-claude` (PATH canary) and
  `codex-label-carries-model` (whitelist canary); run `probe run --stale`
  after any harness update.

## Phases
1. Server override + vitest (this repo). Rebuild `dist/`.
2. Wrappers + helper + bash test; PATH lines.
3. Config edits, loader-hook update + tests, SessionStart hook + settings entry.
QA at close: ROUTINE (code-reviewer + test-analyzer) plus a live proof: launch
each harness through its wrapper, write one observation, read
`source_instance` back from the DB.

## Deviations
- **Auto-resume launcher edit (scope-change, small):** `tmux new-session` now passes
  `-e "PATH=$PATH"`, because a new tmux session takes PATH from the tmux
  server, which can predate the wrapper dir. Without it the launcher's sessions would
  bypass the wrapper. Added at the Architect's verification cell (i).
- **`~/.claude.json` NOT edited (deferment, deliberate):** Claude Code rewrites
  that file live (its label line moved from 2536 to 2523 during this session).
  Its static host label stays as the bypass fallback; the FILE override wins for
  every wrapper-launched session, and both loaders treat the host label as own. Same
  for `consolidation-mcp.json`. Effect: a launch that bypasses PATH (desktop
  URL handler; the systemd consolidator, whose unit env has no wrapper dir)
  writes the static host label, exactly as before.
- **PATH block rewritten once (behavioral fix):** the first version was
  "add if absent" and lost to installer lines that re-prepend `~/.local/bin`
  later in the same file (login-shell probe resolved `claude` to the bare
  symlink). Now strip-then-prepend as the LAST PATH edit in each rc file;
  verified in login and interactive shells (one wrappers entry, first).
- **Test hazard found and fixed:** the first wrapper test `source`d the
  wrappers, which run `exec` at the end, so it started claude, codex and kimi
  for real. The test now extracts the default-model function by name with sed
  and never sources a wrapper. Recorded here so nobody repeats it.
