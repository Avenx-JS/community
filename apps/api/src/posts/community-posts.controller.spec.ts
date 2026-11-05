import { beforeEach, describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { LISTED_COMMUNITY_ID_SQL } from '../communities/communities.service';
import { CommunitiesService } from '../communities/communities.service';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CommunityPostsController } from './community-posts.controller';
import { PostsService } from './posts.service';

// The real PostsService and CommunitiesService over one recording pool: the
// route must issue exactly the statements GET /posts?community_id= issues,
// after one name lookup.
describe('CommunityPostsController', () => {
  let queries: Array<{ sql: string; values: unknown[] }>;
  let communityRows: unknown[];
  let controller: CommunityPostsController;
  let posts: PostsService;

  const row = (id: string) => ({
    id,
    title: id,
    content: 'Body',
    type: 'text',
    author_id: 'author',
    community_id: 'community-1',
    created_at: new Date('2026-10-22T08:00:00.000Z'),
    pinned_at: null,
    pinned_by: null,
  });

  beforeEach(() => {
    queries = [];
    communityRows = [{ id: 'community-1' }];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        if (sql === LISTED_COMMUNITY_ID_SQL) {
          return Promise.resolve([communityRows, []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total FROM posts')) {
          return Promise.resolve([[{ total: 7 }], []]);
        }
        return Promise.resolve([[row('p2'), row('p1')], []]);
      },
    } as unknown as Pool;
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );
    controller = new CommunityPostsController(
      new CommunitiesService(
        pool,
        {} as CommunityRuleAcceptanceService,
        {} as CommunityModerationLogService,
      ),
      posts,
    );
  });

  it('resolves the name, then delegates to the shared listing with the resolved id', async () => {
    const result = await controller.findAll('general', { page: 3, limit: 2 });
    const byName = queries.splice(0);

    const direct = await posts.findAll({
      community_id: 'community-1',
      page: 3,
      limit: 2,
    });

    expect(byName[0]).toEqual({
      sql: LISTED_COMMUNITY_ID_SQL,
      values: ['general'],
    });
    // The same statements, with the same values, as the id-filtered listing.
    expect(byName.slice(1)).toEqual(queries);
    expect(result).toEqual(direct);
    expect(byName[1].values).toEqual(['community-1', 2, 4]);
    expect(byName[2].values).toEqual(['community-1']);
  });

  it('floats pins and omits removed posts, as the filtered listing does', async () => {
    await controller.findAll('general', {});
    const [, listing, count] = queries;

    expect(listing.sql).toMatch(
      /ORDER BY \(pinned_at IS NULL\), pinned_at DESC, created_at DESC, id DESC LIMIT \? OFFSET \?$/,
    );
    for (const { sql } of [listing, count]) {
      expect(sql).toContain('WHERE community_id = ?');
      expect(sql).toContain('communities.deleted_at IS NULL');
      expect(sql).toContain('posts.removed_at IS NULL');
    }
    expect(listing.values).toEqual(['community-1', 20, 0]);
  });

  it('returns the shared envelope, including sort', async () => {
    await expect(controller.findAll('general', {})).resolves.toMatchObject({
      page: 1,
      limit: 20,
      total: 7,
      sort: 'new',
      items: [{ id: 'p2' }, { id: 'p1' }],
    });
  });

  it('answers 404 for an unknown, deleted or suspended community without listing', async () => {
    communityRows = [];
    await expect(controller.findAll('gone', {})).rejects.toThrow(
      new NotFoundException('Community not found'),
    );
    expect(queries).toHaveLength(1);
  });
});
