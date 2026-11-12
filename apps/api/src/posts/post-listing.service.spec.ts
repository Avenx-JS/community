import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { ACTIVE_COMMUNITY_BAN_PREDICATE } from '../common/active-community-ban';
import {
  NEW_POST_HOT_RANK_SQL,
  NEW_POST_RISING_RANK_SQL,
} from '../common/content-ranking';
import { readableCommunitySql } from '../common/community-visibility';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PostListSort } from './dto/post-listing-query.dto';
import {
  FEED_COMMUNITIES_SQL,
  FEED_UNBLOCKED_AUTHOR_SQL,
  PostsService,
  VISIBLE_POST_SQL,
  POSTING_COMMUNITY_SQL,
} from './posts.service';

// The one listing path behind GET /posts, GET /communities/:name/posts and
// GET /feed: which rows, in which order, and that the order is always a
// persisted column the database sorts by.
function harness() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes('COUNT(*) AS total')) {
      return Promise.resolve([[{ total: 0 }], []]);
    }
    if (sql.includes('FROM community_bans')) {
      return Promise.resolve([[], []]);
    }
    if (sql === POSTING_COMMUNITY_SQL) {
      return Promise.resolve([
        [
          {
            visibility: 'public',
            allowed_post_types: 'text,link,media',
            member: 1,
          },
        ],
        [],
      ]);
    }
    return Promise.resolve([[], []]);
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
  const service = new PostsService(
    pool,
    {
      recordCommunityPost: () =>
        Promise.resolve({ recipients: 0, written: false }),
    } as unknown as NotificationsService,
    {
      assertAcceptedOrThrow: () => Promise.resolve(),
    } as unknown as CommunityRuleAcceptanceService,
    {} as CommunityModerationLogService,
  );
  const listing = () => statements[0];
  const count = () => statements[1];
  return { service, statements, listing, count };
}

const ORDER: Record<PostListSort, string> = {
  new: 'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
  hot: 'ORDER BY hot_rank DESC, id DESC LIMIT ? OFFSET ?',
  top: 'ORDER BY score DESC, id DESC LIMIT ? OFFSET ?',
  rising: 'ORDER BY rising_rank DESC, id DESC LIMIT ? OFFSET ?',
};
const PINS = 'ORDER BY (pinned_at IS NULL), pinned_at DESC, ';

describe('post listings: sort', () => {
  it.each(Object.entries(ORDER))(
    'GET /posts?sort=%s orders by its stored column, id breaking ties',
    async (sort, order) => {
      const { service, listing } = harness();
      const result = await service.findAll({ sort: sort as PostListSort });
      expect(listing().sql).toMatch(new RegExp(`${escape(order)}$`));
      expect(listing().sql).not.toContain('pinned_at IS NULL');
      expect(result.sort).toBe(sort);
    },
  );

  it('defaults to new and echoes it', async () => {
    const { service, listing } = harness();
    const result = await service.findAll({});
    expect(listing().sql).toContain(ORDER.new);
    expect(result).toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      sort: 'new',
    });
  });

  // Pins float on the chronological and hot views of one community, and
  // never falsify a ranking.
  it.each([
    ['new', `${PINS}created_at DESC, id DESC`],
    ['hot', `${PINS}hot_rank DESC, id DESC`],
    ['top', 'ORDER BY score DESC, id DESC'],
    ['rising', 'ORDER BY rising_rank DESC, id DESC'],
  ])("a community's listing with sort=%s orders %s", async (sort, order) => {
    const { service, listing } = harness();
    await service.findAll({
      community_id: 'community-1',
      sort: sort as PostListSort,
    });
    expect(listing().sql).toContain(`${order} LIMIT ? OFFSET ?`);
    expect(listing().values).toEqual(['community-1', null, 20, 0]);
  });
});

describe('post listings: time', () => {
  it.each([
    ['hour', 'INTERVAL 1 HOUR'],
    ['day', 'INTERVAL 1 DAY'],
    ['week', 'INTERVAL 7 DAY'],
    ['month', 'INTERVAL 30 DAY'],
    ['year', 'INTERVAL 365 DAY'],
  ])(
    'sort=top&time=%s ranks posts created within %s, in the listing and its count',
    async (time, interval) => {
      const { service, listing, count } = harness();
      const result = await service.findAll({
        sort: 'top',
        time: time as 'hour',
      });
      const window = `posts.created_at >= CURRENT_TIMESTAMP - ${interval}`;
      expect(listing().sql).toContain(window);
      expect(count().sql).toContain(window);
      expect(result).toMatchObject({ sort: 'top', time });
    },
  );

  it('sort=top defaults to every post and says so', async () => {
    const { service, listing } = harness();
    const result = await service.findAll({ sort: 'top' });
    expect(listing().sql).not.toContain('created_at >=');
    expect(result).toMatchObject({ sort: 'top', time: 'all' });
  });

  it('sort=rising reads the last 24 hours only', async () => {
    const { service, listing, count } = harness();
    const result = await service.findAll({ sort: 'rising' });
    const window = 'posts.created_at >= CURRENT_TIMESTAMP - INTERVAL 24 HOUR';
    expect(listing().sql).toContain(window);
    expect(count().sql).toContain(window);
    expect(result).not.toHaveProperty('time');
  });

  it.each(['new', 'hot', 'rising'] as const)(
    'sort=%s carries no time in its response',
    async (sort) => {
      const { service } = harness();
      expect(await service.findAll({ sort })).not.toHaveProperty('time');
    },
  );
});

describe('GET /feed', () => {
  it("reads the caller's subscriptions, less bans, blocked authors and hidden content", async () => {
    const { service, listing, count } = harness();
    await service.findFeed({ sort: 'hot', page: 3, limit: 10 }, 'user-1');

    // The feed hides nsfw content without the opt-in, and muted communities.
    const where = ` WHERE ${[
      FEED_COMMUNITIES_SQL,
      readableCommunitySql('posts.community_id', { nsfw: true, muted: true }),
      VISIBLE_POST_SQL,
      FEED_UNBLOCKED_AUTHOR_SQL,
    ].join(' AND ')}`;
    expect(listing().sql).toContain(`FROM posts${where} ${ORDER.hot}`);
    expect(listing().values).toEqual(['user-1', 'user-1', 'user-1', 10, 20]);
    expect(count().sql).toBe(`SELECT COUNT(*) AS total FROM posts${where}`);
    expect(count().values).toEqual(['user-1', 'user-1', 'user-1']);
  });

  it('excludes a community the caller is banned from now', () => {
    expect(FEED_COMMUNITIES_SQL).toContain(
      'WHERE community_subscriptions.user_id = ?',
    );
    expect(FEED_COMMUNITIES_SQL).toContain(
      `AND ${ACTIVE_COMMUNITY_BAN_PREDICATE}`,
    );
  });

  // Hiding the posts of someone who blocked the caller would tell them so.
  it('omits authors the caller blocked, in that direction only', () => {
    expect(FEED_UNBLOCKED_AUTHOR_SQL).toBe(
      'NOT EXISTS (SELECT 1 FROM user_blocks WHERE user_blocks.blocker_id = ? AND user_blocks.blocked_id = posts.author_id)',
    );
  });

  it.each(['new', 'hot', 'top', 'rising'] as const)(
    'never floats pins (sort=%s)',
    async (sort) => {
      const { service, listing } = harness();
      await service.findFeed({ sort }, 'user-1');
      expect(listing().sql).toContain(ORDER[sort]);
      expect(listing().sql).not.toContain('pinned_at IS NULL');
    },
  );

  it('takes time with top, like every listing', async () => {
    const { service, listing } = harness();
    const result = await service.findFeed(
      { sort: 'top', time: 'week' },
      'user-1',
    );
    expect(listing().sql).toContain(
      'posts.created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAY',
    );
    expect(result).toMatchObject({ sort: 'top', time: 'week' });
  });
});

describe('post creation', () => {
  it('stores the ranks of a post with score 0, created now', async () => {
    const { service, statements } = harness();
    await service
      .create(
        { title: 't', content: 'c', type: 'text', community_id: 'community-1' },
        'user-1',
      )
      .catch(() => undefined);
    const insert = statements.find(({ sql }) =>
      sql.startsWith('INSERT INTO posts'),
    );
    expect(insert?.sql).toBe(
      `INSERT INTO posts (id, title, content, type, author_id, community_id, media_id, hot_rank, rising_rank) VALUES (?, ?, ?, ?, ?, ?, ?, ${NEW_POST_HOT_RANK_SQL}, ${NEW_POST_RISING_RANK_SQL})`,
    );
    expect(insert?.values).toHaveLength(7);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
