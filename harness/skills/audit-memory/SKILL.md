---
name: audit-memory
description: Runs a thorough memory audit on the current project — freshness verification, noise triage, classification, and consolidation. Use as /audit-memory or /audit-memory <project>.
---

Run a full memory audit. Target: $ARGUMENTS (or the current project if no argument given).

## Why this exists

Memory observations drift as files change, and many observations were written before the write policy existed — they contain API signatures, table DDL, test counts, and other derivable noise. This skill does a comprehensive pass: freshness verification, noise triage, classification, and consolidation.

## Write Policy (inline reference)

**STORE (expensive to re-derive):**
- Decisions and reasoning → memoryType: `decision`, importance: 4-5
- Procedures (how to do X) → memoryType: `procedure`, importance: 4
- Architecture patterns → memoryType: `architecture`, importance: 3-4
- Lessons learned / problems → memoryType: `problem`, importance: 4
- User preferences → memoryType: `preference`, importance: 4-5
- Project status → memoryType: `status`, importance: 4
- Emotional context → memoryType: `emotional`, importance: 3

**DO NOT STORE (derivable in <2 tool calls):**
- Function signatures, parameter lists, return types
- Line numbers
- File inventories
- Test counts
- API/tool schemas
- Table definitions / column listings
- Import statements
- Version snapshots (unless tied to a decision)

**Litmus test:** Could Claude re-derive this in <2 tool calls? If yes, it's noise.

## Steps

### Step 1: Refresh freshness flags

```bash
echo '{"cwd":"<target-cwd>"}' | python3 /home/dustin/.claude/hooks/check-memory-freshness.py
```
If `$ARGUMENTS` was given, set `<target-cwd>` to `/home/dustin/Claude/$ARGUMENTS`. Otherwise use the current working directory.

### Step 2: Read and verify the flag report

Read `/tmp/claude/memory-stale-flags.json`. Verify:
- `schema_version == 1` — if different, abort and tell user.
- `generated_at` is within 60 seconds of `date -u`. If stale, re-run step 1; if still stale, abort.

### Step 3: Process each entity (three passes)

For each flagged entity (highest drift first), and then for all other entities in the project:

1. Open the entity with `mcp__memory__open_nodes`
2. Read the cited file (or relevant section if large)
3. Apply three passes to each observation:

#### Pass A: Freshness check
- Compare observation against current file content
- If factually wrong → supersede with corrected version

#### Pass B: Noise triage
- Apply the DO NOT STORE list above
- If the observation is pure noise (API signature, table DDL, test count, line number, file inventory):
  - If there's a useful architectural insight buried in the noise, supersede with a brief summary at importance 2 using `supersede_observations`. The newContent MUST be real, useful content — never a tombstone marker.
  - If it's pure noise with no insight worth preserving, retire it with `delete_observations`. This moves it to Tier 2 (Superseded) where it's recoverable via `asOf` temporal queries — it is NOT a hard delete. The four-tier lifecycle (Active → Superseded → Tombstoned → Hard-deleted) handles the rest.
  - **NEVER** create observations whose content starts with `[superseded:` or similar tombstone markers. The `supersede_observations` tool retires the old content automatically — writing a tombstone as the *replacement* creates active noise that clogs `get_summary` and `search_nodes`.

#### Pass C: Classification
For every observation that survives as signal, use `mcp__memory__set_observation_metadata` to set:
- `importance`: 4-5 for decisions/procedures/blockers, 3 for stable architectural facts, 2 for supporting detail, 1 for deprioritized noise
- `contextLayer`: `L0` for critical rules/constraints, `L1` for current status/recent decisions/active procedures, `null` for everything else
- `memoryType`: one of: decision, procedure, architecture, problem, preference, status, emotional, fact

#### Consolidation (fact dedup)
Multiple observations about the same evolving fact (e.g., "test count is 310" + "test count is 343" + "test count is 520"):
- Supersede all versions into ONE observation with the current value
- OR drop entirely if derivable from grep/read

### Step 3b: Density Pruning (entity-level consolidation)

After Pass A/B/C, check each entity's active observation count. If an entity has
**>15 observations**, run the density pruning subroutine:

1. **Group by theme.** Read all observations and identify thematic clusters (e.g.,
   identity, workflow, coding, astrophotography). Observations that cover the same
   topic from different angles or different sessions are candidates for merge.

2. **Identify merge candidates.** Within each cluster:
   - Near-duplicates (same fact, different wording) → merge into one
   - Superseded-by-evolution (old status + new status) → keep newest, retire old
   - Complementary fragments (partial facts that form one complete picture) → merge
   - Meta-observations (session logs, "N observations added") → delete

3. **Preserve during merge:**
   - Who/what/when/where/why/how — never lose a named fact or decision rationale
   - Emotional/experiential context — tone, trust moments, vulnerability
   - Temporal anchors — dates, version numbers, session references
   - The MOST IMPORTANT detail from each source observation

4. **Merge mechanics:**
   - Use `supersede_observations` on ONE of the source observations with consolidated
     `newContent`. Then `delete_observations` on the others.
   - Set importance/contextLayer/memoryType on the merged observation to the HIGHEST
     values from any source.

5. **Ambiguity rule:** If two observations appear to conflict, or if merging would
   lose a nuance you can't confidently assess, **do not merge — flag for user review.**
   List the observations, explain the conflict, and let the user decide. Better to
   keep 2 redundant observations than to lose a nuance the user considers important.

6. **Target density:** Aim for 8-15 observations per entity after pruning. Below 8
   suggests the entity could be merged with a parent. Above 15 suggests the entity
   needs splitting or further consolidation.

**When to run:** This subroutine runs as part of /audit-memory when any entity exceeds
the 15-observation threshold. It should also be triggered by PreCompact when the total
active observation count exceeds 500 (graph-wide pressure, not just per-entity).

**Analogy:** This is the memory equivalent of sleep consolidation — merging related
memories, pruning redundant detail, strengthening important patterns. Like biological
consolidation, it's intentionally lossy for detail but lossless for decisions,
procedures, and emotional context. The trade-off is worth it: without pruning, the
signal-to-noise ratio degrades until retrieval becomes unreliable.

### Step 4: Apply changes in batches

- Supersessions: up to 100 per `mcp__memory__supersede_observations` call
- Metadata updates: up to 100 per `mcp__memory__set_observation_metadata` call

### Step 5: Update the audit watermark

```bash
mkdir -p /home/dustin/.local/state/claude-memory-audit
date -u +'%Y-%m-%dT%H:%M:%SZ' > /home/dustin/.local/state/claude-memory-audit/last-audit.timestamp
```

### Step 6: Report summary

```
Memory audit complete (project: <name>)
- Entities checked: N
- Observations superseded: M
- Observations reclassified: R
- Observations deprioritized (noise): D
- Entities verified clean: K
- Manual review needed: <list, if any>
```

## Data preservation rule

**Never manually hard-delete information.** The four-tier lifecycle (Active → Superseded → Tombstoned → Hard-deleted) handles data degradation automatically based on size pressure, age, and access recency. Hard-delete only occurs when the DB exceeds 90% of its cap AND the data has been tombstoned for >1 year AND hasn't been accessed in >6 months. The audit-memory skill should never trigger hard-delete — it only moves data between Tier 1 (Active) and Tier 2 (Superseded), where it remains recoverable via `asOf` temporal queries. The two tools for this:

| Tool | Use when | What happens to original | What gets created |
|------|----------|------------------------|-------------------|
| `supersede_observations` | Replacing with BETTER content (corrected fact, consolidated summary) | Retired to Tier 2 | New Active observation with real content |
| `delete_observations` | Removing noise with nothing worth replacing it | Retired to Tier 2 | Nothing — no new Active observation |

**Critical rule:** `supersede_observations` must ALWAYS have real, useful `newContent`. Never write tombstone markers like `[superseded: ...]` as replacement content. If there's nothing useful to write as a replacement, use `delete_observations` instead.

**Incident reference:** On 2026-04-13, a corpus cleanup used `supersede_observations` with `[superseded: derivable from ...]` as newContent for 640 observations. This created 640 active tombstone markers that clogged `get_summary`, hiding real observations behind noise. The originals were safely in Tier 2, but the tombstone replacements became the problem. Fixed by retiring the tombstones with `delete_observations`.

## What NOT to do

- Do not delete entities, even if all their observations are noise. Deprioritize instead.
- Do not skip entities just because they look unfamiliar — investigate them.
- Do not invent file content — if you can't read the file, skip and report it.
- Do not run on files outside the target project unless the user explicitly asks.
- Do not leave any observation at the default (importance 3, memoryType null, contextLayer null) — every observation must have a deliberate classification.

## Output format

```
Memory audit complete (project: <name>)
- Entities checked: N
- Observations superseded: M
- Observations reclassified: R
- Observations deprioritized (noise): D
- Entities verified clean: K
- Manual review needed: <list, if any>
```
