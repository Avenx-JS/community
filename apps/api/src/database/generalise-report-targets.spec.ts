import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkTriggerRule, checkTriggerSql } from './check-trigger-rules';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('migration 016 (generalise report targets)', () => {
  const migration = read(
    '../../../../data/migrations/016_generalise_report_targets.sql',
  );
  const sql = normalise(migration.replace(/^--.*$/gm, ''));
  const position = (fragment: string) => {
    const index = sql.indexOf(fragment);
    expect(index).toBeGreaterThan(-1);
    return index;
  };

  it('adds the target columns before backfilling them, and tightens only afterwards', () => {
    const add = position(
      "ADD COLUMN target_type ENUM('user', 'post', 'comment', 'community') NOT NULL DEFAULT 'user'",
    );
    position('ADD COLUMN target_id VARCHAR(36) NULL');
    position('ADD COLUMN target_author_id VARCHAR(36) NULL');
    position(
      'ADD CONSTRAINT fk_user_reports_target_author FOREIGN KEY (target_author_id) REFERENCES users(id) ON DELETE SET NULL',
    );
    const backfill = position(
      "UPDATE user_reports SET target_type = 'user', target_id = reported_user_id;",
    );
    const tighten = position(
      'MODIFY COLUMN target_id VARCHAR(36) NOT NULL, MODIFY COLUMN reported_user_id VARCHAR(36) NULL;',
    );

    expect(backfill).toBeGreaterThan(add);
    expect(tighten).toBeGreaterThan(backfill);
    // The backfill leaves the evidence pair alone.
    expect(sql).not.toMatch(/SET[^;]*context_(type|id)\s*=/);
  });

  it('replaces the cascading reported_user_id foreign key with SET NULL', () => {
    const drop = position('DROP FOREIGN KEY');
    const tighten = position('MODIFY COLUMN reported_user_id VARCHAR(36) NULL');
    const add = position(
      'ADD CONSTRAINT fk_user_reports_reported_user FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL;',
    );

    expect(tighten).toBeGreaterThan(drop);
    expect(add).toBeGreaterThan(tighten);
  });

  it('indexes target lookups and per-kind statistics', () => {
    position(
      'CREATE INDEX idx_user_reports_target ON user_reports (target_type, target_id, status);',
    );
    position(
      'CREATE INDEX idx_user_reports_target_type_created ON user_reports (target_type, created_at);',
    );
    expect(sql).not.toMatch(/FOREIGN KEY \(target_id\)/);
  });

  it('states re-run safety and the recovery order in its header', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application/,
    );
    expect(migration).toContain(
      'SELECT COUNT(*) FROM user_reports WHERE target_id IS NULL',
    );
    expect(migration).toMatch(/Never run the step 4 MODIFY before this is 0/);
  });

  it('is reflected in the full-install snapshot', () => {
    const snapshot = read('../../../../data/community.sql');
    const table = normalise(
      /CREATE TABLE user_reports \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );

    expect(table).toContain('reported_user_id VARCHAR(36) NULL,');
    expect(table).toContain(
      "target_type ENUM('user', 'post', 'comment', 'community') NOT NULL DEFAULT 'user',",
    );
    expect(table).toContain('target_id VARCHAR(36) NOT NULL,');
    expect(table).toContain('target_author_id VARCHAR(36) NULL,');
    expect(table).toContain(
      'INDEX idx_user_reports_target (target_type, target_id, status)',
    );
    expect(table).toContain(
      'INDEX idx_user_reports_target_type_created (target_type, created_at)',
    );
    expect(table).toContain(
      'CONSTRAINT fk_user_reports_reported_user FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(table).toContain(
      'CONSTRAINT fk_user_reports_target_author FOREIGN KEY (target_author_id) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(table).not.toMatch(/CASCADE/);
    // reporter_id and reported_user_id have referential actions, so MySQL 8
    // refuses the self-report rule as a CHECK; it is a trigger pair.
    expect(table).not.toContain('chk_user_reports_not_self');
    expect(snapshot.replace(/\r\n/g, '\n')).toContain(
      checkTriggerSql(checkTriggerRule('chk_user_reports_not_self')),
    );
    expect(table).toContain('CONSTRAINT chk_user_reports_context CHECK');
    expect(normalise(snapshot)).toContain(
      "('015_add_fulltext_search_indexes'), ('016_generalise_report_targets')",
    );
  });
});
