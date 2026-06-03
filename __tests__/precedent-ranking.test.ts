// precedent-ranking.test.ts -- Pure-function tests for rankAndFloorPrecedents, the final ranking
// stage of findPrecedents. This deliberately tests the LOGIC around the embedding model WITHOUT
// loading it (per the project's compute-expensive-testing rule): the model produces the raw cosine
// scores; this helper decides the floor, the order, the cap, and the display rounding. Locking it
// here means a future refactor that re-collapses "round-for-display" back into the filter (the
// Finding E boundary leak) fails fast in fast Pool-1, with no ONNX load.

import { describe, it, expect } from 'vitest';
import { rankAndFloorPrecedents } from '../sqlite-store.js';
import type { PrecedentMatch } from '../types.js';

// Build a PrecedentMatch carrying a RAW cosine in `.similarity`. Other fields are filler — the
// helper only reads `.similarity` and passes the rest through (the round happens on a shallow copy).
function match(name: string, rawSimilarity: number): PrecedentMatch {
  return {
    entityName: name,
    observationId: `obs-${name}`,
    content: `content for ${name}`,
    similarity: rawSimilarity,
    importance: 3,
    memoryType: 'decision',
    contextLayer: null,
    createdAt: '2026-06-03T00:00:00.000Z',
  };
}

describe('rankAndFloorPrecedents', () => {
  it('gates the floor on the RAW cosine, not the rounded display value', () => {
    // 0.2496 rounds to 0.250, which would slip past a 0.25 floor under a round-first regression.
    // Gating on raw must EXCLUDE it. 0.2504 is genuinely above the floor and must be KEPT.
    const out = rankAndFloorPrecedents(
      [match('below', 0.2496), match('above', 0.2504)],
      0.25,
      10,
    );
    const names = out.map(p => p.entityName);
    expect(names).toContain('above');     // raw 0.2504 >= 0.25 -> kept
    expect(names).not.toContain('below'); // raw 0.2496 < 0.25 -> excluded (would leak if rounded first)
  });

  it('rounds similarity to 3 decimals for display only', () => {
    const [only] = rankAndFloorPrecedents([match('x', 0.2504)], 0.25, 10);
    expect(only.similarity).toBe(0.25); // 0.2504 -> 0.250, surfaced as 0.25
  });

  it('ranks by RAW cosine DESC even when two scores round to the same 3-decimal value', () => {
    // 0.2521 and 0.2519 both round to 0.252, but their RAW order must be preserved (0.2521 first).
    const out = rankAndFloorPrecedents(
      [match('lower', 0.2519), match('higher', 0.2521)],
      0,
      10,
    );
    expect(out.map(p => p.entityName)).toEqual(['higher', 'lower']);
    // Both display as the same rounded value — proving the ordering came from raw, not display.
    expect(out.map(p => p.similarity)).toEqual([0.252, 0.252]);
  });

  it('caps at limit after filtering and sorting (slice precedes round, so length is exact)', () => {
    const out = rankAndFloorPrecedents(
      [match('a', 0.9), match('b', 0.8), match('c', 0.7), match('d', 0.6)],
      0.5,
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.map(p => p.entityName)).toEqual(['a', 'b']); // top-2 by raw cosine
  });

  it('returns empty when every candidate is below the floor', () => {
    expect(rankAndFloorPrecedents([match('a', 0.1), match('b', 0.2)], 0.5, 10)).toEqual([]);
  });
});
