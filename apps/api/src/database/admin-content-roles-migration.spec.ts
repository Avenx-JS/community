import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_TARGETS,
} from '../admin/audit-log.service';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

describe('migration 041 (admin content and roles)', () => {
  const file = read(
    '../../../../data/migrations/041_add_admin_content_and_roles.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));
  // The admin_actions enums are folded into the snapshot's CREATE TABLE, as
  // for every earlier enum change (025, 031); the rest is appended verbatim.
  const [appended, enums] = migration.split(' ALTER TABLE admin_actions ');

  it('is in the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `-- Admin content removal, role administration and analytics indexes (041_add_admin_content_and_roles). ${appended}`,
    );
    expect(snapshot).toContain(
      "('040_add_live_notifications'), ('041_add_admin_content_and_roles');",
    );
    const adminActions =
      /CREATE TABLE admin_actions \((.*?)\);/.exec(snapshot)?.[1] ?? '';
    expect(adminActions).toContain(
      `action ENUM( ${enumList(ADMIN_ACTIONS)} ) NOT NULL`,
    );
    expect(adminActions).toContain(
      `target_type ENUM(${enumList(ADMIN_ACTION_TARGETS)}) NOT NULL`,
    );
  });

  // Appending keeps every stored value's meaning (see migration 025).
  it('appends the content actions and targets, in the order of the constants', () => {
    expect(ADMIN_ACTIONS.slice(-4)).toEqual([
      'post_removed',
      'post_restored',
      'comment_removed',
      'comment_restored',
    ]);
    expect(ADMIN_ACTION_TARGETS.slice(-2)).toEqual(['post', 'comment']);
    expect(enums).toBe(
      `MODIFY COLUMN action ENUM( ${enumList(ADMIN_ACTIONS)} ) NOT NULL, ` +
        `MODIFY COLUMN target_type ENUM(${enumList(ADMIN_ACTION_TARGETS)}) NOT NULL;`,
    );
  });

  // Existing removals were moderators': the default is right for them.
  it('marks administrator removals, never without a removal', () => {
    for (const table of ['posts', 'comments']) {
      expect(migration).toContain(
        `ALTER TABLE ${table} ADD COLUMN removed_by_admin BOOLEAN NOT NULL DEFAULT FALSE, ` +
          `ADD CONSTRAINT chk_${table}_admin_removal CHECK (removed_by_admin = FALSE OR removed_at IS NOT NULL)`,
      );
    }
    expect(migration).not.toMatch(/UPDATE (posts|comments)/);
  });

  it('indexes what the comment listing and content analytics order and range by', () => {
    expect(migration).toContain(
      'ADD INDEX idx_comments_created (created_at, id)',
    );
    expect(migration).toContain(
      'ALTER TABLE votes ADD INDEX idx_votes_created (created_at);',
    );
  });

  // users.role keeps one role per account: no role table.
  it('needs no role migration', () => {
    expect(migration).not.toMatch(/\busers\b|user_roles/);
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
