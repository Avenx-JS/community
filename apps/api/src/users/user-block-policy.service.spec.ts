import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { AdminCommunitiesService } from '../admin/admin-communities.service';
import { AdminReportsService } from '../admin/admin-reports.service';
import { AdminRestrictionsService } from '../admin/admin-restrictions.service';
import { AdminUsersService } from '../admin/admin-users.service';
import { CommentLocksService } from '../comments/comment-locks.service';
import { CommentRemovalService } from '../comments/comment-removals.service';
import { CommentsService } from '../comments/comments.service';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityBansService } from '../communities/community-bans.service';
import { PostsService } from '../posts/posts.service';
import { ReportsService } from '../reports/reports.service';
import { SearchService } from '../search/search.service';
import { VotesService } from '../votes/votes.service';
import { UserActivityService } from './user-activity.service';
import {
  BLOCKED_BETWEEN_SQL,
  USER_BLOCKED_REASON,
  UserBlockPolicyService,
  eitherBlockedSql,
} from './user-block-policy.service';

describe('UserBlockPolicyService', () => {
  let calls: Array<{ sql: string; values: unknown[] }>;
  let blocks: Set<string>;
  let service: UserBlockPolicyService;

  const executor = (log: typeof calls) => ({
    execute: (sql: string, values: unknown[]) => {
      log.push({ sql, values });
      const [a, b, c, d] = values as string[];
      const blocked = blocks.has(`${a}:${b}`) || blocks.has(`${c}:${d}`);
      return Promise.resolve([[{ blocked: blocked ? 1 : 0 }], []]);
    },
  });

  beforeEach(() => {
    calls = [];
    blocks = new Set();
    service = new UserBlockPolicyService(executor(calls) as unknown as Pool);
  });

  it('is true in both directions and false otherwise', async () => {
    expect(await service.isBlockedBetween('a', 'b')).toBe(false);
    blocks.add('a:b');
    expect(await service.isBlockedBetween('a', 'b')).toBe(true);
    expect(await service.isBlockedBetween('b', 'a')).toBe(true);
    blocks.clear();
    blocks.add('b:a');
    expect(await service.isBlockedBetween('a', 'b')).toBe(true);
    expect(await service.isBlockedBetween('a', 'c')).toBe(false);
  });

  it('binds both directions in one statement', async () => {
    await service.isBlockedBetween('actor', 'other');
    expect(calls).toEqual([
      {
        sql: BLOCKED_BETWEEN_SQL,
        values: ['actor', 'other', 'other', 'actor'],
      },
    ]);
  });

  // Two direct probes, one per index, rather than one EXISTS with an OR.
  it('reads each direction through its own index-shaped probe', () => {
    expect(eitherBlockedSql('x', 'y').replace(/\s+/g, ' ')).toBe(
      '(EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = x AND blocked_id = y) OR EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = y AND blocked_id = x))',
    );
  });

  it('needs no query for oneself', async () => {
    expect(await service.isBlockedBetween('a', 'a')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('runs on the connection it is given, as the rule gate does', async () => {
    const own: typeof calls = [];
    await service.assertNotBlockedOrThrow('a', 'b', executor(own) as never);
    expect(own).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  // The single most important property: the refusal never says who blocked
  // whom, and names no one.
  it('refuses with the same payload whichever way the block runs', async () => {
    const refusal = async () => {
      try {
        await service.assertNotBlockedOrThrow('a', 'b');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        return JSON.stringify((error as ForbiddenException).getResponse());
      }
      throw new Error('not refused');
    };
    blocks.add('a:b');
    const forward = await refusal();
    blocks.clear();
    blocks.add('b:a');
    const backward = await refusal();
    expect(forward).toBe(backward);
    expect(JSON.parse(forward)).toEqual({ reason: USER_BLOCKED_REASON });
    expect(forward).not.toMatch(/"a"|"b"|blocker|blocked_by|direction/);
  });

  it('passes silently when nothing is blocked', async () => {
    await expect(
      service.assertNotBlockedOrThrow('a', 'b'),
    ).resolves.toBeUndefined();
  });
});

// The risk is over-enforcement. These services must not even be able to
// consult a block: reporting (the safety mechanism), posting and membership
// (shared spaces), every moderation path (or a user could block their way out
// of moderation), search and the shared reads, and /admin.
describe('who may consult a block', () => {
  const dependsOnPolicy = (
    target: abstract new (...args: never[]) => unknown,
  ) =>
    (
      (Reflect.getMetadata('design:paramtypes', target) as
        unknown[] | undefined) ?? []
    ).includes(UserBlockPolicyService);

  it.each([
    ['ReportsService', ReportsService],
    ['PostsService (posting, removal, locking, pinning)', PostsService],
    [
      'CommunitiesService (subscribe, membership, moderators)',
      CommunitiesService,
    ],
    ['CommunityBansService (bans, member removal)', CommunityBansService],
    ['CommentRemovalService', CommentRemovalService],
    ['CommentLocksService', CommentLocksService],
    ['SearchService', SearchService],
    ['AdminReportsService', AdminReportsService],
    ['AdminRestrictionsService', AdminRestrictionsService],
    ['AdminUsersService', AdminUsersService],
    ['AdminCommunitiesService', AdminCommunitiesService],
  ])('%s does not depend on the block policy', (_name, target) => {
    expect(dependsOnPolicy(target)).toBe(false);
  });

  it.each([
    ['CommentsService (comment and reply)', CommentsService],
    ['VotesService (vote)', VotesService],
    ['UserActivityService (profile feeds)', UserActivityService],
  ])('%s does', (_name, target) => {
    expect(dependsOnPolicy(target)).toBe(true);
  });
});
