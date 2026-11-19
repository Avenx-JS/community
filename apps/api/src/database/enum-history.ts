// Which migration appended which members to the enums that keep growing,
// for the migration specs: each spec checks the enum as its own migration
// left it, so a later migration appending a member does not break it. A new
// migration that appends adds one line here, and its own spec checks the
// full constant. Members added before 041 are pinned in their specs.
export type EnumAdditions = ReadonlyArray<
  readonly [version: string, members: readonly string[]]
>;

export const COMMUNITY_MODERATION_ACTION_ADDITIONS: EnumAdditions = [
  ['042', ['ownership_transferred']],
  ['043', ['moderator_left']],
  [
    '044',
    ['admin_owner_changed', 'admin_moderator_added', 'admin_moderator_removed'],
  ],
];

export const NOTIFICATION_TYPE_ADDITIONS: EnumAdditions = [
  ['042', ['community_ownership_transferred']],
  ['043', ['community_moderator_left']],
  [
    '044',
    [
      'community_ownership_assigned',
      'community_ownership_revoked',
      'community_moderator_assigned',
    ],
  ],
  ['045', ['mention']],
];

export const ADMIN_ACTION_ADDITIONS: EnumAdditions = [
  [
    '041',
    ['post_removed', 'post_restored', 'comment_removed', 'comment_restored'],
  ],
  [
    '044',
    [
      'community_owner_changed',
      'community_moderator_added',
      'community_moderator_removed',
    ],
  ],
];

// The enum as it stood once migration `version` had run: the current
// members without those appended by any later migration.
export function enumThrough(
  members: readonly string[],
  additions: EnumAdditions,
  version: string,
): string[] {
  const later = additions
    .filter(([added]) => added > version)
    .flatMap(([, appended]) => appended);
  return members.filter((member) => !later.includes(member));
}

// The members `version` itself appended.
export function appendedBy(
  additions: EnumAdditions,
  version: string,
): readonly string[] {
  return additions.find(([added]) => added === version)?.[1] ?? [];
}

// The migrations whose enum members data/community.sql folds into its
// CREATE TABLE statements, under one appended block that ends at its first
// blank line: only the header for 042-044, the header and its other
// statements for 045.
const FOLDED_MIGRATIONS: ReadonlyArray<
  readonly [version: string, name: string, header: string]
> = [
  [
    '042',
    '042_add_community_ownership_transfer',
    'Community ownership transfer',
  ],
  ['043', '043_add_moderator_step_down', 'A moderator stepping down'],
  [
    '044',
    '044_add_admin_community_ownership',
    'Admin community ownership and moderators',
  ],
  ['045', '045_add_mentions', 'Mentions'],
];

// The snapshot as it stood before migration `version`: for it and every
// later folded migration, its header block, its schema_migrations row and
// the enum members it appended are taken out, so the migration runner can
// apply them again over a database built from the result. Works on LF and
// restores CRLF if the snapshot has it. Names and members are [a-z0-9_]
// only, so they need no escaping in the patterns.
export function snapshotBefore(snapshot: string, version: string): string {
  const crlf = snapshot.includes('\r\n');
  let result = snapshot.replace(/\r\n/g, '\n');
  for (const [added, name, header] of [...FOLDED_MIGRATIONS].reverse()) {
    if (added < version) continue;
    // The header block is comment lines ending at the first blank line.
    const start = result.indexOf(`-- ${header} (${name}).\n`);
    if (start >= 0) {
      const end = result.indexOf('\n\n', start);
      result = result.slice(0, start) + result.slice(end + 2);
    }
    result = result.replace(new RegExp(String.raw`,\n\s*\('${name}'\)`), '');
    const members = [
      COMMUNITY_MODERATION_ACTION_ADDITIONS,
      NOTIFICATION_TYPE_ADDITIONS,
      ADMIN_ACTION_ADDITIONS,
    ].flatMap((additions) => appendedBy(additions, added));
    for (const member of members) {
      result = result.replace(new RegExp(String.raw`,\n\s*'${member}'`), '');
    }
  }
  return crlf ? result.replace(/\n/g, '\r\n') : result;
}
