import { createHash } from 'node:crypto';

export interface CommunityRuleItem {
  position: number;
  title: string;
  body: string | null;
}

function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

// Serialises rule items exactly as stored, without trimming or other
// normalisation, so the backfill in migration 009 can reproduce it with
// SHA2(). Length prefixes keep the form unambiguous when a body contains
// line breaks. Keep this in sync with "Community rules" in apps/api/README.md.
export function canonicalizeCommunityRules(
  items: readonly CommunityRuleItem[],
): string {
  const ordered = [...items].sort(
    (left, right) => left.position - right.position,
  );

  for (let index = 0; index < ordered.length; index += 1) {
    const { position } = ordered[index];
    if (!Number.isInteger(position) || position < 1) {
      throw new Error(`Invalid rule position: ${position}`);
    }
    if (index > 0 && ordered[index - 1].position === position) {
      throw new Error(`Duplicate rule position: ${position}`);
    }
  }

  return ordered
    .map(
      ({ position, title, body }) =>
        `${position}\n${lengthPrefixed(title)}\n${lengthPrefixed(body ?? '')}`,
    )
    .join('\n');
}

export function hashCommunityRules(
  items: readonly CommunityRuleItem[],
): string {
  return createHash('sha256')
    .update(canonicalizeCommunityRules(items), 'utf8')
    .digest('hex');
}
