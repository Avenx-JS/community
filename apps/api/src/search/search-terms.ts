// Turns a user's q into the string bound to MATCH ... AGAINST (? IN BOOLEAN
// MODE). Boolean mode treats + - > < ( ) ~ * " @ as syntax: a required or
// excluded word, a relevance change, a group, a wildcard, a phrase, a
// proximity search. Left in, they change what a query means, can make it a
// syntax error, and @distance or wildcards can make it expensive. So q is
// never passed through: only runs of letters, digits and underscores survive,
// which is a whitelist, not a list of operators to strip, and cannot miss one.
// The surviving words are joined by spaces, which in boolean mode means "any
// of these words", ranked by how many match and how often.

// innodb_ft_min_token_size defaults to 3: shorter words are not in the index,
// so they could only ever match nothing.
export const SEARCH_MIN_WORD_LENGTH = 3;
// Each word is a separate index lookup; a cap bounds the cost of one request.
export const SEARCH_MAX_WORDS = 10;

const WORD = /[\p{L}\p{N}_]+/gu;

export function fullTextWords(q: string): string[] {
  const words = (q.match(WORD) ?? []).filter(
    (word) => [...word].length >= SEARCH_MIN_WORD_LENGTH,
  );
  return [...new Set(words.map((word) => word.toLowerCase()))].slice(
    0,
    SEARCH_MAX_WORDS,
  );
}

// The value bound to AGAINST: plain words, no operator can remain.
export function booleanModeTerms(q: string): string {
  return fullTextWords(q).join(' ');
}
