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

// Nothing is enforced yet: the feature must have no effect on any other code
// path. A block is read only by its own service, and written otherwise only by
// account deletion. The enforcement work is expected to change this list.
describe('user blocks do not reach any other behaviour', () => {
  it('leaves user_blocks referenced only by its own service and account deletion', () => {
    const root = resolve(__dirname, '..');
    const references = sourceFiles(root)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('user_blocks'))
      .map((file) => relative(root, file).replace(/\\/g, '/'))
      .sort();
    expect(references).toEqual([
      'users/account-deletion.service.ts',
      'users/user-blocks.service.ts',
    ]);
  });
});
