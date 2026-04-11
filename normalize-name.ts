// normalize-name.ts -- Entity name normalization (Layer 1).
//
// Why this exists:
//   Surface variants of the same conceptual name (case differences,
//   hyphens vs underscores vs spaces, NFC vs NFD unicode forms)
//   would otherwise create distinct entities. That fragments memory:
//   relations split across variants, observations bisected, and
//   `entity_timeline` returns half the truth depending on which
//   variant the caller used. Normalization collapses all of those
//   into a single identity key.
//
// Two consumers:
//   1. sqlite-store.ts -- computes normalized_name on storage so the
//      partial unique index can enforce identity at the schema level.
//   2. index.ts (the MCP tool boundary) -- validates that names are
//      structurally valid (non-empty after normalization) before
//      forwarding to the store, so callers get clean errors.
//
// Display preservation (Option B / hybrid):
//   The original `name` is kept in entities.name for display. Only
//   `normalized_name` is used for identity comparison. First write
//   wins on the display form -- if a caller later submits a different
//   surface variant, the insert is rejected as a collision and the
//   original display form is what subsequent reads return.

/**
 * Normalizes an entity name into its canonical identity key.
 *
 * Steps:
 *   1. trim whitespace
 *   2. throw if empty after trim
 *   3. NFC unicode normalize (so 'café' written two different ways collapses)
 *   4. lowercase
 *   5. strip separator characters: whitespace, hyphen, underscore,
 *      slash, dot, backslash, colon
 *   6. throw if empty after stripping
 *
 * Examples:
 *   'Dustin-Space'   -> 'dustinspace'
 *   'dustin_space'   -> 'dustinspace'
 *   'Dustin Space'   -> 'dustinspace'
 *   'phase-b-task-3' -> 'phasebtask3'
 *   'a/b\\c.d:e'     -> 'abcde'
 *   '日本語'         -> '日本語'   (no separators or case to fold)
 *
 * @param input - The display name as supplied by the caller. May contain
 *                spaces, separators, or mixed case.
 * @returns The normalized identity key. Will never be empty.
 * @throws Error if input is empty after trimming, or if all characters
 *               are separators that strip to nothing.
 */
export function normalizeEntityName(input: string): string {
  // Step 1: trim leading/trailing whitespace.
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Entity name cannot be empty');
  }

  // Step 2: NFC unicode normalize, then lowercase.
  // NFC ensures characters that have multiple byte representations
  // (e.g. precomposed 'é' vs 'e' + combining acute) collapse to one.
  // .toLowerCase() handles ASCII case folding; for non-ASCII it does
  // best-effort -- good enough for the variants we actually see.
  const folded = trimmed.normalize('NFC').toLowerCase();

  // Step 3: strip the separator class.
  // Characters stripped: whitespace (\s), hyphen (-), underscore (_),
  // forward slash (/), dot (.), backslash (\\), colon (:).
  // Using a regex character class with the global flag means every
  // run of separators is removed in one pass.
  const stripped = folded.replace(/[\s\-_/.\\:]+/g, '');

  // Step 4: ensure something is left after stripping. A name like
  // '---' or '   ' would normalize to empty here -- reject it.
  if (stripped.length === 0) {
    throw new Error('Entity name has no content after normalization');
  }

  return stripped;
}
