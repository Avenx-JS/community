import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const COLUMNS = [
  'edited_at TIMESTAMP NULL DEFAULT NULL',
  'locked_at TIMESTAMP NULL DEFAULT NULL',
  'locked_by VARCHAR(36) NULL',
  'removed_at TIMESTAMP NULL DEFAULT NULL',
  'removed_by VARCHAR(36) NULL',
  'removal_reason TEXT NULL',
];

const constraints = (table: string) => [
  `CONSTRAINT fk_${table}_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL`,
  `CONSTRAINT fk_${table}_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL`,
  `CONSTRAINT chk_${table}_lock CHECK ((locked_at IS NULL AND locked_by IS NULL) OR locked_at IS NOT NULL)`,
  `CONSTRAINT chk_${table}_removal CHECK ((removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL) OR removed_at IS NOT NULL)`,
];

describe('migration 017 (post and comment content state)', () => {
  const migration = read(
    '../../../../data/migrations/017_add_post_and_comment_content_state.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const snapshot = read('../../../../data/community.sql');

  // The comma-separated clauses of the migration's ALTER TABLE on a table.
  const alterClauses = (table: string) => {
    const body = new RegExp(`ALTER TABLE ${table} (.*?);`).exec(sql)?.[1];
    expect(body).toBeDefined();
    return body!
      .split(/, (?=ADD )/)
      .map((clause) => clause.replace(/^ADD /, ''));
  };

  // The table body in the full-install snapshot.
  const snapshotTable = (table: string) =>
    normalise(
      new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(
        snapshot,
      )?.[1] ?? '',
    );

  it.each(['posts', 'comments'])(
    'adds exactly the six nullable columns and four constraints to %s',
    (table) => {
      expect(alterClauses(table)).toEqual([
        ...COLUMNS.map((column) => `COLUMN ${column}`),
        ...constraints(table),
      ]);
      expect(sql).toContain(
        `CREATE INDEX idx_${table}_removed_at ON ${table} (removed_at);`,
      );
    },
  );

  it('changes nothing else', () => {
    const heads = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => statement.split(' ').slice(0, 3).join(' '));
    expect(heads).toEqual([
      'ALTER TABLE posts',
      'CREATE INDEX idx_posts_removed_at',
      'ALTER TABLE comments',
      'CREATE INDEX idx_comments_removed_at',
    ]);
    // Only additions: no column is modified or dropped.
    expect(sql).not.toMatch(/\b(MODIFY|DROP|CHANGE)\b/);
    // No editor column: only the author edits.
    expect(sql).not.toMatch(/edited_by/);
  });

  it('states re-run safety and how to inspect partial state', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application; inspect the posts and\n-- comments columns, constraints and indexes before completing this migration\n-- manually after a DDL failure\./,
    );
  });

  it.each(['posts', 'comments'])(
    'is mirrored identically in the snapshot for %s',
    (table) => {
      const body = snapshotTable(table);
      for (const column of COLUMNS) {
        expect(body).toContain(`${column},`);
      }
      for (const constraint of constraints(table)) {
        expect(body).toContain(constraint);
      }
      expect(body).toContain(`INDEX idx_${table}_removed_at (removed_at)`);
      expect(body).not.toMatch(/edited_by/);
    },
  );

  it('records the version in the snapshot', () => {
    expect(normalise(snapshot)).toContain(
      "('016_generalise_report_targets'), ('017_add_post_and_comment_content_state');",
    );
  });
});
