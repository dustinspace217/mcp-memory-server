/**
 * pagerank.ts — bounded personalized PageRank over the ACTIVE relation edges
 * (Phase E of the 2026-07-02 retrieval plan; design: spec §9, after HippoRAG 2's
 * hippocampal-index result — query-seeded graph diffusion materially improves
 * multi-hop retrieval).
 *
 * Pure function, no DB: the caller (findPrecedents' rerank path) supplies the
 * edge list and seeds. At this store's scale (~500 active relations) this is
 * milliseconds of plain JS — no sparse-matrix machinery warranted (YAGNI).
 */

/**
 * Default restart probability. Exported so callers that need to decompose a
 * node's final rank into restart-mass vs received-diffusion (findPrecedents'
 * rerank does: an isolated seed's rank is EXACTLY alpha × its normalized seed
 * weight, so subtracting that term isolates the pure graph signal) use the
 * same constant the walk used — a caller-side copy would silently drift.
 */
export const PPR_ALPHA = 0.5;

/**
 * Personalized PageRank with a fixed, small iteration bound.
 *
 * Receives: undirected edges (each [a, b] — DIRECTION IS DELIBERATELY IGNORED:
 * relatedness flows both ways even when the stored verb is directed, e.g. an
 * incident is relevant to the rule it CAUSED and vice versa; PARALLEL edges —
 * the same pair related under several verbs, or both directions stored —
 * duplicate the adjacency entry, implicitly weighting by multiplicity, which
 * is deliberate: a pair connected three ways IS more related), plus seed nodes
 * with weights (e.g. cosine scores — they need not be normalized; they are
 * normalized internally).
 * Returns: Map of node → rank mass. Nodes never reached by diffusion are
 * absent from the map (callers treat absent as zero).
 *
 * Semantics per iteration: every node pushes (1 − alpha) of its current rank
 * to its neighbors, split evenly (degree-normalized); every seed then receives
 * alpha × its normalized seed weight (the "restart" — this is what makes it
 * PERSONALIZED: rank continually re-concentrates around the query's seeds
 * instead of draining toward global hubs).
 *
 * alpha = 0.5 (half the mass restarts each round — strong personalization,
 * appropriate for a rerank signal) and iterations = 3 (diffusion reaches ~3
 * hops, matching get_connected_context's default horizon) are hardcoded — the
 * same no-in-domain-signal-to-tune-against rationale as RRF_K in
 * rank-fusion.ts. The iteration count is the loop's explicit bound (P10 rule 2).
 */
export function personalizedPageRank(
	edges: ReadonlyArray<readonly [string, string]>,
	seeds: ReadonlyMap<string, number>,
	opts: { alpha?: number; iterations?: number } = {},
): Map<string, number> {
	const alpha = opts.alpha ?? PPR_ALPHA;
	const iterations = opts.iterations ?? 3;

	// Adjacency list, undirected. Self-loops are dropped: a node diffusing to
	// itself adds nothing to relatedness and would just trap rank mass.
	const neighbors = new Map<string, string[]>();
	for (const [a, b] of edges) {
		if (a === b) continue;
		let listA = neighbors.get(a);
		if (!listA) {
			listA = [];
			neighbors.set(a, listA);
		}
		listA.push(b);
		let listB = neighbors.get(b);
		if (!listB) {
			listB = [];
			neighbors.set(b, listB);
		}
		listB.push(a);
	}

	// Normalize seed weights into a probability-like distribution so callers
	// can pass raw cosines. Guard against an all-zero/empty seed set.
	const seedTotal = [...seeds.values()].reduce((sum, v) => sum + v, 0) || 1;
	const seedProb = new Map<string, number>();
	for (const [node, weight] of seeds) {
		seedProb.set(node, weight / seedTotal);
	}

	let rank = new Map(seedProb);
	for (let i = 0; i < iterations; i++) {
		const next = new Map<string, number>();
		for (const [node, r] of rank) {
			const ns = neighbors.get(node);
			// Dangling node (no neighbors): its diffusion share vanishes and the
			// restart term below replenishes seeds — deliberate, keeps the math
			// simple; exact mass conservation doesn't matter for a rank signal.
			if (!ns || ns.length === 0) continue;
			const share = ((1 - alpha) * r) / ns.length;
			for (const n of ns) {
				next.set(n, (next.get(n) ?? 0) + share);
			}
		}
		for (const [node, p] of seedProb) {
			next.set(node, (next.get(node) ?? 0) + alpha * p);
		}
		rank = next;
	}
	return rank;
}
