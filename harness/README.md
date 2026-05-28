# Memory Server Harness

The MCP server in this repo's root provides the storage layer (knowledge graph, vector search, temporal versioning). The harness in this directory is **everything else** that makes the server actually *useful across sessions and compactions* in a real Claude Code installation:

- **Hooks** that load L0 context on session start, flag stale memory entries, gate noisy writes, save snapshots at compaction boundaries
- **Skills** (`/audit-memory`, `/checkpoint`) that orchestrate maintenance and snapshot workflows
- **Custom agents** (`silent-failure-hunter`, `adversarial-tester`) used by the project's own QA review process
- **CLAUDE.md fragments** that establish the Session Protocol, Mid-Session Memory Triggers, and Subagent Model Rules
- **Settings/MCP registration examples** showing how the pieces wire into Claude Code

The server runs without any of this. The harness is what turns a generic MCP memory tool into the kind of system the [project goals](../CLAUDE.md#project-goals) describe — "fast, accurate, drift-resistant, and directly useful in the moment."

## Source of truth

These files are **verbatim copies** of what's running on the original installation (Fedora 43 KDE, `/home/dustin/.claude/hooks/`, `/home/dustin/.claude/skills/`, `/home/dustin/.claude/agents/`). Hardcoded paths still contain `/home/dustin/Claude` and `/home/dustin/.claude` — the install script substitutes those at install time so the source remains a faithful record of what's deployed.

## Quick install

```bash
cd harness
./install.sh
```

The installer is idempotent. Existing files get timestamped backups before overwrite. It does **not** touch your `settings.json`, `~/.claude.json`, or `CLAUDE.md` — those merges are printed at the end for you to apply manually.

### Configurable destinations

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_HOME` | `$HOME/.claude` | Where Claude Code stores user config (hooks, skills, agents) |
| `WORKSPACE_BASE` | `$HOME/Claude` | Where your project directories live (parent of `mcp-memory-server/`) |
| `AUDIT_STATE_DIR` | `$HOME/.local/state/claude-memory-audit` | Watermark file for the `/audit-memory` skill |

Most users will accept the defaults. Override only if your Claude Code install lives somewhere unusual.

## What's inside

```
harness/
├── README.md                  # this file
├── install.sh                 # idempotent installer
├── hooks/                     # 11 files — wire the server into Claude Code's lifecycle
│   ├── load-l0-context.py            # SessionStart × 3 chunks
│   ├── check-memory-freshness.py     # SessionStart freshness scan
│   ├── check-memory-noise.py         # PostToolUse after writes
│   ├── memory-save-gate.sh           # Stop checkpoint
│   ├── periodic-memory-check.sh      # cron-style maintenance
│   ├── session-end-agent.sh          # SessionEnd orchestrator
│   ├── sessionend-prompt.md          # prompt body for the SessionEnd agent
│   ├── pre-compact-agent.sh          # PreCompact orchestrator
│   ├── precompact-prompt.md          # prompt body for the PreCompact agent
│   ├── post-compact-agent.sh         # PostCompact orchestrator
│   └── test_check_memory_freshness.py
├── skills/
│   ├── audit-memory/SKILL.md
│   └── checkpoint/SKILL.md
├── agents/
│   ├── silent-failure-hunter.md
│   └── adversarial-tester.md
├── settings/
│   ├── settings.hooks.example.json    # hooks block to merge into ~/.claude/settings.json
│   └── mcp-registration.example.json  # entry to merge into ~/.claude.json mcpServers
└── claude-md/
    ├── session-protocol.md            # paste into ~/Claude/CLAUDE.md
    └── subagent-model-rules.md        # paste into ~/Claude/CLAUDE.md
```

## How the pieces fit together

```
SessionStart event fires
  └─ load-l0-context.py (×3 chunks)
      └─ calls mcp__memory__get_context_layers → injects L0 rules into context
  └─ check-memory-freshness.py
      └─ scans entities with file paths in observations
      └─ flags any whose file mtime is newer than the most recent observation
      └─ writes flag report to /tmp/claude/memory-stale-flags.json

User makes a tool call (Edit, Write, etc.) — PreToolUse fires
  └─ block-sensitive-files.py  (separate concern, not in harness)

mcp__memory__add_observations or supersede_observations is called
  └─ PostToolUse → check-memory-noise.py
      └─ catches low-value observations (one-liner status, generic phrasing)
      └─ warns in stderr; does not block the write

Stop event (end of assistant turn)
  └─ memory-save-gate.sh
      └─ every ~10 turns, suggests a memory save checkpoint

PreCompact event (context window about to compress)
  └─ pre-compact-agent.sh
      └─ launches a Claude subagent with precompact-prompt.md
      └─ saves unsaved decisions/preferences/status to MCP before context is lost

PostCompact event
  └─ post-compact-agent.sh
      └─ re-loads L0 context and current project state into the compacted window

SessionEnd event
  └─ session-end-agent.sh
      └─ launches a Claude subagent with sessionend-prompt.md
      └─ extracts the session's durable outcomes into MCP entities/observations
```

## What the installer does NOT do

The installer stops short of any change that could conflict with existing config:

1. **Does not edit `~/.claude/settings.json`** — your hooks block likely has entries the harness shouldn't touch. The installer prints the snippet to merge.
2. **Does not edit `~/.claude.json`** — your MCP server registration lives here. The installer prints the `claude mcp add` command.
3. **Does not edit your `CLAUDE.md`** — the Session Protocol fragments are printed; you decide where they go and how they integrate with your existing prose.
4. **Does not build the MCP server** — that's a separate step (`npm install && npm run build` in the repo root). The installer reminds you if `../dist/index.js` is missing.
5. **Does not create the memory database** — it auto-migrates from JSONL on first run, or starts empty (see `../memory-install-instructions.md`).

## Verifying the install

After running `install.sh` and applying the printed integration steps, restart Claude Code and check:

```bash
# Server registered:
grep -A 6 '"memory"' ~/.claude.json | head -10

# Hooks present and executable:
ls -la ~/.claude/hooks/load-l0-context.py ~/.claude/hooks/check-memory-freshness.py

# Skills discoverable:
ls ~/.claude/skills/audit-memory/SKILL.md ~/.claude/skills/checkpoint/SKILL.md

# Agents discoverable:
ls ~/.claude/agents/silent-failure-hunter.md ~/.claude/agents/adversarial-tester.md

# Database accessible:
sqlite3 ~/.claude/memory.db "SELECT version FROM schema_version;"
```

In a new Claude Code session, the first system reminder should contain `# MEMORY (chunk 0 of N, project=...)` — that's the L0 auto-load firing.

## Updating the harness

If a hook is updated on the source machine, regenerate the harness by re-copying:

```bash
cd /path/to/mcp-memory-server
cp ~/.claude/hooks/{load-l0-context.py,check-memory-freshness.py,check-memory-noise.py,memory-save-gate.sh,periodic-memory-check.sh,session-end-agent.sh,sessionend-prompt.md,pre-compact-agent.sh,precompact-prompt.md,post-compact-agent.sh,test_check_memory_freshness.py} harness/hooks/
cp ~/.claude/skills/audit-memory/SKILL.md harness/skills/audit-memory/
cp ~/.claude/skills/checkpoint/SKILL.md harness/skills/checkpoint/
cp ~/.claude/agents/{silent-failure-hunter.md,adversarial-tester.md} harness/agents/
git diff harness/
```

Then commit. The next person to run `install.sh` (including you on another machine) gets the update.

## Why bundle this with the server

[Project goals](../CLAUDE.md#the-three-durable-goals-abc) — A (reduce drift), B (faithful recall), and C (better conversations / quality code) — are not achieved by the server alone. The server is a knowledge graph store; the harness is what turns it into a memory system. Without the harness:

- L0 rules don't auto-load → drift returns at every session start
- Stale entries don't get flagged → recall produces facts that were true months ago
- Compaction loses unsaved context → conversation continuity breaks
- Noise builds up unchecked → the noise crowds out the useful observations

Each piece in this directory addresses a specific failure mode the bare server doesn't cover. The original Lumidex / Sep 2026 incident referenced in `feedback_smallest_sufficient_fix.md` is exactly the shape of failure the harness exists to prevent.
