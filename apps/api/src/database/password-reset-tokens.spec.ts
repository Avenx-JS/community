import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const TABLE =
  'CREATE TABLE password_reset_tokens ( ' +
  'token_hash CHAR(64) PRIMARY KEY, ' +
  'user_id VARCHAR(36) NOT NULL, ' +
  'expires_at TIMESTAMP NOT NULL, ' +
  'used_at TIMESTAMP NULL, ' +
  'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
  'INDEX idx_password_reset_tokens_user_id (user_id), ' +
  'INDEX idx_password_reset_tokens_expires_at (expires_at), ' +
  'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE );';

describe('migration 029 (password reset tokens)', () => {
  const migration = read(
    '../../../../data/migrations/029_create_password_reset_tokens.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const header = migration
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .join(' ');
  const snapshot = normalise(read('../../../../data/community.sql'));

  it('creates the table with its key, both indexes and the cascade, and nothing else', () => {
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
      "('028_create_user_blocks'), ('029_create_password_reset_tokens')",
    );
  });
});
