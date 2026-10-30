import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createRulesStore,
  type RulesStore,
} from '../../test/fakes/community-rules-store';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommentsService } from '../comments/comments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { VotesService } from '../votes/votes.service';
import { CommunitiesService } from './communities.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';

// The four participation paths and their exemptions, run against one
// in-memory database through the real services. community-1 ("gardening",
// created by "creator") holds post-1 and comment-1; community-2 ("orchards")
// holds post-2 and comment-2.
describe('Rule acceptance enforcement', () => {
  interface Db {
    subscriptions: Array<[string, string]>;
    posts: Array<Record<string, unknown>>;
    comments: Array<Record<string, unknown>>;
    votes: Array<Record<string, unknown>>;
  }

  let db: Db;
  let rules: RulesStore;
  let moderators: Set<string>;
  let openConnections: number;
  let rollbacks: number;
  let connections: unknown[];
  let check: jest.SpyInstance;
  let communities: CommunitiesService;
  let posts: PostsService;
  let comments: CommentsService;
  let votes: VotesService;

  const communityNames: Record<string, string> = {
    gardening: 'community-1',
    orchards: 'community-2',
  };

  beforeEach(async () => {
    rules = createRulesStore({
      'community-1': { name: 'gardening', creator_id: 'creator' },
      'community-2': { name: 'orchards', creator_id: 'creator' },
    });
    moderators = new Set(['community-1:mod']);
    db = {
      subscriptions: [],
      posts: [
        {
          id: 'post-1',
          title: 'Tomatoes',
          content: 'Body',
          type: 'text',
          author_id: 'author',
          community_id: 'community-1',
          created_at: new Date('2026-10-30T08:00:00.000Z'),
        },
        {
          id: 'post-2',
          title: 'Apples',
          content: 'Body',
          type: 'text',
          author_id: 'author',
          community_id: 'community-2',
          created_at: new Date('2026-10-30T08:00:00.000Z'),
        },
      ],
      comments: [
        {
          id: 'comment-1',
          post_id: 'post-1',
          author_id: 'author',
          parent_id: null,
          content: 'First',
          created_at: new Date('2026-10-30T08:00:00.000Z'),
        },
        {
          id: 'comment-2',
          post_id: 'post-2',
          author_id: 'author',
          parent_id: null,
          content: 'Second',
          created_at: new Date('2026-10-30T08:00:00.000Z'),
        },
      ],
      votes: [],
    };
    openConnections = 0;
    rollbacks = 0;
    connections = [];

    const postById = (id: unknown) => db.posts.find((post) => post.id === id);
    const canModerate = (communityId: unknown, userId: unknown) =>
      rules.communities.get(communityId as string)?.creator_id === userId ||
      moderators.has(`${String(communityId)}:${String(userId)}`)
        ? 1
        : 0;

    const execute = (
      sql: string,
      values: unknown[],
    ): Promise<[unknown, unknown]> => {
      const ruleAnswer = rules.handle(sql, values);
      if (ruleAnswer) {
        return Promise.resolve(ruleAnswer);
      }
      const rows = (value: unknown): Promise<[unknown, unknown]> =>
        Promise.resolve([value, []]);

      if (sql === 'SELECT id FROM communities WHERE name = ? LIMIT 1') {
        const id = communityNames[values[0] as string];
        return rows(id ? [{ id }] : []);
      }
      if (sql === 'SELECT id FROM communities WHERE id = ? LIMIT 1') {
        return rows(
          rules.communities.has(values[0] as string) ? [{ id: values[0] }] : [],
        );
      }
      if (sql.startsWith('INSERT INTO community_subscriptions')) {
        db.subscriptions.push(values as [string, string]);
        return rows({ affectedRows: 1 });
      }
      if (sql.startsWith('DELETE FROM community_subscriptions')) {
        db.subscriptions = db.subscriptions.filter(
          ([user, community]) => user !== values[0] || community !== values[1],
        );
        return rows({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO posts')) {
        const [id, title, content, type, authorId, communityId] = values;
        db.posts.push({
          id,
          title,
          content,
          type,
          author_id: authorId,
          community_id: communityId,
          created_at: new Date('2026-10-30T09:00:00.000Z'),
        });
        return rows({ affectedRows: 1 });
      }
      if (sql.startsWith('SELECT id, title, content, type')) {
        const post = postById(values[0]);
        return rows(post ? [post] : []);
      }
      if (sql.startsWith('SELECT id FROM posts WHERE id = ?')) {
        return rows(postById(values[0]) ? [{ id: values[0] }] : []);
      }
      if (
        sql.startsWith('SELECT id, author_id, community_id, title FROM posts')
      ) {
        const post = postById(values[0]);
        return rows(post ? [post] : []);
      }
      if (
        sql.startsWith(
          'SELECT id, community_id FROM posts WHERE id = ? FOR UPDATE',
        )
      ) {
        const post = postById(values[0]);
        return rows(
          post ? [{ id: post.id, community_id: post.community_id }] : [],
        );
      }
      if (sql.startsWith('SELECT comments.id, posts.community_id')) {
        const comment = db.comments.find((entry) => entry.id === values[0]);
        const post = comment && postById(comment.post_id);
        return rows(
          post ? [{ id: comment.id, community_id: post.community_id }] : [],
        );
      }
      if (
        sql.startsWith(
          'SELECT id, author_id FROM comments WHERE id = ? AND post_id',
        )
      ) {
        return rows(
          db.comments.filter(
            (comment) =>
              comment.id === values[0] && comment.post_id === values[1],
          ),
        );
      }
      if (sql.startsWith('INSERT INTO comments')) {
        const [id, postId, authorId, parentId, content] = values;
        db.comments.push({
          id,
          post_id: postId,
          author_id: authorId,
          parent_id: parentId,
          content,
          created_at: new Date('2026-10-30T09:00:00.000Z'),
        });
        return rows({ affectedRows: 1 });
      }
      if (
        sql.startsWith('SELECT id, post_id, author_id, parent_id') &&
        sql.includes('WHERE post_id = ?')
      ) {
        return rows(
          db.comments.filter((comment) => comment.post_id === values[0]),
        );
      }
      if (sql.startsWith('SELECT id, post_id, author_id, parent_id')) {
        return rows(db.comments.filter((comment) => comment.id === values[0]));
      }
      if (sql.startsWith('INSERT INTO votes')) {
        const [id, userId, targetType, targetId, value] = values;
        db.votes.push({
          id,
          user_id: userId,
          target_type: targetType,
          target_id: targetId,
          value,
          created_at: new Date('2026-10-30T09:00:00.000Z'),
        });
        return rows({ affectedRows: 1 });
      }
      if (sql.startsWith('SELECT id, user_id, target_type')) {
        return rows(
          db.votes.filter(
            (vote) =>
              vote.user_id === values[0] &&
              vote.target_type === values[1] &&
              vote.target_id === values[2],
          ),
        );
      }
      if (sql.startsWith('SELECT COALESCE(SUM(value)')) {
        return rows([{ score: 1 }]);
      }
      if (sql.startsWith('SELECT posts.id, posts.author_id')) {
        const [userId, , id] = values;
        const post = postById(id);
        return rows(
          post
            ? [
                {
                  ...post,
                  can_moderate: canModerate(post.community_id, userId),
                },
              ]
            : [],
        );
      }
      if (sql.startsWith('SELECT comments.id, comments.author_id')) {
        const [userId, , id] = values;
        const comment = db.comments.find((entry) => entry.id === id);
        const post = comment && postById(comment.post_id);
        return rows(
          post
            ? [
                {
                  ...comment,
                  community_id: post.community_id,
                  can_moderate: canModerate(post.community_id, userId),
                },
              ]
            : [],
        );
      }
      if (sql === 'DELETE FROM posts WHERE id = ?') {
        db.posts = db.posts.filter((post) => post.id !== values[0]);
        return rows({ affectedRows: 1 });
      }
      if (sql === 'DELETE FROM comments WHERE id = ?') {
        db.comments = db.comments.filter((comment) => comment.id !== values[0]);
        return rows({ affectedRows: 1 });
      }
      if (sql.includes('ORDER BY created_at DESC')) {
        return rows(db.posts);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM posts')) {
        return rows([{ total: db.posts.length }]);
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };

    const pool = {
      execute,
      getConnection: () => {
        openConnections += 1;
        let snapshot: Db | null = null;
        const connection = {
          execute,
          beginTransaction: () => {
            snapshot = {
              subscriptions: [...db.subscriptions],
              posts: [...db.posts],
              comments: [...db.comments],
              votes: [...db.votes],
            };
            return Promise.resolve();
          },
          commit: () => Promise.resolve(),
          rollback: () => {
            rollbacks += 1;
            if (snapshot) {
              db = snapshot;
            }
            return Promise.resolve();
          },
          release: () => {
            openConnections -= 1;
          },
        };
        connections.push(connection);
        return Promise.resolve(connection);
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        CommunitiesService,
        CommunityRuleAcceptanceService,
        CommentsService,
        PostsService,
        VotesService,
        { provide: MYSQL_POOL, useValue: pool },
        {
          provide: NotificationsService,
          useValue: {
            record: () => Promise.resolve(),
            recordCommunityPost: () =>
              Promise.resolve({ recipients: 0, written: false }),
          },
        },
      ],
    }).compile();
    communities = module.get(CommunitiesService);
    posts = module.get(PostsService);
    comments = module.get(CommentsService);
    votes = module.get(VotesService);
    check = jest.spyOn(
      module.get(CommunityRuleAcceptanceService),
      'assertAcceptedOrThrow',
    );
  });

  // The four gated paths, each in community-1 unless a test says otherwise.
  const participate = {
    // Resolves true, so every path can be asserted with toBeDefined().
    subscribe: (userId: string) =>
      communities.subscribe('gardening', userId).then(() => true),
    post: (userId: string) =>
      posts.create(
        {
          title: 'New',
          type: 'text',
          content: 'Body',
          community_id: 'community-1',
        },
        userId,
      ),
    comment: (userId: string) =>
      comments.create(
        'post-1',
        { content: 'Hi', parent_id: 'comment-1' },
        userId,
      ),
    votePost: (userId: string) =>
      votes.vote(
        { target_type: 'post', target_id: 'post-1', value: 1 },
        userId,
      ),
    voteComment: (userId: string) =>
      votes.vote(
        { target_type: 'comment', target_id: 'comment-1', value: 1 },
        userId,
      ),
  };
  const paths = Object.entries(participate);

  const written = () => ({
    subscriptions: db.subscriptions.length,
    posts: db.posts.length,
    comments: db.comments.length,
    votes: db.votes.length,
  });

  async function expectRefused(
    action: () => Promise<unknown>,
    version: number,
  ) {
    const error: unknown = await action().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      reason: 'community_rules_not_accepted',
      community: 'gardening',
      current_version: version,
    });
  }

  it.each(paths)(
    'permits %s for anyone when the community has no published rules',
    async (_name, action) => {
      await expect(action('member')).resolves.toBeDefined();

      // Subscribing checks on the pool; the others pass their connection.
      if (_name === 'subscribe') {
        expect(check).toHaveBeenCalledWith('member', 'community-1');
      } else {
        expect(check).toHaveBeenCalledWith(
          'member',
          'community-1',
          expect.anything(),
        );
      }
      expect(rules.acceptances).toEqual([]);
      expect(openConnections).toBe(0);
    },
  );

  it.each(paths)(
    'refuses %s without accepted rules, writing nothing and releasing the connection',
    async (_name, action) => {
      rules.publish('community-1');
      const before = written();

      await expectRefused(() => action('member'), 1);

      expect(written()).toEqual(before);
      expect(openConnections).toBe(0);
      // Subscribing has no transaction; the other paths roll theirs back.
      expect(rollbacks).toBe(_name === 'subscribe' ? 0 : 1);
    },
  );

  it.each(paths)(
    'permits %s once the current rules are accepted',
    async (_name, action) => {
      rules.publish('community-1');
      rules.accept('member', 'community-1');

      await expect(action('member')).resolves.toBeDefined();
    },
  );

  it('follows a member through a new rules version on every path, keeping their membership', async () => {
    rules.publish('community-1');
    rules.accept('member', 'community-1');
    for (const [, action] of paths) {
      await action('member');
    }
    expect(db.subscriptions).toContainEqual(['member', 'community-1']);

    rules.publish('community-1');
    for (const [, action] of paths) {
      await expectRefused(() => action('member'), 2);
    }
    expect(db.subscriptions).toContainEqual(['member', 'community-1']);

    rules.accept('member', 'community-1');
    for (const [, action] of paths) {
      await expect(action('member')).resolves.toBeDefined();
    }
  });

  it('does not refuse a member grandfathered onto the backfilled version 1', async () => {
    rules.publish('community-1');
    rules.accept('grandfathered', 'community-1');

    for (const [, action] of paths) {
      await expect(action('grandfathered')).resolves.toBeDefined();
    }
  });

  it('never refuses the community creator, even right after a new version', async () => {
    rules.publish('community-1');
    rules.publish('community-1');

    for (const [, action] of paths) {
      await expect(action('creator')).resolves.toBeDefined();
    }
  });

  it('refuses a moderator who has not accepted, who can still remove content', async () => {
    rules.publish('community-1');

    for (const [, action] of paths) {
      await expectRefused(() => action('mod'), 1);
    }
    await expect(comments.remove('comment-1', 'mod')).resolves.toBeUndefined();
    await expect(posts.remove('post-1', 'mod')).resolves.toBeUndefined();
  });

  it('gates a comment vote on the community of the comment’s post', async () => {
    rules.publish('community-2');

    await expect(participate.voteComment('member')).resolves.toBeDefined();
    const error: unknown = await votes
      .vote(
        { target_type: 'comment', target_id: 'comment-2', value: 1 },
        'member',
      )
      .catch((caught: unknown) => caught);

    expect((error as ForbiddenException).getResponse()).toMatchObject({
      community: 'orchards',
    });
    expect(
      rules.statements.filter((sql) =>
        sql.includes('LEFT JOIN community_rule_acceptances'),
      ),
    ).toHaveLength(2);
    expect(db.votes).toHaveLength(1);
  });

  it('checks inside the post, comment and vote transactions, on their own connection', async () => {
    rules.publish('community-1');
    rules.accept('member', 'community-1');

    for (const action of [
      participate.post,
      participate.comment,
      participate.votePost,
    ]) {
      connections = [];
      check.mockClear();
      await action('member');
      expect(check).toHaveBeenCalledTimes(1);
      expect((check.mock.calls as unknown[][])[0][2]).toBe(connections[0]);
    }
  });

  it('returns 404, not 403, for an unknown target, without consulting the rules', async () => {
    rules.publish('community-1');
    rules.publish('community-2');
    const unknown = [
      () => communities.subscribe('unknown', 'member'),
      () =>
        posts.create(
          {
            title: 'New',
            type: 'text',
            content: 'Body',
            community_id: 'missing',
          },
          'member',
        ),
      () => comments.create('missing', { content: 'Hi' }, 'member'),
      () =>
        comments.create(
          'post-1',
          { content: 'Hi', parent_id: 'missing' },
          'member',
        ),
      () =>
        votes.vote(
          { target_type: 'post', target_id: 'missing', value: 1 },
          'member',
        ),
      () =>
        votes.vote(
          { target_type: 'comment', target_id: 'missing', value: 1 },
          'member',
        ),
    ];

    for (const action of unknown) {
      await expect(action()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(check).not.toHaveBeenCalled();
    expect(openConnections).toBe(0);
  });

  // Over-enforcement is the risk: none of these may ever consult the rules.
  it('never consults the rules for leaving, deleting or reading', async () => {
    rules.publish('community-1');
    db.subscriptions.push(['member', 'community-1']);
    db.comments.push({
      id: 'own-comment',
      post_id: 'post-1',
      author_id: 'member',
      parent_id: null,
      content: 'Mine',
      created_at: new Date('2026-10-30T08:00:00.000Z'),
    });
    db.posts.push({ ...db.posts[0], id: 'own-post', author_id: 'member' });

    await communities.unsubscribe('gardening', 'member');
    await comments.remove('own-comment', 'member');
    await posts.remove('own-post', 'member');
    await posts.findOne('post-1');
    await posts.findAll({ community_id: 'community-1' });
    await comments.findThread('post-1');

    expect(check).not.toHaveBeenCalled();
    expect(db.subscriptions).toEqual([]);
  });
});
