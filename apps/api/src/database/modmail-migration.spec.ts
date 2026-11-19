import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TYPES,
} from '../notifications/notification-metadata';
import { REPORT_TARGET_TYPES } from '../reports/report.constants';
import {
  enumThrough,
  NOTIFICATION_SUBJECT_TYPE_ADDITIONS,
  NOTIFICATION_TYPE_ADDITIONS,
  REPORT_TARGET_TYPE_ADDITIONS,
} from './enum-history';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

describe('migration 046 (modmail)', () => {
  const file = read('../../../../data/migrations/046_create_modmail.sql');
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));
  const tables = migration.slice(0, migration.indexOf(' ALTER TABLE'));
  const table = (name: string) =>
    new RegExp(`CREATE TABLE ${name} \\((.*?)\\);`).exec(migration)?.[1] ?? '';

  it("creates the two tables with the issue's indexes", () => {
    expect(table('modmail_threads')).toContain(
      'INDEX idx_modmail_threads_community (community_id, status, last_message_at, id)',
    );
    expect(table('modmail_threads')).toContain(
      'INDEX idx_modmail_threads_user (user_id, last_message_at, id)',
    );
    expect(table('modmail_threads')).toContain(
      "status ENUM('open', 'archived') NOT NULL DEFAULT 'open'",
    );
    expect(table('modmail_messages')).toContain(
      'FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(table('modmail_messages')).toContain(
      'is_moderator BOOLEAN NOT NULL',
    );
  });

  it('appends modmail_message to the three enums, last', () => {
    const types = enumThrough(
      NOTIFICATION_TYPES,
      NOTIFICATION_TYPE_ADDITIONS,
      '046',
    );
    const subjects = enumThrough(
      NOTIFICATION_SUBJECT_TYPES,
      NOTIFICATION_SUBJECT_TYPE_ADDITIONS,
      '046',
    );
    const targets = enumThrough(
      REPORT_TARGET_TYPES,
      REPORT_TARGET_TYPE_ADDITIONS,
      '046',
    );
    for (const list of [types, subjects, targets]) {
      expect(list.at(-1)).toBe('modmail_message');
    }
    expect(migration).toContain(
      `ALTER TABLE notifications MODIFY COLUMN type ENUM( ${enumList(types)} ) NOT NULL, ` +
        `MODIFY COLUMN subject_type ENUM(${enumList(subjects)}) NOT NULL;`,
    );
    expect(migration).toContain(
      `ALTER TABLE user_reports MODIFY COLUMN target_type ENUM(${enumList(targets)}) NOT NULL DEFAULT 'user';`,
    );
  });

  // The tables appended under the header, the enum members folded in.
  it('is in the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `-- Modmail (046_create_modmail). -- Its enum members are in CREATE TABLE notifications and user_reports above. ${tables}`,
    );
    expect(snapshot).toContain(
      `subject_type ENUM(${enumList(NOTIFICATION_SUBJECT_TYPES)}) NOT NULL`,
    );
    expect(snapshot).toContain(
      `target_type ENUM(${enumList(REPORT_TARGET_TYPES)}) NOT NULL DEFAULT 'user'`,
    );
    expect(snapshot).toMatch(
      /\('045_add_mentions'\), \('046_create_modmail'\)[,;]/,
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
