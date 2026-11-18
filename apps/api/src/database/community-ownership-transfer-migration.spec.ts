import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNITY_MODERATION_ACTIONS } from '../communities/community-moderation-log.service';
import { NOTIFICATION_TYPES } from '../notifications/notification-metadata';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

// The enums as 042 left them: 043 appended one member to each.
const ACTIONS_THROUGH_042 = COMMUNITY_MODERATION_ACTIONS.filter(
  (action) => action !== 'moderator_left',
);
const TYPES_THROUGH_042 = NOTIFICATION_TYPES.filter(
  (type) => type !== 'community_moderator_left',
);

describe('migration 042 (community ownership transfer)', () => {
  const file = read(
    '../../../../data/migrations/042_add_community_ownership_transfer.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));

  // Ownership stays communities.creator_id: two enum members, nothing else.
  it('only appends one member to each enum', () => {
    expect(migration).toBe(
      'ALTER TABLE community_moderation_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(ACTIONS_THROUGH_042)} ) NOT NULL; ` +
        'ALTER TABLE notifications ' +
        `MODIFY COLUMN type ENUM( ${enumList(TYPES_THROUGH_042)} ) NOT NULL;`,
    );
    expect(ACTIONS_THROUGH_042.at(-1)).toBe('ownership_transferred');
    expect(TYPES_THROUGH_042.at(-1)).toBe('community_ownership_transferred');
  });

  // As for 025, 031, 038 and 041, the members are folded into the snapshot's
  // CREATE TABLE statements; the appended block is only its header.
  it('is folded into the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `action ENUM( ${enumList(COMMUNITY_MODERATION_ACTIONS)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      `type ENUM( ${enumList(NOTIFICATION_TYPES)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      '-- Community ownership transfer (042_add_community_ownership_transfer).',
    );
    expect(snapshot).toContain(
      "('041_add_admin_content_and_roles'), ('042_add_community_ownership_transfer'),",
    );
  });

  // A hard delete of a user would cascade through communities.creator_id;
  // accounts are only ever anonymised, which a transfer does not change.
  it('leaves the owner foreign key as it is', () => {
    expect(migration).not.toMatch(/creator_id|FOREIGN KEY|DROP/);
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
