import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { COMMUNITY_ROLE_BY_NAME_SQL } from './community-access';
import type { CommunityBanPolicyService } from './community-ban-policy.service';
import {
  CommunityJoinRequestsService,
  DECIDE_JOIN_REQUEST_SQL,
  INSERT_SUBSCRIPTION_SQL,
  IS_MEMBER_SQL,
  JOIN_REQUEST_SQL,
  LOCK_OWN_JOIN_REQUEST_SQL,
  LOCK_PENDING_JOIN_REQUEST_SQL,
  UPSERT_JOIN_REQUEST_SQL,
} from './community-join-requests.service';
import type { CommunityModerationLogService } from './community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL } from '../users/user-preferences.service';

type Answer = unknown[] | { affectedRows: number };

describe('CommunityJoinRequestsService', () => {
  let statements: Array<{ sql: string; values: unknown[] }>;
  let answers: Map<string, Answer>;
  let community: Record<string, unknown>;
  let record: jest.Mock;
  let banned: boolean;
  let service: CommunityJoinRequestsService;

  beforeEach(() => {
    statements = [];
    answers = new Map();
    banned = false;
    community = {
      id: 'c-1',
      name: 'garden',
      creator_id: 'creator',
      visibility: 'private',
      can_moderate: 0,
    };
    const execute = (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith(COMMUNITY_ROLE_BY_NAME_SQL)) {
        return Promise.resolve([[community], []]);
      }
      return Promise.resolve([answers.get(sql) ?? [], []]);
    };
    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
    };
    const pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool;
    record = jest.fn(() => Promise.resolve());
    service = new CommunityJoinRequestsService(
      pool,
      {
        assertAcceptedOrThrow: () => Promise.resolve(),
      } as unknown as CommunityRuleAcceptanceService,
      { record } as unknown as CommunityModerationLogService,
      {
        assertNotBannedOrThrow: () =>
          banned
            ? Promise.reject(new ForbiddenException({ reason: 'banned' }))
            : Promise.resolve(),
      } as unknown as CommunityBanPolicyService,
    );
  });

  const sqls = () => statements.map(({ sql }) => sql);

  describe('create', () => {
    it('stores a pending request with the message', async () => {
      answers.set(JOIN_REQUEST_SQL, [
        {
          status: 'pending',
          message: 'Hi',
          created_at: new Date('2026-11-01T10:00:00Z'),
          decided_at: null,
        },
      ]);

      await expect(
        service.create('garden', 'sam', { message: 'Hi' }),
      ).resolves.toEqual({
        community: 'garden',
        status: 'pending',
        message: 'Hi',
        created_at: '2026-11-01T10:00:00.000Z',
        decided_at: null,
      });
      expect(
        statements.find(({ sql }) => sql === UPSERT_JOIN_REQUEST_SQL)?.values,
      ).toEqual(['c-1', 'sam', 'Hi']);
    });

    it('is 409 for a public community, which is joined directly', async () => {
      community.visibility = 'public';
      await expect(service.create('garden', 'sam', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(sqls()).not.toContain(UPSERT_JOIN_REQUEST_SQL);
    });

    it('is 409 for a member', async () => {
      answers.set(IS_MEMBER_SQL, [{ member: 1 }]);
      await expect(service.create('garden', 'sam', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('is 403 for a banned account, before anything is written', async () => {
      banned = true;
      await expect(service.create('garden', 'sam', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(sqls()).not.toContain(UPSERT_JOIN_REQUEST_SQL);
    });

    it('is 409 while a request is pending, or denied within the window', async () => {
      answers.set(LOCK_OWN_JOIN_REQUEST_SQL, [
        { status: 'pending', retry_blocked: 0 },
      ]);
      await expect(service.create('garden', 'sam', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      answers.set(LOCK_OWN_JOIN_REQUEST_SQL, [
        { status: 'denied', retry_blocked: 1 },
      ]);
      await expect(service.create('garden', 'sam', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(sqls()).not.toContain(UPSERT_JOIN_REQUEST_SQL);
    });

    it('renews a denied request once the window has passed', async () => {
      answers.set(LOCK_OWN_JOIN_REQUEST_SQL, [
        { status: 'denied', retry_blocked: 0 },
      ]);
      answers.set(JOIN_REQUEST_SQL, [
        {
          status: 'pending',
          message: null,
          created_at: new Date(),
          decided_at: null,
        },
      ]);
      await service.create('garden', 'sam', {});
      expect(sqls()).toContain(UPSERT_JOIN_REQUEST_SQL);
      // The window is compared on the database clock, in hours.
      expect(
        statements.find(({ sql }) => sql === LOCK_OWN_JOIN_REQUEST_SQL)?.values,
      ).toEqual([168, 'c-1', 'sam']);
    });
  });

  describe('decisions', () => {
    beforeEach(() => {
      community.can_moderate = 1;
      answers.set(LOCK_PENDING_JOIN_REQUEST_SQL, [
        { user_id: 'sam-id', username: 'sam' },
      ]);
    });

    it('approves: decided, subscribed, default notifications, logged', async () => {
      await service.approve('garden', 'sam', 'mod');

      expect(statements.slice(1)).toEqual([
        { sql: LOCK_PENDING_JOIN_REQUEST_SQL, values: ['c-1', 'sam'] },
        {
          sql: DECIDE_JOIN_REQUEST_SQL,
          values: ['approved', 'mod', 'c-1', 'sam-id'],
        },
        { sql: INSERT_SUBSCRIPTION_SQL, values: ['sam-id', 'c-1'] },
        {
          sql: APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL,
          values: ['sam-id', 'c-1', 'sam-id'],
        },
      ]);
      expect(statements[0].sql).toMatch(/FOR UPDATE$/);
      expect(record).toHaveBeenCalledWith(expect.anything(), {
        actorId: 'mod',
        communityId: 'c-1',
        action: 'join_request_approved',
        targetType: 'user',
        targetId: 'sam-id',
        metadata: { username: 'sam' },
      });
    });

    it('denies: decided and logged, no membership', async () => {
      await service.deny('garden', 'sam', 'mod');

      expect(sqls()).toContain(DECIDE_JOIN_REQUEST_SQL);
      expect(sqls()).not.toContain(INSERT_SUBSCRIPTION_SQL);
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'join_request_denied' }),
      );
    });

    it('refuses an approval for an account banned since asking', async () => {
      banned = true;
      await expect(
        service.approve('garden', 'sam', 'mod'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sqls()).not.toContain(INSERT_SUBSCRIPTION_SQL);
      expect(record).not.toHaveBeenCalled();
    });

    it('is 404 without a pending request', async () => {
      answers.set(LOCK_PENDING_JOIN_REQUEST_SQL, []);
      await expect(service.deny('garden', 'sam', 'mod')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(record).not.toHaveBeenCalled();
    });

    it('is 403 for anyone but the creator and moderators, before reading requests', async () => {
      community.can_moderate = 0;
      await expect(
        service.approve('garden', 'sam', 'sam'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.listPending('garden', 'sam', { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sqls()).not.toContain(LOCK_PENDING_JOIN_REQUEST_SQL);
    });
  });
});
