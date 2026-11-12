import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const TABLE =
  'CREATE TABLE user_blocks ( ' +
  'blocker_id VARCHAR(36) NOT NULL, ' +
  'blocked_id VARCHAR(36) NOT NULL, ' +
  'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
  'PRIMARY KEY (blocker_id, blocked_id), ' +
  'INDEX idx_user_blocks_blocker_created (blocker_id, created_at, blocked_id), ' +
  'INDEX idx_user_blocks_blocked (blocked_id, blocker_id), ' +
  'CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id), ' +
  'FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE, ' +
  'FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE );';

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });

describe('migration 028 (user blocks)', () => {
  const migration = read(
    '../../../../data/migrations/028_create_user_blocks.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const header = migration
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .join(' ');
  const snapshot = normalise(read('../../../../data/community.sql'));

  it('creates the table with its key, both indexes, the check and both cascades, and nothing else', () => {
    expect(sql).toBe(TABLE);
  });

  it('states in its header that it is not safely re-runnable', () => {
    expect(header).toContain(
      'Not safely re-runnable after partial application',
    );
  });

  it('is mirrored in the snapshot, with the version recorded', () => {
    expect(snapshot).toContain(TABLE);
    expect(snapshot.indexOf(TABLE)).toBeGreaterThan(
      snapshot.indexOf('CREATE TABLE users ('),
    );
    expect(snapshot).toContain(
      "('027_create_saved_posts'), ('028_create_user_blocks')",
    );
  });
});

// Every read of user_blocks that changes behaviour goes through the one
// definition in user-block-policy.service.ts. Besides it, only the block list's
// own service and account deletion name the table.
describe('user blocks are read through one definition', () => {
  const root = resolve(__dirname, '..');
  const productionFiles = () =>
    sourceFiles(root).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
    );
  const referencing = (needle: RegExp) =>
    productionFiles()
      .filter((file) => needle.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replace(/\\/g, '/'))
      .sort();

  it('names user_blocks only in its service, account deletion and the policy', () => {
    expect(referencing(/user_blocks/)).toEqual([
      'users/account-deletion.service.ts',
      // The caller's own block list, in their data export.
      'users/data-export.service.ts',
      'users/user-block-policy.service.ts',
      'users/user-blocks.service.ts',
    ]);
  });

  // The gated paths, and nothing else. Reporting, posting, membership, every
  // moderation route, /admin, search and the shared reads must never consult
  // a block: the risk here is over-enforcement, and a block that reached
  // moderation would let a user block their way out of it. Adding a file to
  // this list needs a reason in "Blocking users" in README.md.
  it('uses the policy only on the gated paths', () => {
    expect(
      referencing(
        /UserBlockPolicyService|eitherBlockedSql|BLOCKED_BETWEEN_SQL|notBlockedByViewerSql/,
      ),
    ).toEqual([
      'comments/comments.service.ts',
      'notifications/notification-inbox.service.ts',
      // GET /feed, the caller's own surface (FEED_UNBLOCKED_AUTHOR_SQL).
      'posts/posts.service.ts',
      'users/user-activity.service.ts',
      'users/user-block-policy.module.ts',
      'users/user-block-policy.service.ts',
      'votes/votes.service.ts',
    ]);
  });

  it('never reaches the moderation predicate', () => {
    expect(
      readFileSync(resolve(root, 'common/community-moderation.ts'), 'utf8'),
    ).not.toMatch(/user_blocks|block/i);
  });
});
