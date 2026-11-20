import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_ACTION_TARGETS,
  ADMIN_ACTIONS,
  APPEAL_TARGET_TYPES,
  buildAuditMetadata,
} from '../admin/audit-log.service';
import { APPEAL_STATUSES } from '../appeals/dto/appeals.dto';
import {
  buildNotificationMetadata,
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TYPES,
} from '../notifications/notification-metadata';
import {
  ADMIN_ACTION_ADDITIONS,
  ADMIN_ACTION_TARGET_ADDITIONS,
  appendedBy,
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
  'CREATE TABLE appeals ( ' +
  'id VARCHAR(36) PRIMARY KEY, ' +
  'user_id VARCHAR(36) NOT NULL, ' +
  `target_type ENUM(${enumList(APPEAL_TARGET_TYPES)}) NOT NULL, ` +
  'target_id VARCHAR(36) NOT NULL, ' +
  'reason TEXT NOT NULL, ' +
  'original_actor_id VARCHAR(36) NULL, ' +
  'original_reason TEXT NULL, ' +
  'original_decided_at TIMESTAMP NOT NULL, ' +
  `status ENUM(${enumList(APPEAL_STATUSES)}) NOT NULL DEFAULT 'open', ` +
  'decision_note TEXT NULL, ' +
  'decided_by VARCHAR(36) NULL, ' +
  'decided_at TIMESTAMP NULL, ' +
  'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
  "open_target_id VARCHAR(36) GENERATED ALWAYS AS (CASE WHEN status = 'open' THEN target_id END) STORED, " +
  'UNIQUE KEY uq_appeals_decision (target_type, target_id, original_decided_at), ' +
  'UNIQUE KEY uq_appeals_open_target (target_type, open_target_id), ' +
  'INDEX idx_appeals_queue (status, created_at, id), ' +
  'INDEX idx_appeals_user (user_id, created_at, id), ' +
  'INDEX idx_appeals_original_actor (original_actor_id), ' +
  'INDEX idx_appeals_decided_by (decided_by), ' +
  "CONSTRAINT chk_appeals_decision CHECK ((status = 'open') = (decided_at IS NULL) AND (status = 'open') = (decision_note IS NULL)), " +
  'CONSTRAINT fk_appeals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, ' +
  'CONSTRAINT fk_appeals_original_actor FOREIGN KEY (original_actor_id) REFERENCES users(id) ON DELETE SET NULL, ' +
  'CONSTRAINT fk_appeals_decided_by FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL );';

const VERSION = '048';
const through = {
  actions: enumThrough(ADMIN_ACTIONS, ADMIN_ACTION_ADDITIONS, VERSION),
  targets: enumThrough(
    ADMIN_ACTION_TARGETS,
    ADMIN_ACTION_TARGET_ADDITIONS,
    VERSION,
  ),
  types: enumThrough(NOTIFICATION_TYPES, NOTIFICATION_TYPE_ADDITIONS, VERSION),
  subjects: enumThrough(
    NOTIFICATION_SUBJECT_TYPES,
    NOTIFICATION_SUBJECT_TYPE_ADDITIONS,
    VERSION,
  ),
};

describe('migration 048 (appeals)', () => {
  const file = read('../../../../data/migrations/048_create_appeals.sql');
  const migration = normalise(file.replace(/^--.*$/gm, ''));
  const raw = read('../../../../data/community.sql');
  const snapshot = normalise(raw);

  it('creates the table with its snapshot of the decision, keys, check and foreign keys', () => {
    expect(migration.startsWith(TABLE)).toBe(true);
  });

  // decided_by is SET NULL with the account: MySQL refuses a CHECK on it.
  it('leaves decided_by out of the decision check', () => {
    const check =
      /CONSTRAINT chk_appeals_decision CHECK \((.*?)\), CONSTRAINT/.exec(
        migration,
      )?.[1];
    expect(check).toBeDefined();
    expect(check).not.toContain('decided_by');
  });

  it('appends its members to the admin_actions and notifications enums, last', () => {
    for (const [members, additions] of [
      [through.actions, ADMIN_ACTION_ADDITIONS],
      [through.targets, ADMIN_ACTION_TARGET_ADDITIONS],
      [through.types, NOTIFICATION_TYPE_ADDITIONS],
      [through.subjects, NOTIFICATION_SUBJECT_TYPE_ADDITIONS],
    ] as const) {
      const appended = appendedBy(additions, VERSION);
      expect(appended.length).toBeGreaterThan(0);
      expect(members.slice(-appended.length)).toEqual(appended);
    }
    expect(appendedBy(ADMIN_ACTION_ADDITIONS, VERSION)).toEqual([
      'appeal_approved',
      'appeal_rejected',
    ]);
    expect(migration).toContain(
      'ALTER TABLE admin_actions ' +
        `MODIFY COLUMN action ENUM( ${enumList(through.actions)} ) NOT NULL, ` +
        `MODIFY COLUMN target_type ENUM(${enumList(through.targets)}) NOT NULL;`,
    );
    expect(
      migration.endsWith(
        'ALTER TABLE notifications ' +
          `MODIFY COLUMN type ENUM( ${enumList(through.types)} ) NOT NULL, ` +
          `MODIFY COLUMN subject_type ENUM(${enumList(through.subjects)}) NOT NULL;`,
      ),
    ).toBe(true);
  });

  it('is in the snapshot, with its version recorded', () => {
    expect(snapshot).toContain(
      "-- Appeals of administrators' decisions (048_create_appeals). " +
        `-- Its enum members are in CREATE TABLE admin_actions and notifications above. ${TABLE}`,
    );
    const adminActions =
      /CREATE TABLE admin_actions \((.*?)\);/.exec(snapshot)?.[1] ?? '';
    expect(adminActions).toContain(
      `action ENUM( ${enumList(ADMIN_ACTIONS)} ) NOT NULL`,
    );
    expect(adminActions).toContain(
      `target_type ENUM(${enumList(ADMIN_ACTION_TARGETS)}) NOT NULL`,
    );
    expect(snapshot).toContain(
      `subject_type ENUM(${enumList(NOTIFICATION_SUBJECT_TYPES)}) NOT NULL`,
    );
    expect(snapshot).toMatch(
      /\('047_create_user_follows'\), \('048_create_appeals'\)[,;]/,
    );
  });

  it('is undone by snapshotBefore, leaving the other enums alone', () => {
    const before = snapshotBefore(raw, VERSION);
    expect(before).not.toMatch(/appeal/);
    const normalised = normalise(before);
    expect(normalised).toContain(
      `target_type ENUM(${enumList(enumThrough(ADMIN_ACTION_TARGETS, ADMIN_ACTION_TARGET_ADDITIONS, '047'))}) NOT NULL`,
    );
    expect(normalised).toContain(
      `subject_type ENUM(${enumList(enumThrough(NOTIFICATION_SUBJECT_TYPES, NOTIFICATION_SUBJECT_TYPE_ADDITIONS, '047'))}) NOT NULL`,
    );
    // user_reports.target_type ends differently and is untouched.
    expect(normalised).toContain(
      "target_type ENUM('user', 'post', 'comment', 'community', 'modmail_message') NOT NULL DEFAULT 'user'",
    );
  });

  it('states re-run safety', () => {
    expect(file).toMatch(/Not safely re-runnable after partial application/);
  });
});

describe('appeal metadata allowlists', () => {
  it('keeps the audit entry to the target, the note and whether it reversed', () => {
    expect(
      buildAuditMetadata({
        actorId: 'admin-1',
        action: 'appeal_approved',
        targetType: 'appeal',
        targetId: 'appeal-1',
        metadata: {
          appeal_target_type: 'post_removal',
          appeal_target_id: 'post-1',
          decision_note: 'Restored.',
          reversed: 'true',
          // Not allowlisted: dropped.
          ...({ reason: 'secret' } as object),
        },
      }),
    ).toEqual({
      appeal_target_type: 'post_removal',
      appeal_target_id: 'post-1',
      decision_note: 'Restored.',
      reversed: 'true',
    });
    expect(
      buildAuditMetadata({
        actorId: 'admin-1',
        action: 'appeal_rejected',
        targetType: 'appeal',
        targetId: 'appeal-1',
        metadata: { decision_note: 'Upheld.', reversed: 'true' },
      }),
    ).toEqual({ decision_note: 'Upheld.' });
    expect(() =>
      buildAuditMetadata({
        actorId: 'admin-1',
        action: 'appeal_rejected',
        targetType: 'appeal',
        targetId: 'appeal-1',
        metadata: { decision_note: '   ' },
      }),
    ).toThrow(TypeError);
  });

  it('tells the user the outcome and the note, never the administrator', () => {
    expect(
      buildNotificationMetadata({
        recipientId: 'u-1',
        type: 'appeal_decided',
        actorId: null,
        subjectType: 'appeal',
        subjectId: 'appeal-1',
        communityId: null,
        metadata: {
          status: 'rejected',
          appeal_target_type: 'restriction',
          decision_note: 'n'.repeat(2500),
          ...({ actor_username: 'admin' } as object),
        },
      }),
    ).toEqual({
      status: 'rejected',
      appeal_target_type: 'restriction',
      decision_note: `${'n'.repeat(1999)}…`,
    });
    expect(() =>
      buildNotificationMetadata({
        recipientId: 'u-1',
        type: 'appeal_decided',
        actorId: null,
        subjectType: 'appeal',
        subjectId: 'appeal-1',
        communityId: null,
        metadata: {
          status: 'resolved' as 'approved',
          appeal_target_type: 'restriction',
        },
      }),
    ).toThrow(TypeError);
  });
});
