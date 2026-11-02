import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const CONTENT_LISTING_INDEXES = [
  'CREATE INDEX idx_votes_target ON votes (target_type, target_id, value);',
  'CREATE INDEX idx_posts_community_created ON posts (community_id, created_at, id);',
  'CREATE INDEX idx_posts_author_created ON posts (author_id, created_at, id);',
  'CREATE INDEX idx_comments_author_created ON comments (author_id, created_at, id);',
  'CREATE INDEX idx_comments_parent_created ON comments (parent_id, created_at, id);',
  'CREATE INDEX idx_comments_post_created ON comments (post_id, created_at, id);',
];

describe('migration 018 (content listing indexes)', () => {
  const migration = read(
    '../../../../data/migrations/018_add_content_listing_indexes.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const snapshot = read('../../../../data/community.sql');

  it('creates exactly the six indexes, in this column order, and nothing else', () => {
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => `${statement};`);
    expect(statements).toEqual(CONTENT_LISTING_INDEXES);
  });

  it('states re-run safety, how to inspect partial state, and online DDL', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application; inspect which of the\n-- six indexes exist before completing this migration manually\./,
    );
    expect(migration).toMatch(/ALGORITHM=INPLACE, LOCK=NONE/);
    expect(migration).toMatch(/Do not drop the implicit single-column/);
  });

  it('declares the identical indexes in the snapshot, after their tables', () => {
    for (const statement of CONTENT_LISTING_INDEXES) {
      expect(snapshot).toContain(statement);
      const name = /INDEX (\w+)/.exec(statement)![1];
      expect(snapshot).not.toMatch(new RegExp(`^[ \\t]+INDEX ${name} `, 'm'));
      // Declared inside CREATE TABLE, a composite would back the foreign key
      // and MySQL would not create the implicit single-column index.
      const table = /ON (\w+) /.exec(statement)![1];
      expect(snapshot.indexOf(statement)).toBeGreaterThan(
        snapshot.indexOf(`CREATE TABLE ${table} (`),
      );
    }
  });

  it('records the version in the snapshot', () => {
    expect(normalise(snapshot)).toContain(
      "('017_add_post_and_comment_content_state'), ('018_add_content_listing_indexes');",
    );
  });
});
