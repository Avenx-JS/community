import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { AdminCommunitiesService } from '../admin/admin-communities.service';
import { AdminRestrictionsService } from '../admin/admin-restrictions.service';
import { CommentLocksService } from '../comments/comment-locks.service';
import { CommentRemovalService } from '../comments/comment-removals.service';
import { CommentsService } from '../comments/comments.service';
import {
  ACTIVE_COMMUNITY_BAN_PREDICATE,
  ACTIVE_COMMUNITY_BAN_STATE_SQL,
} from '../common/active-community-ban';
import { NotificationInboxService } from '../notifications/notification-inbox.service';
import { PostsService } from '../posts/posts.service';
import { ReportsService } from '../reports/reports.service';
import { SearchService } from '../search/search.service';
import { UsersService } from '../users/users.service';
import { VotesService } from '../votes/votes.service';
import { CommunitiesService } from './communities.service';
import {
  COMMUNITY_BANNED_REASON,
  CommunityBanPolicyService,
} from './community-ban-policy.service';
import { CommunityBansService } from './community-bans.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { CommunityRulesService } from './community-rules.service';

describe('CommunityBanPolicyService', () => {
  let calls: Array<{ sql: string; values: unknown[] }>;
  let ban: Record<string, unknown> | undefined;
  let service: CommunityBanPolicyService;

  const executor = (log: typeof calls) => ({
    execute: (sql: string, values: unknown[]) => {
      log.push({ sql, values });
      return Promise.resolve([ban ? [ban] : [], []]);
    },
  });
  const refusal = async () => {
    try {
      await service.assertNotBannedOrThrow('user-1', 'community-1');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      return (error as ForbiddenException).getResponse() as Record<
        string,
        unknown
      >;
    }
    throw new Error('not refused');
  };

  beforeEach(() => {
    calls = [];
    ban = undefined;
    service = new CommunityBanPolicyService(executor(calls) as unknown as Pool);
  });

  it('reads the shared predicate, bound to (community, user)', async () => {
    await service.assertNotBannedOrThrow('user-1', 'community-1');
    expect(calls).toEqual([
      {
        sql: ACTIVE_COMMUNITY_BAN_STATE_SQL,
        values: ['community-1', 'user-1'],
      },
    ]);
    expect(ACTIVE_COMMUNITY_BAN_STATE_SQL).toContain(
      ACTIVE_COMMUNITY_BAN_PREDICATE,
    );
  });

  // Lifted and expired bans fail the predicate in SQL, so they return no row;
  // a lapsed temporary ban needs no job to stop applying.
  it('passes when no active ban exists', async () => {
    await expect(
      service.assertNotBannedOrThrow('user-1', 'community-1'),
    ).resolves.toBeUndefined();
  });

  it('tells a permanently banned user where, and no end', async () => {
    ban = { community_name: 'gardening', expires_at: null };
    expect(await refusal()).toEqual({
      reason: COMMUNITY_BANNED_REASON,
      community: 'gardening',
    });
  });

  it('tells a temporarily banned user when it ends', async () => {
    ban = { community_name: 'gardening', expires_at: '2026-12-01T00:00:00Z' };
    expect(await refusal()).toEqual({
      reason: 'community_banned',
      community: 'gardening',
      expires_at: '2026-12-01T00:00:00.000Z',
    });
  });

  // The moderator's justification, the moderator and the ban id are
  // moderator-facing; the lookup never even selects them.
  it('never discloses the reason, the moderator or the ban id', async () => {
    ban = {
      community_name: 'gardening',
      expires_at: null,
      reason: 'Harassed three members',
      created_by: 'moderator-id',
      id: 'ban-id',
    };
    const body = JSON.stringify(await refusal());
    expect(body).not.toMatch(/Harassed|moderator|ban-id|created_by|"id"/);
    expect(ACTIVE_COMMUNITY_BAN_STATE_SQL).not.toMatch(
      /community_bans\.(reason|created_by|id\b)|\breason\b/,
    );
  });

  it('runs on the connection it is given', async () => {
    const own: typeof calls = [];
    await service.assertNotBannedOrThrow(
      'user-1',
      'community-1',
      executor(own) as never,
    );
    expect(own).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

// The risk is over-enforcement. Services whose every path is exempt must not
// even be able to consult a ban: reporting above all, moderation, platform
// routes (auth, /users/me, notifications, search, /admin) and rule acceptance.
describe('who may consult a community ban', () => {
  const dependsOnPolicy = (
    target: abstract new (...args: never[]) => unknown,
  ) =>
    (
      (Reflect.getMetadata('design:paramtypes', target) as
        unknown[] | undefined) ?? []
    ).includes(CommunityBanPolicyService);

  it.each([
    ['ReportsService', ReportsService],
    [
      'CommunityBansService (bans are managed, not enforced, there)',
      CommunityBansService,
    ],
    ['CommunityRuleAcceptanceService', CommunityRuleAcceptanceService],
    ['CommunityRulesService', CommunityRulesService],
    ['CommentRemovalService', CommentRemovalService],
    ['CommentLocksService', CommentLocksService],
    ['NotificationInboxService', NotificationInboxService],
    ['SearchService', SearchService],
    ['UsersService', UsersService],
    ['AdminRestrictionsService', AdminRestrictionsService],
    ['AdminCommunitiesService', AdminCommunitiesService],
  ])('%s does not depend on the ban policy', (_name, target) => {
    expect(dependsOnPolicy(target)).toBe(false);
  });

  // These have exempt methods too (leaving, deleting, reading); the e2e suites
  // assert those never call it.
  it.each([
    ['CommunitiesService (subscribe)', CommunitiesService],
    ['PostsService (create, edit)', PostsService],
    ['CommentsService (create, edit)', CommentsService],
    ['VotesService (vote)', VotesService],
  ])('%s does', (_name, target) => {
    expect(dependsOnPolicy(target)).toBe(true);
  });
});
