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
 * Steps (numbers match the inline Step comments below):
 *   1. trim whitespace (throw if empty after trim)
 *   2. NFC unicode normalize (so 'café' written two different ways collapses)
 *   3. strip Unicode Format (Cf) characters (zero-width space, ZWNJ, ZWJ, BOM,
 *      soft hyphen, word joiner, ...) so invisible copy-paste artifacts can't
 *      create visually-identical-but-distinct identity keys (Issue #59)
 *   4. lowercase
 *   5. strip separator characters: C0 control chars, whitespace, hyphen,
 *      underscore, slash, dot, backslash, colon
 *   6. throw if empty after stripping
 *
 * Examples:
 *   'Dustin-Space'    -> 'dustinspace'
 *   'dustin_space'    -> 'dustinspace'
 *   'Dustin Space'    -> 'dustinspace'
 *   'phase-b-task-3'  -> 'phasebtask3'
 *   'a/b\\c.d:e'      -> 'abcde'
 *   'foo\u200Bbar'    -> 'foobar'   (zero-width space stripped)
 *   '日本語'          -> '日本語'   (no separators or case to fold)
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

  // Step 2: NFC unicode normalize.
  // NFC ensures characters that have multiple byte representations
  // (e.g. precomposed 'é' vs 'e' + combining acute) collapse to one.
  const nfc = trimmed.normalize('NFC');

  // Step 3: strip Unicode Format (Cf) characters.
  // Cf covers invisible formatting code points -- zero-width space (U+200B),
  // ZWNJ (U+200C), ZWJ (U+200D), BOM / zero-width no-break space (U+FEFF),
  // soft hyphen (U+00AD), word joiner (U+2060), and others. They render as
  // nothing, so text copied from the web, Slack, or PDFs can carry a stray one
  // and turn 'foo' into a visually-identical-but-DISTINCT identity key --
  // silently creating duplicate entities (Issue #59). Stripping the whole
  // category collapses those back to one key.
  //
  // Why a SEPARATE .replace with the /u flag (rather than folding Cf into the
  // separator class below): a Unicode property escape (\p{Cf}) REQUIRES the /u
  // flag, but the separator-class regex has no /u flag and must not gain one --
  // /u changes escape semantics (e.g. how \-, \. are parsed), so adding it
  // there would be a behavioral change to a load-bearing, well-tested class.
  // Keeping this as its own /u-flagged pass leaves that class byte-identical.
  //
  // Why AFTER NFC and BEFORE lowercasing: NFC is a fixed normalization that
  // never emits Cf characters, so running it first gives the strip a
  // deterministic input; doing it before .toLowerCase() means case folding
  // sees a Cf-free string and can't interact with a format character.
  const deformatted = nfc.replace(/\p{Cf}/gu, '');

  // Step 4: lowercase.
  // .toLowerCase() handles ASCII case folding; for non-ASCII it does
  // best-effort -- good enough for the variants we actually see.
  const folded = deformatted.toLowerCase();

  // Step 5: strip the separator class.
  // Characters stripped: C0 control chars (\u0000-\u001f), whitespace (\s),
  // hyphen (-), underscore (_), forward slash (/), dot (.), backslash (\\), colon (:).
  // Using a regex character class with the global flag means every
  // run of separators is removed in one pass.
  //
  // Why \u0000-\u001f explicitly (it is NOT redundant with \s): JS \s matches only the
  // whitespace C0 chars (\t \n \v \f \r) plus space and some Unicode spaces -- it does
  // NOT match \x00-\x08 or \x0e-\x1f. We strip the WHOLE C0 range because a stored
  // normalized_name is used as an identity key delimited by char(31) (0x1f) inside
  // getConnectedContext's recursive-CTE path / cycle guard. A name containing 0x1f would
  // split a path mid-name and corrupt cycle detection, so stripping all C0 controls here
  // guarantees the delimiter can never collide with name content.
  const stripped = folded.replace(/[\s\u0000-\u001f\-_/.\\:]+/g, '');

  // Step 6: ensure something is left after stripping. A name like
  // '---' or '   ' would normalize to empty here -- reject it.
  if (stripped.length === 0) {
    throw new Error('Entity name has no content after normalization');
  }

  return stripped;
}
