import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_ACTIONS } from '../admin/audit-log.service';
import { checkTriggerRule, checkTriggerSql } from './check-trigger-rules';
import { removeTriggerRules } from './sql-script';

const read = (path: string) =>
  readFileSync(resolve(__dirname, path), 'utf8').replace(/\r\n/g, '\n');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

// admin_actions.action as migration 025 left it.
const ACTIONS_BEFORE_031 = [
  'report_status_changed',
  'user_suspended',
  'user_banned',
  'restriction_lifted',
  'user_role_changed',
  'community_suspended',
  'community_restored',
  'community_updated',
];
const ACTIONS_ADDED_BY_031 = ['report_assigned', 'report_unassigned'];

describe('migration 031 (report assignment)', () => {
  const migration = read(
    '../../../../data/migrations/031_add_report_assignment.sql',
  );
  const rule = checkTriggerRule('chk_user_reports_assignment');
  const sql = normalise(
    removeTriggerRules(migration, rule.name).replace(/^--.*$/gm, ''),
  );
  const snapshot = read('../../../../data/community.sql');

  it('adds the columns, foreign key, index, enum members and trigger pair, and nothing else', () => {
    expect(migration).toContain(checkTriggerSql(rule));
    expect(sql).toBe(
      'ALTER TABLE user_reports ' +
        'ADD COLUMN assigned_to VARCHAR(36) NULL, ' +
        'ADD COLUMN assigned_at TIMESTAMP NULL DEFAULT NULL, ' +
        'ADD CONSTRAINT fk_user_reports_assigned_to FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL; ' +
        'CREATE INDEX idx_user_reports_assigned ON user_reports (assigned_to, status, created_at); ' +
        'ALTER TABLE admin_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList([...ACTIONS_BEFORE_031, ...ACTIONS_ADDED_BY_031])} ) NOT NULL;`,
    );
  });

  // A CHECK on assigned_to would be refused (error 3823) because of its ON
  // DELETE SET NULL. The rule also has to tolerate what that SET NULL leaves
  // behind: assigned_at with no assignee.
  it('enforces "no assignee without a timestamp" by trigger, not CHECK', () => {
    expect(migration).not.toMatch(
      /CONSTRAINT chk_user_reports_assignment CHECK/,
    );
    expect(rule.expression).toBe(
      '(NEW.assigned_to IS NULL AND NEW.assigned_at IS NULL) OR NEW.assigned_at IS NOT NULL',
    );
  });

  it('only appends to the action enum, so every stored value keeps its meaning', () => {
    expect(ADMIN_ACTIONS.slice(0, ACTIONS_BEFORE_031.length)).toEqual(
      ACTIONS_BEFORE_031,
    );
    expect(
      ADMIN_ACTIONS.slice(
        ACTIONS_BEFORE_031.length,
        ACTIONS_BEFORE_031.length + ACTIONS_ADDED_BY_031.length,
      ),
    ).toEqual(ACTIONS_ADDED_BY_031);
    expect(
      normalise(
        read('../../../../data/migrations/025_add_community_suspension.sql'),
      ),
    ).toContain(
      `MODIFY COLUMN action ENUM( ${enumList(ACTIONS_BEFORE_031)} ) NOT NULL`,
    );
  });

  it('states re-run safety, how to inspect partial state, and the enum rule', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application/,
    );
    expect(migration).toMatch(/inspect in statement order/);
    expect(migration).toMatch(/SHOW CREATE TABLE user_reports/);
    expect(migration).toMatch(/SHOW INDEX FROM user_reports/);
    expect(migration).toMatch(/SHOW CREATE TABLE admin_actions/);
    expect(migration).toMatch(/SHOW TRIGGERS LIKE 'user_reports'/);
    expect(migration).toMatch(
      /members may only ever be APPENDED, never reordered or removed/,
    );
  });

  it('is mirrored in the snapshot, with the final definitions and the version', () => {
    const reports = normalise(
      /CREATE TABLE user_reports \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    for (const fragment of [
      'assigned_to VARCHAR(36) NULL',
      'assigned_at TIMESTAMP NULL DEFAULT NULL',
      'INDEX idx_user_reports_assigned (assigned_to, status, created_at)',
      'CONSTRAINT fk_user_reports_assigned_to FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL',
    ]) {
      expect(reports).toContain(fragment);
    }
    expect(reports).not.toContain('chk_user_reports_assignment');
    expect(snapshot).toContain(checkTriggerSql(rule));

    const adminActions = normalise(
      /CREATE TABLE admin_actions \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    expect(adminActions).toContain(
      `action ENUM( ${enumList(ADMIN_ACTIONS)} ) NOT NULL`,
    );
    expect(normalise(snapshot)).toContain(
      "('030_add_report_withdrawal'), ('031_add_report_assignment');",
    );
  });
});
