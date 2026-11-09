import { describe, expect, it } from '@jest/globals';
import {
  SEARCH_MAX_WORDS,
  booleanModeTerms,
  fullTextWords,
} from './search-terms';

// Every character MySQL's boolean mode reads as syntax. None may reach AGAINST:
// each would change what the query means, could make it a syntax error, and
// @distance or * can make it expensive.
const OPERATORS = ['+', '-', '>', '<', '(', ')', '~', '*', '"', '@'] as const;

// What may appear in the bound value: lowercase words and single spaces.
const PLAIN = /^(?:[\p{Ll}\p{Lo}\p{N}_]+(?: [\p{Ll}\p{Lo}\p{N}_]+)*)?$/u;

describe('booleanModeTerms', () => {
  describe.each(OPERATORS)('the operator %s', (operator) => {
    it.each([
      `${operator}kitten`,
      `kitten${operator}`,
      `kit${operator}ten`,
      `${operator}${operator}kitten ${operator}puppy${operator}`,
      `kitten ${operator} puppy`,
    ])('is plain text in %j', (q) => {
      const terms = booleanModeTerms(q);
      expect(terms).not.toContain(operator);
      expect(terms).toMatch(PLAIN);
    });

    it('cannot make a word required, excluded, weighted or wildcarded', () => {
      expect(booleanModeTerms(`${operator}kitten`)).toBe('kitten');
      expect(booleanModeTerms(`kitten${operator}`)).toBe('kitten');
    });

    it('splits words it joins, rather than gluing them into one', () => {
      expect(booleanModeTerms(`kitten${operator}puppy`)).toBe('kitten puppy');
    });

    it('leaves nothing searchable when it is all there is', () => {
      expect(booleanModeTerms(operator.repeat(50))).toBe('');
      expect(fullTextWords(operator.repeat(50))).toEqual([]);
    });
  });

  it('neutralises a combined adversarial input', () => {
    const q =
      '+"kitten puppy" -(cat* | dog) @8 ~>weight <low "unterminated ((( *** ' +
      "'; DROP TABLE posts; -- \\ % _x_ ` ";
    const terms = booleanModeTerms(q);
    for (const operator of OPERATORS) {
      expect(terms).not.toContain(operator);
    }
    expect(terms).toMatch(PLAIN);
    expect(terms).toBe(
      // Ten words: the cap, so the trailing _x_ is dropped.
      'kitten puppy cat dog weight low unterminated drop table posts',
    );
  });

  it('treats a proximity search as two plain words', () => {
    // "@8" would mean "within 8 words" after a phrase; 8 is too short to stay.
    expect(booleanModeTerms('"kitten puppy" @8')).toBe('kitten puppy');
    expect(booleanModeTerms('"kitten puppy" @100')).toBe('kitten puppy 100');
  });

  it('turns a term of only operators and punctuation into nothing', () => {
    expect(booleanModeTerms(OPERATORS.join(''))).toBe('');
    expect(booleanModeTerms('+-><()~*"@ +-><()~*"@ ...!?')).toBe('');
  });

  it('drops words shorter than the minimum token size of 3', () => {
    expect(booleanModeTerms('go is C fun')).toBe('fun');
    expect(fullTextWords('go is C')).toEqual([]);
  });

  it('keeps letters and digits of any script, lowercased and deduplicated', () => {
    expect(booleanModeTerms('Café CAFÉ café Straße 東京都 2026')).toBe(
      'café straße 東京都 2026',
    );
  });

  it('caps the number of words, bounding the cost of one query', () => {
    const many = Array.from({ length: 30 }, (_, index) => `word${index}`);
    expect(fullTextWords(many.join(' '))).toHaveLength(SEARCH_MAX_WORDS);
  });

  it('never contains a wildcard, quote or grouping however it is fed', () => {
    for (let code = 0x20; code < 0x7f; code += 1) {
      const character = String.fromCharCode(code);
      const terms = booleanModeTerms(`abc${character}def ${character}ghi`);
      expect([character, terms]).toEqual([
        character,
        expect.stringMatching(PLAIN),
      ]);
    }
  });
});
