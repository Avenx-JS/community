import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const COLUMNS = [
  'display_name VARCHAR(50) NULL DEFAULT NULL',
  'bio VARCHAR(500) NULL DEFAULT NULL',
];

describe('migration 019 (user profile fields)', () => {
  const migration = read(
    '../../../../data/migrations/019_add_user_profile_fields.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const snapshot = read('../../../../data/community.sql');

  it('adds exactly the two nullable columns to users and nothing else', () => {
    expect(sql).toBe(
      `ALTER TABLE users ${COLUMNS.map((column) => `ADD COLUMN ${column}`).join(', ')};`,
    );
  });

  it('states re-run safety and how to inspect partial state', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application; inspect the users table\n-- before completing this migration manually after a DDL failure\./,
    );
  });

  it('is mirrored in the snapshot and records the version', () => {
    const users = normalise(
      /CREATE TABLE users \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    for (const column of COLUMNS) {
      expect(users).toContain(column);
    }
    expect(normalise(snapshot)).toContain(
      "('018_add_content_listing_indexes'), ('019_add_user_profile_fields')",
    );
  });
});
