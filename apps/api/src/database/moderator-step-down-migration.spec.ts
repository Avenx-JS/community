import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNITY_MODERATION_ACTIONS } from '../communities/community-moderation-log.service';
import { NOTIFICATION_TYPES } from '../notifications/notification-metadata';
import {
  COMMUNITY_MODERATION_ACTION_ADDITIONS,
  enumThrough,
  NOTIFICATION_TYPE_ADDITIONS,
} from './enum-history';

// The enums as 043 left them.
const ACTIONS_THROUGH_043 = enumThrough(
  COMMUNITY_MODERATION_ACTIONS,
  COMMUNITY_MODERATION_ACTION_ADDITIONS,
  '043',
);
const TYPES_THROUGH_043 = enumThrough(
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_ADDITIONS,
  '043',
);

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

describe('migration 043 (moderator step-down)', () => {
  const file = read(
    '../../../../data/migrations/043_add_moderator_step_down.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));

  // A distinct action rather than moderator_removed with actor = target:
  // the log reads "left" or "removed" without comparing two columns.
  it('only appends one member to each enum', () => {
    expect(migration).toBe(
      'ALTER TABLE community_moderation_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(ACTIONS_THROUGH_043)} ) NOT NULL; ` +
        'ALTER TABLE notifications ' +
        `MODIFY COLUMN type ENUM( ${enumList(TYPES_THROUGH_043)} ) NOT NULL;`,
    );
    expect(ACTIONS_THROUGH_043.at(-1)).toBe('moderator_left');
    expect(TYPES_THROUGH_043.at(-1)).toBe('community_moderator_left');
  });

  it('is folded into the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `action ENUM( ${enumList(COMMUNITY_MODERATION_ACTIONS)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      `type ENUM( ${enumList(NOTIFICATION_TYPES)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      '-- A moderator stepping down (043_add_moderator_step_down).',
    );
    expect(snapshot).toContain(
      "('042_add_community_ownership_transfer'), ('043_add_moderator_step_down'),",
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
