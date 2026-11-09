import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_TARGETS,
} from '../admin/audit-log.service';
import { checkTriggerRule, checkTriggerSql } from './check-trigger-rules';
import { removeTriggerRules } from './sql-script';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

// The admin_actions enums as migration 004 created them.
const ORIGINAL_ACTIONS = [
  'report_status_changed',
  'user_suspended',
  'user_banned',
  'restriction_lifted',
  'user_role_changed',
];
const ORIGINAL_TARGETS = ['user', 'report', 'restriction'];
// What migration 025 appended. Later migrations append further members, so
// 025's own MODIFY is pinned to its list, not to the current ADMIN_ACTIONS.
const ACTIONS_ADDED_BY_025 = [
  'community_suspended',
  'community_restored',
  'community_updated',
];
const ACTIONS_AFTER_025 = [...ORIGINAL_ACTIONS, ...ACTIONS_ADDED_BY_025];

describe('migration 025 (community suspension)', () => {
  const migration = read(
    '../../../../data/migrations/025_add_community_suspension.sql',
  );
  const rule = checkTriggerRule('chk_communities_suspension');
  // The statements besides the trigger pair, which check-trigger-rules.spec
  // compares with its rendering.
  const sql = normalise(
    removeTriggerRules(migration, rule.name).replace(/^--.*$/gm, ''),
  );
  const snapshot = read('../../../../data/community.sql');
  const normalisedSnapshot = normalise(snapshot);

  it('adds the columns, foreign key, trigger pair, index and enum members, and nothing else', () => {
    expect(migration.replace(/\r\n/g, '\n')).toContain(checkTriggerSql(rule));
    expect(sql).toBe(
      'ALTER TABLE communities ' +
        'ADD COLUMN suspended_at TIMESTAMP NULL DEFAULT NULL, ' +
        'ADD COLUMN suspended_by VARCHAR(36) NULL, ' +
        'ADD COLUMN suspension_reason TEXT NULL, ' +
        'ADD CONSTRAINT fk_communities_suspended_by FOREIGN KEY (suspended_by) REFERENCES users(id) ON DELETE SET NULL; ' +
        'CREATE INDEX idx_communities_suspended_at ON communities (suspended_at); ' +
        'ALTER TABLE admin_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(ACTIONS_AFTER_025)} ) NOT NULL, ` +
        `MODIFY COLUMN target_type ENUM(${enumList(ADMIN_ACTION_TARGETS)}) NOT NULL;`,
    );
  });

  it('only appends to both enums, so every stored value keeps its meaning', () => {
    expect(ADMIN_ACTIONS.slice(0, ORIGINAL_ACTIONS.length)).toEqual(
      ORIGINAL_ACTIONS,
    );
    expect(
      ADMIN_ACTIONS.slice(ORIGINAL_ACTIONS.length, ACTIONS_AFTER_025.length),
    ).toEqual(ACTIONS_ADDED_BY_025);
    expect(ADMIN_ACTION_TARGETS).toEqual([...ORIGINAL_TARGETS, 'community']);
    const original = read(
      '../../../../data/migrations/004_create_admin_actions.sql',
    );
    expect(normalise(original)).toContain(
      `action ENUM( ${enumList(ORIGINAL_ACTIONS)} ) NOT NULL`,
    );
  });

  it('states re-run safety, how to inspect partial state, and the enum rule', () => {
    expect(migration).toMatch(
      /Not safely re-runnable after partial application/,
    );
    expect(migration).toMatch(/inspect in statement order/);
    expect(migration).toMatch(/SHOW CREATE TABLE communities/);
    expect(migration).toMatch(/SHOW INDEX FROM communities/);
    expect(migration).toMatch(/SHOW CREATE TABLE admin_actions/);
    expect(migration).toMatch(
      /members may only ever be APPENDED, never reordered or removed/,
    );
    expect(migration).toMatch(/deliberately no\s+-- expiry column/);
  });

  it('is mirrored in the snapshot, with both final definitions and the version', () => {
    const communities = normalise(
      /CREATE TABLE communities \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    for (const fragment of [
      'suspended_at TIMESTAMP NULL DEFAULT NULL',
      'suspended_by VARCHAR(36) NULL',
      'suspension_reason TEXT NULL',
      'CONSTRAINT fk_communities_suspended_by FOREIGN KEY (suspended_by) REFERENCES users(id) ON DELETE SET NULL',
    ]) {
      expect(communities).toContain(fragment);
    }
    expect(communities).not.toContain('chk_communities_suspension');
    expect(snapshot.replace(/\r\n/g, '\n')).toContain(checkTriggerSql(rule));
    expect(snapshot).toContain(
      'CREATE INDEX idx_communities_suspended_at ON communities (suspended_at);',
    );

    const adminActions = normalise(
      /CREATE TABLE admin_actions \(([\s\S]*?)\n\);/.exec(snapshot)?.[1] ?? '',
    );
    expect(adminActions).toContain(
      `action ENUM( ${enumList(ADMIN_ACTIONS)} ) NOT NULL`,
    );
    expect(adminActions).toContain(
      `target_type ENUM(${enumList(ADMIN_ACTION_TARGETS)}) NOT NULL`,
    );
    expect(normalisedSnapshot).toContain(
      "('024_add_community_subscriptions_community_index'), ('025_add_community_suspension')",
    );
  });
});
