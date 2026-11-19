import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTIFICATION_TYPES } from '../notifications/notification-metadata';
import { enumThrough, NOTIFICATION_TYPE_ADDITIONS } from './enum-history';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

describe('migration 045 (mentions)', () => {
  const file = read('../../../../data/migrations/045_add_mentions.sql');
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));
  const types = enumThrough(
    NOTIFICATION_TYPES,
    NOTIFICATION_TYPE_ADDITIONS,
    '045',
  );
  const rest =
    'ALTER TABLE user_preferences ADD COLUMN notify_mentions BOOLEAN NOT NULL DEFAULT TRUE; ' +
    'CREATE INDEX idx_users_display_name ON users (display_name);';

  it('appends mention, adds the preference and the display-name index, nothing else', () => {
    expect(migration).toBe(
      `ALTER TABLE notifications MODIFY COLUMN type ENUM( ${enumList(types)} ) NOT NULL; ${rest}`,
    );
    expect(types.at(-1)).toBe('mention');
  });

  // The enum member is folded into CREATE TABLE notifications, as for
  // 042-044; the other statements are appended under the header.
  it('is in the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `type ENUM( ${enumList(NOTIFICATION_TYPES)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      `-- Mentions (045_add_mentions). -- Its notification type is in CREATE TABLE notifications above. ${rest}`,
    );
    expect(snapshot).toMatch(
      /\('044_add_admin_community_ownership'\), \('045_add_mentions'\)[,;]/,
    );
  });

  // Default on, as the other notification preferences: no account stops
  // hearing about mentions by the migration.
  it('defaults the preference on', () => {
    expect(migration).toContain(
      'notify_mentions BOOLEAN NOT NULL DEFAULT TRUE',
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
