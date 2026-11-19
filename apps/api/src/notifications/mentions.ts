// @username in a post or comment. The username rules of RegisterDto (3-50
// of [A-Za-z0-9_]); not preceded by a word character or another @, so an
// email address (a@b.example) or @@name is not a mention, and the whole
// name must be matched (@x51-characters-long matches nothing, rather than
// its first 50).
const MENTION = /(?<![\w@])@([a-zA-Z0-9_]{3,50})\b/g;

// A URL is not prose: https://example.com/@name addresses a page.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

// Fenced code blocks (``` or ~~~, at least three, up to three spaces of
// indentation) as Markdown reads them: from the opening fence to a closing
// fence of the same character and at least the same length, or to the end
// of the text when it is never closed.
function withoutFencedCode(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        /^ {0,3}[`~]+\s*$/.test(line)
      ) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// Inline code spans: a run of backticks up to the next run of the same
// length (`code`, ``a ` b``). An unmatched run is literal text.
function withoutInlineCode(text: string): string {
  return text.replace(/(`+)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

// The distinct usernames mentioned in text, in order of first appearance,
// compared case-insensitively (as users.username is unique), at most
// `limit` of them. Mentions in code and in URLs do not count.
export function extractMentions(text: string, limit = Infinity): string[] {
  const prose = withoutInlineCode(withoutFencedCode(text)).replace(URL, ' ');
  const seen = new Set<string>();
  const names: string[] = [];
  for (const [, name] of prose.matchAll(MENTION)) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

// The text a post's mentions are read from: its title and its content.
export function mentionText(
  title: string,
  content: string | null | undefined,
): string {
  return `${title}\n${content ?? ''}`;
}

// The mentions an edit adds: in the new text (within the limit) and not in
// the previous version at all, compared case-insensitively.
export function addedMentions(
  previous: string | null,
  next: string,
  limit: number,
): string[] {
  const before = new Set(
    extractMentions(previous ?? '').map((name) => name.toLowerCase()),
  );
  return extractMentions(next, limit).filter(
    (name) => !before.has(name.toLowerCase()),
  );
}
