import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const INDEX =
  'CREATE INDEX idx_community_subscriptions_community_created ON community_subscriptions (community_id, created_at, user_id);';

describe('migration 024 (community subscriptions index)', () => {
  const migration = read(
    '../../../../data/migrations/024_add_community_subscriptions_community_index.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const snapshot = read('../../../../data/community.sql');

  it('creates exactly the one index, in this column order', () => {
    expect(sql).toBe(INDEX);
  });

  it('states re-run safety and keeps the implicit foreign-key index', () => {
    expect(migration).toMatch(/Not safely re-runnable after success/);
    expect(migration).toMatch(/Do not drop the implicit single-column/);
  });

  it('declares the identical index in the snapshot, after its table', () => {
    const normalisedSnapshot = normalise(snapshot);
    expect(normalisedSnapshot).toContain(INDEX);
    // Declared inside CREATE TABLE, a composite would back the foreign key
    // and MySQL would not create the implicit single-column index.
    expect(normalisedSnapshot.indexOf(INDEX)).toBeGreaterThan(
      normalisedSnapshot.indexOf('CREATE TABLE community_subscriptions ('),
    );
    expect(snapshot).not.toMatch(
      /^[ \t]+INDEX idx_community_subscriptions_community_created /m,
    );
  });

  it('records the version in the snapshot', () => {
    expect(normalise(snapshot)).toContain(
      "('023_add_community_moderation_community_actions'), ('024_add_community_subscriptions_community_index');",
    );
  });
});
