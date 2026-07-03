// context-layers.ts -- shared two-tier L1 logic for getContextLayers()
// (spec §13, docs/superpowers/specs/2026-04-16-summary-layer-design.md).
//
// Both storage backends implement getContextLayers; the featured/index budget
// numbers and the index-building rules MUST be one source of truth or the two
// implementations drift apart silently (same rationale as cursor.ts sharing
// the pagination constants). Pure functions + constants only — no DB, no I/O,
// unit-testable in Pool 1.

import type { L1IndexEntry } from './types.js';

// The historical single L1 budget was 16000 chars (~4000 tokens). The v16
// two-tier split keeps the same TOTAL context cost but stops spending it all
// on full text: featured carries the highest-importance observations
// verbatim, and the index buys per-entity breadcrumbs for everything else —
// replacing silent truncation ("you don't know what you don't know") with a
// visible map of what exists. Fixed slice (not dynamic leftover) so the index
// always has room even when featured content is dense.
export const L1_FEATURED_CHAR_BUDGET = 12000;
export const L1_INDEX_CHAR_BUDGET = 4000;

/** How much of an observation's content becomes its auto-hint when no
 *  explicit summary is set. First-100-chars works for ~80% of observations;
 *  the summary column exists for the rest (spec §13 design decisions). */
const AUTO_HINT_CHARS = 100;

/** Cap on a single entity's combined hint string. */
const HINT_MAX_CHARS = 200;

/** One unfeatured L1 observation, as collected by a backend's featured pass.
 *  Rows must arrive in the same importance-DESC order the featured pass
 *  consumed — buildL1Index derives entity ordering from first appearance. */
export interface UnfeaturedL1 {
  entityName: string;
  entityType: string;
  content: string;
  summary: string | null;
}

/**
 * Builds the L1 index tier from the observations that didn't fit the featured
 * budget: groups them by entity (first-seen order — which is max-importance
 * order, since input rows are importance-DESC), builds each entity's compact
 * hint (per-observation summary ?? first-100-chars, comma-joined, capped at
 * HINT_MAX_CHARS), then applies the index budget on the SERIALIZED entry
 * length, dropping lowest-importance (last) entities first. The first entry
 * is always kept even if it alone exceeds the budget — same rule as the
 * featured tier, so a pathological single entry degrades to "over budget"
 * rather than "empty index that looks like nothing was truncated".
 *
 * Returns [] when there is nothing unfeatured; callers OMIT the L1Index field
 * in that case (absence = "L1 is complete", the pre-v16 consumer contract).
 */
export function buildL1Index(unfeatured: UnfeaturedL1[]): L1IndexEntry[] {
  if (unfeatured.length === 0) return [];

  // Group by entity, preserving first-seen order. Map iteration order is
  // insertion order in JS, which is what makes the importance ordering hold.
  const byEntity = new Map<string, { entityType: string; hints: string[]; count: number }>();
  for (const obs of unfeatured) {
    let group = byEntity.get(obs.entityName);
    if (!group) {
      group = { entityType: obs.entityType, hints: [], count: 0 };
      byEntity.set(obs.entityName, group);
    }
    group.count += 1;
    const hint = obs.summary ?? (
      obs.content.length > AUTO_HINT_CHARS
        ? obs.content.slice(0, AUTO_HINT_CHARS) + '...'
        : obs.content
    );
    group.hints.push(hint);
  }

  const entries: L1IndexEntry[] = [];
  let indexChars = 0;
  for (const [entityName, group] of byEntity) {
    let hint = group.hints.join(', ');
    if (hint.length > HINT_MAX_CHARS) {
      hint = hint.slice(0, HINT_MAX_CHARS) + '...';
    }
    const entry: L1IndexEntry = {
      entityName,
      entityType: group.entityType,
      observationCount: group.count,
      hint,
    };
    // Budget on the serialized form — that's what actually lands in the
    // response the consumer's context pays for.
    const cost = JSON.stringify(entry).length;
    if (indexChars + cost > L1_INDEX_CHAR_BUDGET && entries.length > 0) {
      break; // lowest-importance entities (later in iteration) are dropped
    }
    indexChars += cost;
    entries.push(entry);
  }
  return entries;
}

/** Serialized char cost of an index, for the caller's tokenEstimate. */
export function indexCharCost(entries: L1IndexEntry[]): number {
  return entries.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
}
