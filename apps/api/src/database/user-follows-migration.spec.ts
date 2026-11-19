import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TYPES,
} from '../notifications/notification-metadata';
import {
  enumThrough,
  NOTIFICATION_SUBJECT_TYPE_ADDITIONS,
  NOTIFICATION_TYPE_ADDITIONS,
  snapshotBefore,
} from './enum-history';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

const TABLE =
  'CREATE TABLE user_follows ( ' +
  'follower_id VARCHAR(36) NOT NULL, ' +
  'followee_id VARCHAR(36) NOT NULL, ' +
  'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
  'PRIMARY KEY (follower_id, followee_id), ' +
  'INDEX idx_user_follows_followee (followee_id, created_at, follower_id), ' +
  'INDEX idx_user_follows_follower_created (follower_id, created_at, followee_id), ' +
  'CONSTRAINT chk_user_follows_not_self CHECK (follower_id <> followee_id), ' +
  'FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE, ' +
  'FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE );';
const PREFERENCE =
  'ALTER TABLE user_preferences ADD COLUMN notify_new_followers BOOLEAN NOT NULL DEFAULT TRUE;';

describe('migration 047 (user follows)', () => {
  const file = read('../../../../data/migrations/047_create_user_follows.sql');
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const raw = read('../../../../data/community.sql');
  const snapshot = normalise(raw);

  it('creates the table with its key, both indexes, the check and both cascades', () => {
    expect(migration.startsWith(TABLE)).toBe(true);
  });

  it('appends new_follower and user to the notification enums, last', () => {
    const types = enumThrough(
      NOTIFICATION_TYPES,
      NOTIFICATION_TYPE_ADDITIONS,
      '047',
    );
    const subjects = enumThrough(
      NOTIFICATION_SUBJECT_TYPES,
      NOTIFICATION_SUBJECT_TYPE_ADDITIONS,
      '047',
    );
    expect(types.at(-1)).toBe('new_follower');
    expect(subjects.at(-1)).toBe('user');
    expect(migration).toContain(
      `ALTER TABLE notifications MODIFY COLUMN type ENUM( ${enumList(types)} ) NOT NULL, ` +
        `MODIFY COLUMN subject_type ENUM(${enumList(subjects)}) NOT NULL;`,
    );
  });

  it('adds notify_new_followers, on by default', () => {
    expect(migration.endsWith(PREFERENCE)).toBe(true);
  });

  // The table and the preference appended under the header, the enum
  // members folded in.
  it('is in the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `-- Following users (047_create_user_follows). -- Its enum members are in CREATE TABLE notifications above. ${TABLE} ${PREFERENCE}`,
    );
    expect(snapshot).toContain(
      `subject_type ENUM(${enumList(NOTIFICATION_SUBJECT_TYPES)}) NOT NULL`,
    );
    expect(snapshot).toMatch(
      /\('046_create_modmail'\), \('047_create_user_follows'\)[,;]/,
    );
  });

  it('is undone by snapshotBefore, leaving the other enums alone', () => {
    const before = snapshotBefore(raw, '047');
    expect(before).not.toMatch(
      /user_follows|notify_new_followers|new_follower/,
    );
    expect(normalise(before)).toContain(
      `subject_type ENUM(${enumList(enumThrough(NOTIFICATION_SUBJECT_TYPES, NOTIFICATION_SUBJECT_TYPE_ADDITIONS, '046'))}) NOT NULL`,
    );
    // 'user' stays in every other enum that holds it.
    expect(before).toMatch(/kind ENUM\('post', 'user'\)/);
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
