# Memory MCP Server Install Instructions

## Pre-Migration State
- Currently running: upstream `@modelcontextprotocol/server-memory` v2026.1.26 via npx
- Data: 167 entities, 297 relations in `~/.claude/memory.jsonl` (198KB)
- Format: plain string observations (no timestamps)

## Step 1: Create Backups

```bash
cp ~/.claude/memory.jsonl ~/.claude/memory.jsonl.backup-20260403
cp ~/.claude.json ~/.claude.json.backup-20260403
```

## Step 2: Switch the MCP Server

```bash
claude mcp remove memory
claude mcp add -s user memory \
  -e MEMORY_FILE_PATH=/home/dustin/.claude/memory.db \
  -- node /home/dustin/Claude/mcp-memory-server/dist/index.js
```

## Step 3: Restart Claude Code

The new server will auto-migrate on first startup:
1. Sees `MEMORY_FILE_PATH=~/.claude/memory.db` with `.db` extension -> SQLite store
2. No `.db` exists -> checks for sibling `.jsonl` -> finds `~/.claude/memory.jsonl`
3. Loads all 167 entities from JSONL
4. Migrates into SQLite in a single transaction
5. Runs timestamp backfill (no-op for this data -- see note below)
6. Renames `memory.jsonl` -> `memory.jsonl.bak`

## Step 4: Verify

```bash
sqlite3 ~/.claude/memory.db "SELECT COUNT(*) FROM entities;"
# Expected: 167

sqlite3 ~/.claude/memory.db "SELECT COUNT(*) FROM relations;"
# Expected: 297

# Verify .jsonl was backed up by the migration
ls -la ~/.claude/memory.jsonl.bak
```

## Rollback (if anything goes wrong)

```bash
cp ~/.claude.json.backup-20260403 ~/.claude.json
rm -f ~/.claude/memory.db ~/.claude/memory.db-wal ~/.claude/memory.db-shm
cp ~/.claude/memory.jsonl.backup-20260403 ~/.claude/memory.jsonl
```

Then restart Claude Code -- it will be back on the upstream server.

## Timestamp Behavior Note

Since the live data uses upstream format (plain string observations with no `createdAt` field),
the fork's `normalizeObservation()` converts them to `{ content: string, createdAt: 'unknown' }`.
The timestamp backfill looks for observation timestamps to compute entity `updatedAt`/`createdAt`,
but since all observations have `createdAt: 'unknown'`, the backfill is a no-op. All 167 entities
start with sentinel timestamps (`0000-00-00T00:00:00.000Z`).

This is correct behavior -- they all have equal sort order (tiebroken by `id DESC`), so pagination
will still walk through every entity. As soon as you add or delete observations on any entity going
forward, its `updatedAt` gets bumped to the current time and it floats to the top of `read_graph`
results. The system becomes progressively more useful as memories get refreshed.
