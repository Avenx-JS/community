import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_ACTIONS, buildAuditMetadata } from '../admin/audit-log.service';
import { COMMUNITY_MODERATION_ACTIONS } from '../communities/community-moderation-log.service';
import {
  MODERATION_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
} from '../notifications/notification-metadata';
import {
  ADMIN_ACTION_ADDITIONS,
  appendedBy,
  COMMUNITY_MODERATION_ACTION_ADDITIONS,
  enumThrough,
  NOTIFICATION_TYPE_ADDITIONS,
} from './enum-history';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const enumList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

const VERSION = '044';
const through = {
  admin: enumThrough(ADMIN_ACTIONS, ADMIN_ACTION_ADDITIONS, VERSION),
  moderation: enumThrough(
    COMMUNITY_MODERATION_ACTIONS,
    COMMUNITY_MODERATION_ACTION_ADDITIONS,
    VERSION,
  ),
  notification: enumThrough(
    NOTIFICATION_TYPES,
    NOTIFICATION_TYPE_ADDITIONS,
    VERSION,
  ),
};

describe('migration 044 (admin community ownership)', () => {
  const file = read(
    '../../../../data/migrations/044_add_admin_community_ownership.sql',
  );
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const snapshot = normalise(read('../../../../data/community.sql'));

  // Ownership stays communities.creator_id: three enums gain members, and
  // nothing else changes.
  it('only appends to the three enums, in the order of the constants', () => {
    expect(migration).toBe(
      'ALTER TABLE admin_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(through.admin)} ) NOT NULL; ` +
        'ALTER TABLE community_moderation_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(through.moderation)} ) NOT NULL; ` +
        'ALTER TABLE notifications ' +
        `MODIFY COLUMN type ENUM( ${enumList(through.notification)} ) NOT NULL;`,
    );
    for (const [members, additions] of [
      [through.admin, ADMIN_ACTION_ADDITIONS],
      [through.moderation, COMMUNITY_MODERATION_ACTION_ADDITIONS],
      [through.notification, NOTIFICATION_TYPE_ADDITIONS],
    ] as const) {
      const appended = appendedBy(additions, VERSION);
      expect(appended).toHaveLength(3);
      expect(members.slice(-3)).toEqual(appended);
    }
  });

  it('is folded into the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      `action ENUM( ${enumList(ADMIN_ACTIONS)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      `action ENUM( ${enumList(COMMUNITY_MODERATION_ACTIONS)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      `type ENUM( ${enumList(NOTIFICATION_TYPES)} ) NOT NULL`,
    );
    expect(snapshot).toContain(
      '-- Admin community ownership and moderators (044_add_admin_community_ownership).',
    );
    // Followed by ';', or by ',' once a later migration is recorded.
    expect(snapshot).toMatch(
      /\('043_add_moderator_step_down'\), \('044_add_admin_community_ownership'\)[,;]/,
    );
  });

  // The administrator is never named to the people affected.
  it('makes the three notification types moderation types', () => {
    for (const type of appendedBy(NOTIFICATION_TYPE_ADDITIONS, VERSION)) {
      expect(MODERATION_NOTIFICATION_TYPES).toContain(type);
    }
  });

  // The audit entry carries the reason and the two usernames, nothing else.
  it('keeps the reason and the usernames in the audit metadata, and drops the rest', () => {
    expect(
      buildAuditMetadata({
        actorId: 'admin',
        action: 'community_owner_changed',
        targetType: 'community',
        targetId: 'k-1',
        metadata: {
          community_name: 'garden',
          username: 'heir',
          previous_owner_username:
            'deleted_6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f',
          reason: 'Owner gone',
          email: 'heir@example.test',
        } as never,
      }),
    ).toEqual({
      community_name: 'garden',
      username: 'heir',
      previous_owner_username: 'deleted_6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f',
      reason: 'Owner gone',
    });
    expect(() =>
      buildAuditMetadata({
        actorId: 'admin',
        action: 'community_moderator_removed',
        targetType: 'community',
        targetId: 'k-1',
        metadata: { reason: '   ' },
      }),
    ).toThrow('Invalid audit metadata field: reason');
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});
