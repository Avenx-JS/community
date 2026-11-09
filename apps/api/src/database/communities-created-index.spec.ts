import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const INDEX =
  'CREATE INDEX idx_communities_created ON communities (created_at, id);';

describe('migration 033 (communities created index)', () => {
  const migration = read(
    '../../../../data/migrations/033_add_communities_created_index.sql',
  );
  const snapshot = read('../../../../data/community.sql');

  it('creates exactly the one index, in this column order', () => {
    expect(normalise(migration.replace(/^--.*$/gm, ''))).toBe(INDEX);
  });

  it('states re-run safety', () => {
    expect(migration).toMatch(/Not safely re-runnable after success/);
  });

  it('declares the identical index in the snapshot and records the version', () => {
    expect(normalise(snapshot)).toContain(INDEX);
    expect(normalise(snapshot)).toContain(
      "('032_create_community_bans'), ('033_add_communities_created_index')",
    );
  });
});
