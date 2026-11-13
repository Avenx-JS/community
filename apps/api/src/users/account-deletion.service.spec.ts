import { beforeEach, describe, expect, it } from '@jest/globals';
import { RELEASE_ACCOUNT_MEDIA_SQL } from '../media/media-sql';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { AuthService } from '../auth/auth.service';
import {
  ANONYMISE_ACCOUNT_SQL,
  AccountDeletionService,
  COMMUNITY_CREATOR_MESSAGE,
  CREATED_COMMUNITY_SQL,
  DELETED_PASSWORD_HASH,
  DELETE_PRIVATE_STATE_SQL,
  LAST_ADMIN_MESSAGE,
  LOCK_ACCOUNT_SQL,
  deletedEmail,
  deletedUsername,
} from './account-deletion.service';
import { ACTIVE_ADMINS_SQL } from './users.service';

const USER_ID = '6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let log: string[];
  let calls: Array<{ sql: string; values: unknown[] }>;
  let account: Record<string, unknown> | undefined;
  let communities: Array<{ id: string }>;
  let admins: Array<{ id: string }>;
  let passwordValid: boolean;
  let failOn: string | undefined;

  beforeEach(() => {
    log = [];
    calls = [];
    account = {
      id: USER_ID,
      password_hash: 'stored-hash',
      deleted_at: null,
    };
    communities = [];
    admins = [{ id: 'another-admin' }];
    passwordValid = true;
    failOn = undefined;

    const connection = {
      beginTransaction: () => {
        log.push('begin');
        return Promise.resolve();
      },
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        log.push(sql);
        if (failOn && sql.startsWith(failOn)) {
          return Promise.reject(new Error('database failure'));
        }
        if (sql === LOCK_ACCOUNT_SQL) {
          return Promise.resolve([account ? [account] : [], []]);
        }
        if (sql === CREATED_COMMUNITY_SQL) {
          return Promise.resolve([communities, []]);
        }
        if (sql === ACTIVE_ADMINS_SQL) {
          return Promise.resolve([admins, []]);
        }
        return Promise.resolve([{ affectedRows: 1 }, []]);
      },
      commit: () => {
        log.push('commit');
        return Promise.resolve();
      },
      rollback: () => {
        log.push('rollback');
        return Promise.resolve();
      },
      release: () => {
        log.push('release');
      },
    };
    const authService = {
      passwordMatches: (password: string, storedHash: string) => {
        log.push(`verify ${password} against ${storedHash}`);
        return Promise.resolve(passwordValid);
      },
      revokeAllSessions: (userId: string, on: PoolConnection) => {
        log.push(
          `revoke ${userId}${on === (connection as unknown) ? ' on tx' : ''}`,
        );
        return Promise.resolve();
      },
      announceSessionsChanged: (userId: string) => {
        log.push(`announce ${userId}`);
      },
    } as unknown as AuthService;

    service = new AccountDeletionService(
      { getConnection: () => Promise.resolve(connection) } as unknown as Pool,
      authService,
    );
  });

  const writes = () =>
    calls.filter(({ sql }) => /^(UPDATE|DELETE|INSERT)/.test(sql));

  it('anonymises, deletes private state and revokes credentials in one transaction', async () => {
    await expect(
      service.deleteOwnAccount(USER_ID, 'correct password'),
    ).resolves.toBeUndefined();

    expect(log).toEqual([
      'begin',
      LOCK_ACCOUNT_SQL,
      'verify correct password against stored-hash',
      CREATED_COMMUNITY_SQL,
      ACTIVE_ADMINS_SQL,
      ANONYMISE_ACCOUNT_SQL,
      ...DELETE_PRIVATE_STATE_SQL,
      `revoke ${USER_ID} on tx`,
      'commit',
      // Live streams of the account end once the deletion is committed.
      `announce ${USER_ID}`,
      'release',
    ]);
    expect(calls[0]).toEqual({ sql: LOCK_ACCOUNT_SQL, values: [USER_ID] });
    expect(LOCK_ACCOUNT_SQL).toMatch(/WHERE id = \? LIMIT 1 FOR UPDATE$/);
    expect(writes()).toEqual([
      {
        sql: ANONYMISE_ACCOUNT_SQL,
        values: [
          `deleted_${USER_ID}`,
          `deleted_${USER_ID}@invalid`,
          'deleted',
          USER_ID,
        ],
      },
      ...DELETE_PRIVATE_STATE_SQL.map((sql) => ({ sql, values: [USER_ID] })),
    ]);
  });

  it('derives non-reversible, unregistrable placeholders from the id', () => {
    expect(deletedUsername(USER_ID)).toBe(`deleted_${USER_ID}`);
    expect(deletedEmail(USER_ID)).toBe(`deleted_${USER_ID}@invalid`);
    // RegisterDto requires /^[a-zA-Z0-9_]+$/ and 3..50 characters: the UUID's
    // hyphens keep the placeholder out of reach of registration.
    expect(deletedUsername(USER_ID)).not.toMatch(/^[a-zA-Z0-9_]+$/);
    expect(deletedUsername(USER_ID).length).toBeLessThanOrEqual(50);
    expect(DELETED_PASSWORD_HASH).toBe('deleted');
  });

  it('clears every identifying column and stamps deleted_at from the database clock', () => {
    for (const assignment of [
      'username = ?',
      'email = ?',
      'password_hash = ?',
      'display_name = NULL',
      'bio = NULL',
      'last_seen_at = NULL',
      'deleted_at = UTC_TIMESTAMP()',
    ]) {
      expect(ANONYMISE_ACCOUNT_SQL).toContain(assignment);
    }
    expect(ANONYMISE_ACCOUNT_SQL).toMatch(/ WHERE id = \?$/);
  });

  it('deletes only private state and never the row or shared records', () => {
    expect(DELETE_PRIVATE_STATE_SQL).toEqual([
      'DELETE FROM community_subscriptions WHERE user_id = ?',
      'DELETE FROM community_notification_preferences WHERE user_id = ?',
      'DELETE FROM notifications WHERE recipient_id = ?',
      'DELETE FROM saved_posts WHERE user_id = ?',
      'DELETE FROM user_blocks WHERE blocker_id = ?',
      'DELETE FROM user_blocks WHERE blocked_id = ?',
      'DELETE FROM password_reset_tokens WHERE user_id = ?',
      // Unassigns, never deletes: the reports themselves are kept.
      'UPDATE user_reports SET assigned_to = NULL, assigned_at = NULL WHERE assigned_to = ?',
      // Account settings (migration 037), an export's copy of the data included.
      'DELETE FROM email_verification_tokens WHERE user_id = ?',
      'DELETE FROM email_changes WHERE user_id = ?',
      'DELETE FROM user_preferences WHERE user_id = ?',
      'DELETE FROM data_exports WHERE user_id = ?',
      // Community settings (migration 038).
      'DELETE FROM community_join_requests WHERE user_id = ?',
      'DELETE FROM community_moderator_invites WHERE user_id = ?',
      'DELETE FROM community_user_flairs WHERE user_id = ?',
      'DELETE FROM community_mutes WHERE user_id = ?',
      // The reader's own view (migration 039).
      'DELETE FROM hidden_posts WHERE user_id = ?',
      'DELETE FROM saved_comments WHERE user_id = ?',
      // Live notifications (migration 040).
      'DELETE FROM push_subscriptions WHERE user_id = ?',
      'DELETE FROM notification_stream_tickets WHERE user_id = ?',
      // Releases, never deletes: the sweep deletes the files (migration 035).
      ...RELEASE_ACCOUNT_MEDIA_SQL,
    ]);
    const statements = [
      LOCK_ACCOUNT_SQL,
      CREATED_COMMUNITY_SQL,
      ANONYMISE_ACCOUNT_SQL,
      ...DELETE_PRIVATE_STATE_SQL,
    ].join('\n');
    expect(statements).not.toMatch(/DELETE FROM users\b/);
    for (const kept of [
      'posts',
      'comments',
      'votes',
      'user_reports',
      'user_restrictions',
      'community_rule_acceptances',
      'community_moderators',
      'communities',
    ]) {
      expect(statements).not.toMatch(new RegExp(`DELETE FROM ${kept}\\b`));
    }
  });

  // The platform keeps an administrator: the last one cannot leave, as it
  // cannot be demoted through the role routes.
  it('refuses the last administrator with 409, writing nothing', async () => {
    admins = [{ id: USER_ID }];

    await expect(
      service.deleteOwnAccount(USER_ID, 'correct password'),
    ).rejects.toThrow(LAST_ADMIN_MESSAGE);
    expect(writes()).toEqual([]);
    expect(log.slice(-3)).toEqual([ACTIVE_ADMINS_SQL, 'rollback', 'release']);
  });

  it('lets an administrator go while another remains', async () => {
    admins = [{ id: 'another-admin' }, { id: USER_ID }];

    await expect(
      service.deleteOwnAccount(USER_ID, 'correct password'),
    ).resolves.toBeUndefined();
    expect(log).toContain('commit');
  });

  it.each([
    ['missing', undefined],
    [
      'already deleted',
      { id: USER_ID, password_hash: 'deleted', deleted_at: new Date() },
    ],
  ])(
    'returns 404 for an account that is %s, verifying nothing',
    async (_case, row) => {
      account = row;

      await expect(
        service.deleteOwnAccount(USER_ID, 'correct password'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(writes()).toEqual([]);
      expect(log).toEqual(['begin', LOCK_ACCOUNT_SQL, 'rollback', 'release']);
    },
  );

  it('returns 401 for a wrong password and writes nothing', async () => {
    passwordValid = false;

    await expect(
      service.deleteOwnAccount(USER_ID, 'wrong password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(writes()).toEqual([]);
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
    expect(log.some((entry) => entry.startsWith('revoke'))).toBe(false);
  });

  it('returns 409 for a community creator and writes nothing', async () => {
    communities = [{ id: 'community-1' }];

    const error = await service
      .deleteOwnAccount(USER_ID, 'correct password')
      .catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(
      COMMUNITY_CREATOR_MESSAGE,
    );
    expect(
      calls.find(({ sql }) => sql === CREATED_COMMUNITY_SQL)?.values,
    ).toEqual([USER_ID]);
    expect(writes()).toEqual([]);
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
  });

  it.each([
    'UPDATE users',
    'DELETE FROM community_subscriptions',
    'DELETE FROM community_notification_preferences',
    'DELETE FROM notifications',
  ])('rolls back and releases when "%s" fails', async (statement) => {
    failOn = statement;

    await expect(
      service.deleteOwnAccount(USER_ID, 'correct password'),
    ).rejects.toThrow('database failure');
    expect(log).not.toContain('commit');
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
  });

  it('rolls back and releases when revocation fails', async () => {
    const failing = new AccountDeletionService(
      {
        getConnection: () =>
          Promise.resolve({
            beginTransaction: () => Promise.resolve(),
            execute: (sql: string) =>
              Promise.resolve([sql === LOCK_ACCOUNT_SQL ? [account] : [], []]),
            commit: () => {
              log.push('commit');
              return Promise.resolve();
            },
            rollback: () => {
              log.push('rollback');
              return Promise.resolve();
            },
            release: () => {
              log.push('release');
            },
          }),
      } as unknown as Pool,
      {
        passwordMatches: () => Promise.resolve(true),
        revokeAllSessions: () => Promise.reject(new Error('revocation failed')),
        announceSessionsChanged: () => undefined,
      } as unknown as AuthService,
    );

    await expect(
      failing.deleteOwnAccount(USER_ID, 'correct password'),
    ).rejects.toThrow('revocation failed');
    expect(log).toEqual(['rollback', 'release']);
  });

  it('releases the connection when the transaction cannot start', async () => {
    const released: boolean[] = [];
    const failing = new AccountDeletionService(
      {
        getConnection: () =>
          Promise.resolve({
            beginTransaction: () => Promise.reject(new Error('no transaction')),
            rollback: () => {
              released.push(false);
              return Promise.resolve();
            },
            release: () => {
              released.push(true);
            },
          }),
      } as unknown as Pool,
      {} as AuthService,
    );

    await expect(
      failing.deleteOwnAccount(USER_ID, 'correct password'),
    ).rejects.toThrow('no transaction');
    expect(released).toEqual([true]);
  });
});
