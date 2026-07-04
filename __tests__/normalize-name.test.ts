// normalize-name.test.ts -- Pure-function tests for the normalizeEntityName helper.
// This is the Layer 1 normalizer that collapses surface variants of entity names
// into a single identity key. See normalize-name.ts for the rules.

import { describe, it, expect } from 'vitest';
import { normalizeEntityName } from '../normalize-name.js';

describe('normalizeEntityName', () => {
  describe('case folding', () => {
    it('lowercases ASCII', () => {
      expect(normalizeEntityName('Foo')).toBe('foo');
      expect(normalizeEntityName('FOO')).toBe('foo');
      expect(normalizeEntityName('foo')).toBe('foo');
    });

    it('lowercases mixed-case names', () => {
      expect(normalizeEntityName('DustinSpace')).toBe('dustinspace');
      expect(normalizeEntityName('CamelCaseEntity')).toBe('camelcaseentity');
    });
  });

  describe('separator stripping', () => {
    it('strips hyphens', () => {
      expect(normalizeEntityName('dustin-space')).toBe('dustinspace');
      expect(normalizeEntityName('phase-b-task-3')).toBe('phasebtask3');
    });

    it('strips C0 control characters (incl. char(31), the traversal path delimiter)', () => {
      // char(31) is the getConnectedContext path/cycle-guard delimiter; a stored normalized_name
      // must never contain it (or the guard misbehaves). \\s does NOT cover the C0 range, so the
      // normalizer strips \\u0000-\\u001f explicitly.
      expect(normalizeEntityName('A\x1FB')).toBe('ab');
      expect(normalizeEntityName('x\x00y')).toBe('xy');
      expect(() => normalizeEntityName('\x1F\x01')).toThrow();
    });

    it('strips underscores', () => {
      expect(normalizeEntityName('dustin_space')).toBe('dustinspace');
      expect(normalizeEntityName('snake_case_name')).toBe('snakecasename');
    });

    it('strips internal whitespace', () => {
      expect(normalizeEntityName('Dustin Space')).toBe('dustinspace');
      expect(normalizeEntityName('Phase B Task 3')).toBe('phasebtask3');
    });

    it('strips dots, slashes, backslashes, colons', () => {
      expect(normalizeEntityName('a.b.c')).toBe('abc');
      expect(normalizeEntityName('a/b/c')).toBe('abc');
      expect(normalizeEntityName('a\\b\\c')).toBe('abc');
      expect(normalizeEntityName('a:b:c')).toBe('abc');
    });

    it('strips mixed separators in one pass', () => {
      // Combines all separator forms in a single name -- the regex
      // character class with the global flag handles them in one sweep.
      expect(normalizeEntityName('a/b\\c.d:e')).toBe('abcde');
      expect(normalizeEntityName('My Project - Task_1.2')).toBe('myprojecttask12');
    });

    it('collapses adjacent separators', () => {
      expect(normalizeEntityName('foo--bar')).toBe('foobar');
      expect(normalizeEntityName('foo___bar')).toBe('foobar');
      expect(normalizeEntityName('foo - _ bar')).toBe('foobar');
    });
  });

  describe('Unicode Format (Cf) character stripping (Issue #59)', () => {
    // Format (Cf) characters render as nothing but are distinct code points.
    // Text pasted from the web, Slack, or PDFs routinely carries a stray one,
    // so 'foo\u200Bbar' and 'foobar' would otherwise become separate identity
    // keys that look identical -- invisible duplicate entities. The normalizer
    // strips the whole Cf category to collapse those back to one key.
    //
    // These tests use \u escape sequences rather than literal invisible
    // characters ON PURPOSE: a literal zero-width char in the source would be
    // unreviewable and an editor could silently strip it -- exactly the class
    // of bug under test.
    it('strips zero-width space (U+200B)', () => {
      expect(normalizeEntityName('foo\u200Bbar')).toBe('foobar');
    });

    it('strips zero-width non-joiner (U+200C)', () => {
      expect(normalizeEntityName('foo\u200Cbar')).toBe('foobar');
    });

    it('strips zero-width joiner (U+200D)', () => {
      expect(normalizeEntityName('foo\u200Dbar')).toBe('foobar');
    });

    it('strips BOM / zero-width no-break space (U+FEFF)', () => {
      expect(normalizeEntityName('foo\uFEFFbar')).toBe('foobar');
    });

    it('strips soft hyphen (U+00AD)', () => {
      expect(normalizeEntityName('foo\u00ADbar')).toBe('foobar');
    });

    it('strips word joiner (U+2060)', () => {
      expect(normalizeEntityName('foo\u2060bar')).toBe('foobar');
    });

    it('strips a mix of Cf characters and separators in one pass', () => {
      // The Cf strip runs before the separator strip, so both are removed
      // regardless of how they interleave.
      expect(normalizeEntityName('Dustin\u200B-\uFEFFSpace')).toBe('dustinspace');
    });

    it('throws when a name is entirely Cf characters', () => {
      // U+200B is NOT ECMAScript whitespace, so it survives String.trim() and
      // reaches the Cf strip non-empty; it empties there, and the existing
      // "no content after normalization" guard rejects it (no new check needed).
      expect(() => normalizeEntityName('\u200B\uFEFF')).toThrow();
    });

    it('still strips char(31) (C0) -- the traversal-delimiter guarantee is unregressed', () => {
      // The Cf strip is ADDITIVE: the separator class still removes the whole
      // C0 control range, so char(31) (the getConnectedContext path delimiter)
      // can never enter a normalized name. Pinned so a future refactor of the
      // strip steps can't silently drop the C0 guarantee.
      expect(normalizeEntityName('A\x1FB')).toBe('ab');
      expect(() => normalizeEntityName('\x1F\x01')).toThrow();
    });
  });

  describe('whitespace trimming', () => {
    it('trims leading and trailing whitespace', () => {
      expect(normalizeEntityName('  foo  ')).toBe('foo');
      expect(normalizeEntityName('\tfoo\n')).toBe('foo');
    });

    it('trims and then strips', () => {
      // Trim removes outer whitespace; the separator strip then
      // removes internal whitespace and any separator characters.
      expect(normalizeEntityName('  dustin-space  ')).toBe('dustinspace');
    });
  });

  describe('NFC unicode normalization', () => {
    it('collapses precomposed and decomposed forms of the same name', () => {
      // 'café' has two byte representations: precomposed (single 'é' codepoint)
      // and decomposed ('e' + combining acute accent). NFC normalization
      // collapses them to the same canonical form before lowercasing.
      const precomposed = 'caf\u00e9';        // 'café' as one codepoint
      const decomposed = 'cafe\u0301';        // 'cafe' + combining acute
      expect(normalizeEntityName(precomposed)).toBe(normalizeEntityName(decomposed));
    });

    it('preserves non-ASCII characters that are not separators or case-foldable', () => {
      // Japanese characters have no case to fold and are not separators,
      // so they pass through unchanged.
      expect(normalizeEntityName('日本語')).toBe('日本語');
    });
  });

  describe('cross-form collapse (the actual point of normalization)', () => {
    it('makes hyphen, underscore, space, and case variants compare equal', () => {
      const variants = [
        'dustin-space',
        'dustin_space',
        'Dustin Space',
        'DUSTIN-SPACE',
        'Dustin_Space',
        'dustin space',
        'DUSTINSPACE',
      ];
      const normalized = variants.map(normalizeEntityName);
      // All variants must collapse to the same identity key.
      const unique = new Set(normalized);
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe('dustinspace');
    });
  });

  describe('error cases', () => {
    it('throws on empty string', () => {
      expect(() => normalizeEntityName('')).toThrow('Entity name cannot be empty');
    });

    it('throws on whitespace-only', () => {
      expect(() => normalizeEntityName('   ')).toThrow('Entity name cannot be empty');
      expect(() => normalizeEntityName('\t\n')).toThrow('Entity name cannot be empty');
    });

    it('throws when only separators remain after stripping', () => {
      // These trim to non-empty but strip to empty -- the second
      // check inside normalizeEntityName catches them.
      expect(() => normalizeEntityName('---')).toThrow('Entity name has no content after normalization');
      expect(() => normalizeEntityName('___')).toThrow('Entity name has no content after normalization');
      expect(() => normalizeEntityName('. . .')).toThrow('Entity name has no content after normalization');
      expect(() => normalizeEntityName('-_/.\\:')).toThrow('Entity name has no content after normalization');
    });
  });

  describe('idempotency', () => {
    it('normalizing an already-normalized name returns the same value', () => {
      // Once a name has been normalized, running it through again
      // is a no-op. This matters for the boundary -> store path
      // where both ends might call normalize on the same value.
      const inputs = ['dustinspace', 'foobar', 'phase3task', 'abc123'];
      for (const input of inputs) {
        expect(normalizeEntityName(input)).toBe(input);
        expect(normalizeEntityName(normalizeEntityName(input))).toBe(input);
      }
    });
  });
});
