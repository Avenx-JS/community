import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 020 (user account deletion)', () => {
  const migration = read(
    '../../../../data/migrations/020_add_user_account_deletion.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const snapshot = read('../../../../data/community.sql');

  it('adds only the nullable deleted_at column and its index', () => {
    expect(sql).toBe(
      'ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL; ' +
        'CREATE INDEX idx_users_deleted_at ON users (deleted_at);',
    );
  });

  it('states re-run safety and how to inspect partial state', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application; inspect the users table\n-- and index before completing this migration manually after a DDL failure\./,
    );
  });

  it('is mirrored in the snapshot and records the version', () => {
    const users = normalise(
      /CREATE TABLE users \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    expect(users).toContain('deleted_at TIMESTAMP NULL DEFAULT NULL');
    expect(snapshot).toContain(
      'CREATE INDEX idx_users_deleted_at ON users (deleted_at);',
    );
    expect(normalise(snapshot)).toContain(
      "('019_add_user_profile_fields'), ('020_add_user_account_deletion')",
    );
  });
});
