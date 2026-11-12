import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 037 (account settings)', () => {
  const file = read('../../../../data/migrations/037_add_account_settings.sql');
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));

  it('is in the snapshot verbatim, with its version recorded', () => {
    expect(snapshot).toContain(migration);
    expect(snapshot).toContain(
      "('036_add_community_report_review'), ('037_add_account_settings');",
    );
  });

  // Codes are stored as hashes only, never in clear.
  it('stores codes as SHA-256 hashes', () => {
    expect(migration).toContain('token_hash CHAR(64) PRIMARY KEY');
    expect(migration).toContain('token_hash CHAR(64) NOT NULL');
    expect(migration).not.toMatch(/\btoken VARCHAR|\bcode VARCHAR/);
  });

  // The session list can only show a prefix, because only a prefix exists.
  it('has no column for a full IP address', () => {
    expect(migration).toContain('ADD COLUMN ip_prefix VARCHAR(64) NULL');
    expect(migration).not.toMatch(/\bip_address\b|\bip VARCHAR/);
  });

  it('cascades every new table from users', () => {
    for (const table of [
      'email_verification_tokens',
      'email_changes',
      'user_preferences',
      'data_exports',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TABLE ${table} \\([^;]*REFERENCES users\\(id\\) ON DELETE CASCADE`,
        ),
      );
    }
  });

  it('starts every existing account unverified', () => {
    expect(migration).toContain(
      'ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMP NULL DEFAULT NULL;',
    );
    expect(migration).not.toMatch(/UPDATE users SET email_verified_at/);
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
