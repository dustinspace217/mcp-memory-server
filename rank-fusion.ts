/**
 * rank-fusion.ts — pure ranking math for hybrid search (Phase A/B of the
 * 2026-07-02 retrieval plan; design: spec §4-§5).
 *
 * No DB, no model, no I/O: everything here is unit-testable in Pool 1, the same
 * design rationale as rankAndFloorPrecedents in sqlite-store.ts. The callers
 * (searchNodes relevance mode, and later findPrecedents rerank) assemble ranked
 * candidate lists from SQL/vector queries and delegate the fusion math here.
 */

/**
 * RRF damping constant. 60 is the standard value from the reciprocal-rank-fusion
 * literature (Cormack et al.) and every production system surveyed uses it or
 * close to it. Deliberately NOT configurable: a tunable constant with no
 * measurable in-domain signal to tune against is bloat (YAGNI).
 */
const RRF_K = 60;

/**
 * One ranked candidate list entering the fusion: `ids` in rank order (best
 * first), plus the list's weight. Weights let relevance lists (LIKE, BM25,
 * vector — weight 1.0) count for more than advisory lists (activation — 0.5).
 * Generic over the id type: searchNodes fuses entity rowids (number), while
 * findPrecedents rerank will fuse observation ids.
 */
export interface RankedList<K> {
	weight: number;
	ids: K[];
}

/**
 * Weighted Reciprocal Rank Fusion.
 *
 * Receives: candidate lists (each best-first) with per-list weights.
 * Returns: Map of id → fused score (higher = better). Ids missing from a list
 * simply receive no contribution from it.
 *
 * WHY ranks instead of raw scores: BM25 scores, cosine similarities, recency
 * timestamps, and activation values live on incomparable scales. Score-based
 * fusion would need per-list normalization (fragile, distribution-dependent);
 * rank-based fusion needs none and is robust to outliers. The formula is
 * score(id) = Σ over lists of weight / (RRF_K + rank + 1), rank 0-based.
 *
 * PRECONDITION: ids must be unique WITHIN each list. A duplicated id receives
 * a contribution per occurrence (double-counted). All current callers satisfy
 * this structurally (SELECT DISTINCT / GROUP BY / a first-seen Set) — if a
 * future list can't, dedup it before fusing. Pinned by an exact-value test.
 */
export function fuseRanks<K>(lists: RankedList<K>[]): Map<K, number> {
	const scores = new Map<K, number>();
	for (const list of lists) {
		list.ids.forEach((id, rank) => {
			scores.set(id, (scores.get(id) ?? 0) + list.weight / (RRF_K + rank + 1));
		});
	}
	return scores;
}

/**
 * Sanitize raw user input into an FTS5 MATCH expression.
 *
 * Receives: the raw search string exactly as the caller typed it.
 * Returns: a MATCH expression where every whitespace-delimited token is wrapped
 * in double quotes (embedded quotes doubled, per FTS5's escape convention), so
 * FTS5 query syntax in user input — AND, OR, NOT, NEAR, *, ^, - — is matched
 * as literal text, never executed as operators. User input must NEVER reach
 * MATCH unsanitized: a stray '"' or '(' would throw, and operators would
 * silently change semantics.
 *
 * Multiple quoted tokens joined by space are an implicit AND — deliberate
 * precision bias, because the LIKE candidate list (substring, always runs
 * alongside) provides the recall for partial/looser matches.
 *
 * Tokens containing NO letter or digit (`-`, `&`, `->`, emoji) are DROPPED
 * before quoting: unicode61 tokenizes them to zero tokens, producing an empty
 * phrase. Empirically probed 2026-07-02 (review Discussion #82): the bundled
 * SQLite treats an empty phrase inside an AND chain as a no-op, but a LONE
 * empty phrase matches nothing, and the in-conjunction no-op is undocumented
 * behavior a SQLite upgrade could change (older parsers reportedly throw).
 * Dropping the tokens removes the reliance entirely. The `/[\p{L}\p{N}]/u`
 * test approximates unicode61's default token characters (note `_` is
 * punctuation to unicode61, unlike JS `\w`); mismatches fail safe — a wrongly
 * kept token just matches nothing in a chain the probe showed tolerates it.
 * Order matters: whole tokens are dropped BEFORE quote-doubling — stripping
 * characters after doubling could delete half of a doubled quote pair and
 * reopen the phrase-breakout hole the doubling closes. NUL bytes are stripped
 * first for the same reason (they truncate the MATCH string at a C boundary,
 * leaving an unbalanced quote).
 *
 * Empty/whitespace-only/all-punctuation input returns '""' — a valid FTS5
 * phrase that matches nothing (there is no text signal to search for).
 */
export function toFtsQuery(raw: string): string {
	const tokens = raw
		.replace(/\u0000/g, '')
		.split(/\s+/)
		.filter(t => /[\p{L}\p{N}]/u.test(t));
	if (tokens.length === 0) return '""';
	return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * ACT-R base-level activation, two-parameter approximation:
 *
 *   activation = ln(1 + accessCount) − d · ln(1 + hoursSinceLastAccess)
 *
 * Receives: an entity's access_count and last_accessed_at (both maintained by
 * the touchEntities helpers in sqlite-store.ts), plus the caller's clock in ms
 * (passed in — not read here — so tests are deterministic).
 * Returns: a score where frequently-and-recently-retrieved entities rank
 * higher; -Infinity for never-accessed / sentinel timestamps so callers can
 * rank them last deterministically.
 *
 * WHY this shape: it's the standard approximation of ACT-R's base-level
 * learning equation when per-access timestamps aren't stored (we keep only
 * count + most-recent — storing an access log would grow a table for marginal
 * ranking fidelity; YAGNI). The decay exponent d = 0.5 is ACT-R's canonical
 * default, hardcoded for the same no-signal-to-tune-against reason as RRF_K.
 *
 * Elapsed time clamps at 0: in this multi-instance deployment (several
 * machines share the DB), minor clock skew could otherwise turn a "future"
 * last access into a score boost.
 */
export function activationScore(accessCount: number, lastAccessedAt: string, nowMs: number): number {
	if (accessCount <= 0 || !lastAccessedAt) return -Infinity;
	const last = Date.parse(lastAccessedAt);
	if (Number.isNaN(last)) return -Infinity; // legacy '0000-00-00…' sentinel parses NaN — rank last
	const hours = Math.max(0, (nowMs - last) / 3_600_000);
	return Math.log(1 + accessCount) - 0.5 * Math.log(1 + hours);
}
