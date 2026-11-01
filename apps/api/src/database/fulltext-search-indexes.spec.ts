import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const statements = (sql: string) =>
  normalise(sql.replace(/^--.*$/gm, ''))
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

// The search endpoint's MATCH lists must equal these column lists exactly.
const FULLTEXT_INDEXES = [
  'CREATE FULLTEXT INDEX ft_posts_title_content ON posts (title, content)',
  'CREATE FULLTEXT INDEX ft_comments_content ON comments (content)',
  'CREATE FULLTEXT INDEX ft_communities_name_description ON communities (name, description)',
];

describe('migration 015 (full-text search indexes)', () => {
  const migration = read(
    '../../../../data/migrations/015_add_fulltext_search_indexes.sql',
  );

  it('creates exactly the three FULLTEXT indexes and nothing else', () => {
    expect(statements(migration)).toEqual(FULLTEXT_INDEXES);
  });

  it('does not index users, which are matched by username prefix', () => {
    expect(migration).not.toMatch(/ON users\b/);
  });

  it('states re-run safety, partial-state inspection and rebuild cost', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application/,
    );
    expect(migration).toMatch(/inspect which of the\s+-- three indexes exist/);
    expect(migration).toContain("index_type = 'FULLTEXT'");
    expect(migration).toMatch(/FTS_DOC_ID/);
    expect(migration).toMatch(/rebuilds the whole table/);
    expect(migration).toMatch(/online DDL/);
    expect(migration).toMatch(/IN BOOLEAN MODE/);
  });

  it('is reflected identically in the full-install snapshot', () => {
    const snapshot = normalise(read('../../../../data/community.sql'));

    for (const statement of FULLTEXT_INDEXES) {
      expect(snapshot).toContain(`${statement};`);
    }
    expect(snapshot.match(/FULLTEXT/g)).toHaveLength(FULLTEXT_INDEXES.length);
    expect(snapshot).toContain(
      "('014_drop_communities_rules'), ('015_add_fulltext_search_indexes');",
    );
  });
});
