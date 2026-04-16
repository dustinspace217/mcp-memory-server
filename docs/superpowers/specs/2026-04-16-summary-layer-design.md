# §13: Summary Layer for Context Layers

## Problem

`get_context_layers` returns full observation text for L1 items until the budget runs out.
Items that don't fit silently vanish — the consumer doesn't know what it doesn't know.
This creates a hard ceiling: as more observations get tagged L1 (procedures, project
status, decisions, relational state), useful content gets crowded out with no indication
it exists.

Extending the L1 budget is a linear fix for geometric growth. Content grows with
projects × procedures × decisions × relational observations. Budget extensions delay
the problem but don't solve it.

## Solution: Two-Tier L1 Response

Split `get_context_layers` L1 into two tiers:

| Tier | Content | Budget |
|------|---------|--------|
| **Featured** | Full observation text, most important first | ~3000 tokens (~12000 chars) |
| **Index** | Per-entity breadcrumbs for everything else tagged L1 | ~1000 tokens (~4000 chars) |

The **featured** tier works exactly like current L1 — full text, sorted by importance
DESC, truncated at budget. No behavior change for existing consumers.

The **index** tier is new. For every L1-tagged observation that didn't fit in featured,
group by entity and return a compact entry:

```typescript
interface L1IndexEntry {
  entityName: string;
  entityType: string;
  // Number of L1 observations on this entity that weren't featured
  observationCount: number;
  // Compact hint: summaries or first 100 chars, comma-separated, truncated to 200 chars
  hint: string;
}
```

Example index output:
```json
[
  {"entityName": "dustin-space-procedures", "entityType": "ProcedureLibrary",
   "observationCount": 4, "hint": "dev server, deploy, add gallery image, add guide page"},
  {"entityName": "working-relationship", "entityType": "RelationalState",
   "observationCount": 2, "hint": "trust high, direct/collaborative, tested 2026-04-15..."},
  {"entityName": "session-narratives", "entityType": "ExperientialLog",
   "observationCount": 3, "hint": "2026-04-15 marathon session, 2026-04-16 thinking crisis..."}
]
```

## Schema Changes (v10)

Add `summary` column to observations table:

```sql
ALTER TABLE observations ADD COLUMN summary TEXT DEFAULT NULL;
```

- Nullable. NULL = no explicit summary (use auto-generated fallback).
- Max 200 chars (enforced by Zod at tool boundary, not by DDL).
- Not indexed — read-only, never queried directly.

Purpose: allows manual override of the auto-generated hint for observations where
the first 100 chars don't capture the essence (e.g., timestamped observations where
the first 100 chars are metadata).

## Auto-Summary Generation

When building the index tier, for each observation:
1. If `summary` is non-null → use it
2. Else → take first 100 chars of `content`, append "..." if truncated

Per-entity hint construction:
1. Collect summaries for all L1 observations on this entity that weren't featured
2. Join with ", "
3. Truncate to 200 chars total, append "..." if truncated

This keeps index entries compact (~50-80 chars each) while giving enough context
to decide whether to `open_nodes`.

## API Changes

### get_context_layers response

```typescript
interface ContextLayersResult {
  L0: ContextLayerObservation[];        // unchanged
  L1: ContextLayerObservationWithTime[]; // unchanged (featured tier)
  L1Index?: L1IndexEntry[];             // NEW — present when L1 items were truncated
  tokenEstimate: number;                // includes both featured + index
}
```

`L1Index` is only present when at least one L1 observation was truncated (didn't fit
in featured budget). When all L1 observations fit, `L1Index` is omitted.

### set_observation_metadata

Add optional `summary` field:

```typescript
interface SetObservationMetadataInput {
  entityName: string;
  content: string;
  importance?: number;
  contextLayer?: 'L0' | 'L1' | null;
  memoryType?: string | null;
  summary?: string | null;  // NEW — manual summary override (null clears it)
}
```

Zod constraint: `.max(200)` on summary string.

## Budget Allocation

Total L1 budget: ~4000 tokens (~16000 chars).

Split:
- Featured: ~3000 tokens (~12000 chars) — full text for highest-importance L1 observations
- Index: ~1000 tokens (~4000 chars) — compact breadcrumbs for the rest

The featured budget is enforced the same way as current L1 truncation (character
counting with break on overflow). The index budget uses the same mechanism on the
serialized index entries.

When the index itself overflows, lowest-importance entities are dropped (same
truncation strategy as featured). This is acceptable because the index is a hint
layer — missing an index entry means you don't know about low-importance L1 content,
which is the least costly information to miss.

## Implementation Plan

### 1. Schema migration (v9 → v10)
- Add `summary TEXT DEFAULT NULL` to observations table
- Idempotent: `ALTER TABLE observations ADD COLUMN summary ...` wrapped in
  try-catch (column may already exist)

### 2. Modify getContextLayers() in sqlite-store.ts
- After current L1 truncation loop, collect unfeatured L1 observations
- Group by entity (using entity name + type from a LEFT JOIN)
- Build hint strings using summary ?? first 100 chars
- Apply index budget truncation
- Return as `L1Index` array (only if non-empty)

### 3. Update types.ts
- Add `L1IndexEntry` interface
- Add `L1Index?: L1IndexEntry[]` to `ContextLayersResult`
- Add `summary?: string | null` to `SetObservationMetadataInput`

### 4. Update index.ts
- Add `summary` to `set_observation_metadata` Zod schema (`.max(200).nullable()`)
- Update `get_context_layers` output schema to include `L1Index`
- Update tool description to mention the two-tier behavior

### 5. Update setObservationMetadata() in sqlite-store.ts
- Handle `summary` field alongside existing importance/contextLayer/memoryType updates
- Same `'key in object'` pattern for distinguishing omitted from explicitly null

### 6. Implement in jsonl-store.ts
- Same logic but in-memory (filter, group, build hints)
- `summary` field persisted in JSONL observation lines

### 7. Tests
- `getContextLayers` returns `L1Index` when L1 overflows
- `L1Index` is omitted when all L1 fits in featured
- Index entries have correct entity names, types, observation counts
- Auto-summary uses first 100 chars when no explicit summary
- Explicit summary overrides auto-summary
- Index budget truncation drops lowest-importance entities
- `set_observation_metadata` can set/clear summary
- JSONL backend parity

### 8. Update CLAUDE.md
- Document the two-tier L1 behavior
- Update Known Limitations if needed

## Design Decisions

**Per-entity index (not per-observation):** The index groups by entity because
entity names are often self-describing ("dustin-space-procedures" tells you what's
there). Per-observation indexing would be 3-5x more entries for marginal information
gain.

**Auto-generated fallback (not mandatory summaries):** Requiring summaries on every
observation would create a maintenance burden and block writes. Auto-generation from
first 100 chars works for ~80% of observations. Manual summaries are for the 20%
where the first 100 chars are misleading (timestamps, metadata prefixes).

**Index budget as a fixed slice (not dynamic):** A fixed 1000-token index budget is
simpler than dynamically allocating leftover featured budget to the index. It also
ensures the index always has space even when featured content is dense.

**summary column on observations (not on entities):** Summaries are per-observation
because the same entity can have observations about different topics. An entity-level
summary would lose this granularity.

## Compatibility

- **Backward compatible:** `L1Index` is a new optional field. Existing consumers
  that only read `L0` and `L1` continue to work unchanged.
- **SessionStart hooks:** Should be updated to display the index when present, but
  will function correctly without the update (they just won't see the index).
- **JSONL backend:** Full parity. The summary field is persisted on observation JSONL
  lines (nullable).

## Anti-Bloat Gate

1. **Goal trace:** Serves A (index tells Claude what exists, reducing "I don't know
   what I don't know" drift), B (faithful recall — more content surfaces, even if
   summarized), C (better sessions — targeted retrieval from index hints).
2. **Practical use:** Every session start will display the index. It directly replaces
   the silent truncation that currently hides content.
3. **Cost proportionality:** One new column, ~100 lines of code, ~8 tests. Low
   maintenance burden. The auto-summary fallback means no ongoing write-time cost.
