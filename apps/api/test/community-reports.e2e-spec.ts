import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { CommunityModerationLogService } from '../src/communities/community-moderation-log.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { POST_COLUMNS, REMOVAL_COLUMNS } from '../src/posts/posts.service';
import { CLOSE_COMMUNITY_REPORTS_SQL } from '../src/reports/community-report-review';
import {
  MODERATED_COMMUNITY_SQL,
  modQueueCountSql,
  modQueueSql,
} from '../src/reports/community-reports.service';
import type { ModQueueSort } from '../src/reports/dto/community-reports.dto';
import { answerSavedFlags } from './fakes/saved-posts';
import { answerVoteScores } from './fakes/vote-scores';

interface Report {
  id: string;
  reporter_id: string | null;
  reported_user_id: string | null;
  reason: string;
  description: string | null;
  target_type: string;
  target_id: string;
  status: string;
  community_id: string | null;
  community_status: 'open' | 'approved' | 'removed' | null;
  community_reviewed_by: string | null;
  community_reviewed_at: Date | null;
  created_at: Date;
  withdrawn_at: Date | null;
}

interface Content {
  id: string;
  author_id: string;
  community_id: string;
  removed_at: Date | null;
  removed_by: string | null;
  removal_reason: string | null;
}

// The community moderation queue over HTTP: POST /reports routes post and
// comment reports to the community; moderators list, approve and remove;
// the reporter sees the outcome and never the moderator. The stubbed
// MYSQL_POOL evaluates the report, post and comment statements over
// in-memory rows.
describe('Community report review (e2e)', () => {
  let app: INestApplication<App>;
  let reports: Report[];
  let posts: Map<string, Content & { title: string }>;
  let comments: Map<string, Content & { post_id: string; content: string }>;
  let logged: Array<{
    action: string;
    targetId: string;
    metadata?: unknown;
    actorId: string;
  }>;
  let clock: number;

  const users: Record<string, string> = {
    reporter_a: 'u-a',
    reporter_b: 'u-b',
    author: 'u-author',
    moderator: 'u-mod',
    creator: 'u-creator',
    stranger: 'u-stranger',
  };
  const communities = [
    { id: 'c-garden', name: 'garden', creator_id: 'u-creator', hidden: false },
    { id: 'c-hidden', name: 'hidden', creator_id: 'u-creator', hidden: true },
  ];
  const moderators = new Set(['c-garden:u-mod', 'c-hidden:u-mod']);
  const canModerate = (communityId: string, actor: string) =>
    communities.some((c) => c.id === communityId && c.creator_id === actor) ||
    moderators.has(`${communityId}:${actor}`);
  const openIn = (communityId: string) =>
    reports.filter(
      (r) =>
        r.community_id === communityId &&
        r.community_status === 'open' &&
        !r.withdrawn_at,
    );
  const pairsOf = (values: unknown[]) => {
    const pairs: string[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      pairs.push(`${String(values[i])}:${String(values[i + 1])}`);
    }
    return pairs;
  };

  beforeEach(async () => {
    reports = [];
    logged = [];
    clock = Date.parse('2026-11-12T08:00:00Z');
    posts = new Map(
      ['p-1', 'p-2', 'p-hidden'].map((id) => [
        id,
        {
          id,
          title: `Title ${id}`,
          author_id: 'u-author',
          community_id: id === 'p-hidden' ? 'c-hidden' : 'c-garden',
          removed_at: null,
          removed_by: null,
          removal_reason: null,
        },
      ]),
    );
    comments = new Map([
      [
        'm-1',
        {
          id: 'm-1',
          post_id: 'p-1',
          content: 'A rude comment',
          author_id: 'u-author',
          community_id: 'c-garden',
          removed_at: null,
          removed_by: null,
          removal_reason: null,
        },
      ],
    ]);
    const sorts: ModQueueSort[] = ['oldest', 'newest', 'most_reported'];

    const execute = (sql: string, values: unknown[] = []): unknown => {
      const scores = answerVoteScores(sql, values);
      if (scores) return scores;
      const flags = answerSavedFlags(sql, values);
      if (flags) return flags;

      // POST /reports.
      if (sql.startsWith('SELECT id, username FROM users WHERE username = ?')) {
        const id = users[values[0] as string];
        return [id ? [{ id, username: values[0] }] : [], []];
      }
      if (sql.startsWith('SELECT author_id, community_id FROM posts')) {
        const post = posts.get(values[0] as string);
        return [post ? [post] : [], []];
      }
      if (
        sql.startsWith(
          'SELECT comments.author_id, posts.community_id FROM comments',
        )
      ) {
        const comment = comments.get(values[0] as string);
        return [comment ? [comment] : [], []];
      }
      if (
        sql.startsWith('SELECT id, creator_id FROM communities WHERE name = ?')
      ) {
        return [communities.filter((c) => c.name === values[0]), []];
      }
      if (sql.startsWith('SELECT id FROM users WHERE id = ? FOR UPDATE')) {
        return [[{ id: values[0] }], []];
      }
      if (sql.startsWith('SELECT id FROM user_reports')) {
        const [reporter, type, target] = values as string[];
        const decided = sql.includes(
          "community_status IN ('approved', 'removed')",
        );
        return [
          reports
            .filter(
              (r) =>
                r.reporter_id === reporter &&
                r.target_type === type &&
                r.target_id === target &&
                (decided
                  ? // The community already decided a report by this reporter.
                    r.community_status === 'approved' ||
                    r.community_status === 'removed'
                  : // An active report at the administrators' level.
                    ['open', 'under_review'].includes(r.status) &&
                    !r.withdrawn_at),
            )
            .map(({ id }) => ({ id })),
          [],
        ];
      }
      if (sql.startsWith('INSERT INTO user_reports')) {
        const [
          id,
          reporter_id,
          reported_user_id,
          reason,
          description,
          ,
          ,
          target_type,
          target_id,
          ,
          community_id,
          community_status,
        ] = values as Array<string | null>;
        clock += 60_000;
        reports.push({
          id: id!,
          reporter_id,
          reported_user_id,
          reason: reason!,
          description,
          target_type: target_type!,
          target_id: target_id!,
          status: 'open',
          community_id,
          community_status: community_status as Report['community_status'],
          community_reviewed_by: null,
          community_reviewed_at: null,
          created_at: new Date(clock),
          withdrawn_at: null,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT created_at FROM user_reports WHERE id = ?')) {
        return [reports.filter((r) => r.id === values[0]), []];
      }
      // GET /reports/:id, the reporter's view.
      if (
        sql.includes('FROM user_reports ur') &&
        sql.includes('WHERE ur.id = ? AND ur.reporter_id = ?')
      ) {
        return [
          reports
            .filter((r) => r.id === values[0] && r.reporter_id === values[1])
            .map((r) => ({ ...r, target_label: null })),
          [],
        ];
      }
      if (
        sql.startsWith(
          'SELECT reporter_id, status, community_status, withdrawn_at FROM user_reports',
        )
      ) {
        return [reports.filter((r) => r.id === values[0]), []];
      }
      if (sql.startsWith('UPDATE user_reports SET withdrawn_at')) {
        const report = reports.find((r) => r.id === values[0]);
        if (report) report.withdrawn_at = new Date(clock);
        return [{ affectedRows: report ? 1 : 0 }, []];
      }

      // The community routes.
      if (sql === MODERATED_COMMUNITY_SQL) {
        const [actor, , name] = values as string[];
        return [
          communities
            .filter((c) => c.name === name && !c.hidden)
            .map((c) => ({
              id: c.id,
              can_moderate: canModerate(c.id, actor) ? 1 : 0,
            })),
          [],
        ];
      }
      for (const sort of sorts) {
        for (const byType of [false, true]) {
          if (sql === modQueueSql(sort, byType)) {
            const [community, ...rest] = values as Array<string | number>;
            const type = byType ? rest.shift() : undefined;
            const [limit, offset] = rest as number[];
            const groups = new Map<string, Report[]>();
            for (const r of openIn(community as string)) {
              if (type && r.target_type !== type) continue;
              const key = `${r.target_type}:${r.target_id}`;
              groups.set(key, [...(groups.get(key) ?? []), r]);
            }
            const entries = [...groups.values()].map((group) => ({
              target_type: group[0].target_type,
              target_id: group[0].target_id,
              report_count: group.length,
              reporter_count: new Set(
                group.map((r) => r.reporter_id).filter(Boolean),
              ).size,
              first_reported_at: new Date(
                Math.min(...group.map((r) => r.created_at.getTime())),
              ),
              last_reported_at: new Date(
                Math.max(...group.map((r) => r.created_at.getTime())),
              ),
            }));
            entries.sort((a, b) =>
              sort === 'oldest'
                ? a.first_reported_at.getTime() - b.first_reported_at.getTime()
                : sort === 'newest'
                  ? b.last_reported_at.getTime() - a.last_reported_at.getTime()
                  : b.report_count - a.report_count ||
                    a.first_reported_at.getTime() -
                      b.first_reported_at.getTime(),
            );
            return [entries.slice(offset, offset + limit), []];
          }
          if (sql === modQueueCountSql(byType)) {
            const [community, type] = values as string[];
            const keys = new Set(
              openIn(community)
                .filter((r) => !byType || r.target_type === type)
                .map((r) => `${r.target_type}:${r.target_id}`),
            );
            return [[{ total: keys.size }], []];
          }
        }
      }
      if (
        sql.startsWith(
          'SELECT id, target_type, target_id, reason, description, created_at FROM (',
        )
      ) {
        const [community, ...rest] = values as Array<string | number>;
        const limit = rest.pop() as number;
        const pairs = pairsOf(rest);
        const byTarget = new Map<string, Report[]>();
        for (const r of openIn(community as string)
          .filter((r) => pairs.includes(`${r.target_type}:${r.target_id}`))
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())) {
          const key = `${r.target_type}:${r.target_id}`;
          byTarget.set(key, [...(byTarget.get(key) ?? []), r]);
        }
        return [
          [...byTarget.values()].flatMap((list) => list.slice(0, limit)),
          [],
        ];
      }
      if (
        sql.startsWith(
          'SELECT target_type, target_id, reason, COUNT(*) AS reports',
        )
      ) {
        const [community, ...rest] = values as string[];
        const pairs = pairsOf(rest);
        const counts = new Map<
          string,
          {
            target_type: string;
            target_id: string;
            reason: string;
            reports: number;
          }
        >();
        for (const r of openIn(community).filter((r) =>
          pairs.includes(`${r.target_type}:${r.target_id}`),
        )) {
          const key = `${r.target_type}:${r.target_id}:${r.reason}`;
          const entry = counts.get(key) ?? {
            target_type: r.target_type,
            target_id: r.target_id,
            reason: r.reason,
            reports: 0,
          };
          entry.reports += 1;
          counts.set(key, entry);
        }
        return [[...counts.values()], []];
      }
      if (
        sql.startsWith(
          'SELECT target_type, target_id, COUNT(*) AS reports, COUNT(DISTINCT reporter_id) AS reporters',
        )
      ) {
        const [community, ...rest] = values as string[];
        const pairs = pairsOf(rest);
        return [
          pairs
            .map((pair) => {
              const list = openIn(community).filter(
                (r) => `${r.target_type}:${r.target_id}` === pair,
              );
              const [target_type, target_id] = pair.split(':');
              return {
                target_type,
                target_id,
                reports: list.length,
                reporters: new Set(list.map((r) => r.reporter_id)).size,
              };
            })
            .filter((row) => row.reports > 0),
          [],
        ];
      }
      if (sql.startsWith('SELECT p.id, NULL AS post_id')) {
        return [
          (values as string[])
            .map((id) => posts.get(id))
            .filter(Boolean)
            .map((p) => ({
              id: p!.id,
              post_id: null,
              title: p!.title,
              excerpt: 'Body',
              author_username: 'author',
              author_deleted_at: null,
              created_at: new Date('2026-11-01T00:00:00Z'),
              removed_at: p!.removed_at,
            })),
          [],
        ];
      }
      if (sql.startsWith('SELECT c.id, c.post_id')) {
        return [
          (values as string[])
            .map((id) => comments.get(id))
            .filter(Boolean)
            .map((c) => ({
              id: c!.id,
              post_id: c!.post_id,
              title: null,
              excerpt: c!.content,
              author_username: 'author',
              author_deleted_at: null,
              created_at: new Date('2026-11-01T00:00:00Z'),
              removed_at: c!.removed_at,
            })),
          [],
        ];
      }
      if (
        sql.includes(
          'FROM user_reports WHERE community_id = ? AND withdrawn_at IS NULL',
        )
      ) {
        const rest = [...values] as Array<string | number>;
        const community = rest.shift() as string;
        const status = sql.includes('community_status = ?')
          ? (rest.shift() as string)
          : null;
        const type = sql.includes('target_type = ?')
          ? (rest.shift() as string)
          : null;
        const matching = reports
          .filter(
            (r) =>
              r.community_id === community &&
              !r.withdrawn_at &&
              (status
                ? r.community_status === status
                : r.community_status !== null) &&
              (!type || r.target_type === type),
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return [[{ total: matching.length }], []];
        }
        const [limit, offset] = rest as number[];
        return [matching.slice(offset, offset + limit), []];
      }
      if (
        sql.includes(
          'WHERE id = ? AND community_id = ? AND withdrawn_at IS NULL',
        )
      ) {
        return [
          reports.filter(
            (r) =>
              r.id === values[0] &&
              r.community_id === values[1] &&
              !r.withdrawn_at,
          ),
          [],
        ];
      }
      if (sql.includes('LEFT JOIN users reviewer')) {
        return [
          reports
            .filter(
              (r) =>
                r.id === values[0] &&
                r.community_id === values[1] &&
                !r.withdrawn_at,
            )
            .map((r) => ({
              ...r,
              community_reviewed_by_username:
                Object.keys(users).find(
                  (name) => users[name] === r.community_reviewed_by,
                ) ?? null,
            })),
          [],
        ];
      }
      if (sql === CLOSE_COMMUNITY_REPORTS_SQL) {
        const [status, actor, community, type, target] = values as string[];
        let affectedRows = 0;
        for (const r of openIn(community)) {
          if (r.target_type === type && r.target_id === target) {
            r.community_status = status as Report['community_status'];
            r.community_reviewed_by = actor;
            r.community_reviewed_at = new Date(clock);
            affectedRows += 1;
          }
        }
        return [{ affectedRows }, []];
      }
      const removedAt =
        /^SELECT removed_at FROM (posts|comments) WHERE id = \?/.exec(sql);
      if (removedAt) {
        const row = (removedAt[1] === 'posts' ? posts : comments).get(
          values[0] as string,
        );
        return [row ? [{ removed_at: row.removed_at }] : [], []];
      }

      // The removal paths of posts and comments.
      if (
        sql.startsWith(
          'SELECT posts.id, posts.author_id, posts.community_id, posts.title, posts.removed_at',
        )
      ) {
        const [actor, , id] = values as string[];
        const post = posts.get(id);
        return [
          post
            ? [
                {
                  ...post,
                  can_moderate: canModerate(post.community_id, actor) ? 1 : 0,
                },
              ]
            : [],
          [],
        ];
      }
      if (sql.startsWith('UPDATE posts SET removed_at = UTC_TIMESTAMP()')) {
        const [actor, reason, id] = values as Array<string | null>;
        Object.assign(posts.get(id!)!, {
          removed_at: new Date(clock),
          removed_by: actor,
          removal_reason: reason,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (
        sql ===
        `SELECT ${POST_COLUMNS}, ${REMOVAL_COLUMNS} FROM posts WHERE id = ? LIMIT 1`
      ) {
        const post = posts.get(values[0] as string)!;
        return [
          [
            {
              ...post,
              content: 'Body',
              type: 'text',
              created_at: new Date('2026-11-01T00:00:00Z'),
              pinned_at: null,
              pinned_by: null,
              edited_at: null,
              locked_at: null,
              locked_by: null,
              media_id: null,
            },
          ],
          [],
        ];
      }
      if (
        sql.startsWith(
          'SELECT comments.id, comments.post_id, comments.author_id, comments.content',
        )
      ) {
        const [actor, , id] = values as string[];
        const comment = comments.get(id);
        return [
          comment
            ? [
                {
                  ...comment,
                  post_removed_at: null,
                  can_moderate: canModerate(comment.community_id, actor)
                    ? 1
                    : 0,
                },
              ]
            : [],
          [],
        ];
      }
      if (sql.startsWith('UPDATE comments SET removed_at = UTC_TIMESTAMP()')) {
        const [actor, reason, id] = values as Array<string | null>;
        Object.assign(comments.get(id!)!, {
          removed_at: new Date(clock),
          removed_by: actor,
          removal_reason: reason,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (
        sql.startsWith(
          'SELECT id, post_id, parent_id, author_id, content, created_at',
        )
      ) {
        const comment = comments.get(values[0] as string)!;
        return [
          [
            {
              ...comment,
              parent_id: null,
              created_at: new Date('2026-11-01T00:00:00Z'),
              edited_at: null,
              locked_at: null,
              locked_by: null,
            },
          ],
          [],
        ];
      }
      if (sql.startsWith('SELECT parent_id, COUNT(*)')) return [[], []];
      if (
        sql.startsWith(
          'SELECT removed_at, removed_by, removal_reason, removed_by_admin FROM comments',
        )
      ) {
        return [[comments.get(values[0] as string)], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    const promised = (sql: string, values?: unknown[]) => {
      try {
        return Promise.resolve(execute(sql, values));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    };
    const pool = {
      execute: promised,
      query: promised,
      getConnection: () =>
        Promise.resolve({
          execute: promised,
          query: promised,
          beginTransaction: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
          release: () => undefined,
        }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(CommunityModerationLogService)
      .useValue({
        record: (_connection: unknown, entry: (typeof logged)[number]) => {
          logged.push(entry);
          return Promise.resolve();
        },
      })
      .overrideProvider(NotificationsService)
      .useValue({ record: () => Promise.resolve() })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token in users
              ? { kind: 'valid', emailVerified: true, userId: users[token] }
              : { kind: 'invalid' },
          ),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (token: string) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string) =>
      request(app.getHttpServer())
        .delete(path)
        .set('Authorization', `Bearer ${token}`),
  });
  const report = async (
    token: string,
    target_type: string,
    target: string,
    reason = 'spam',
  ) =>
    (
      (
        await as(token)
          .post('/reports', { target_type, target, reason })
          .expect(201)
      ).body as { id: string }
    ).id;
  const queue = async (token = 'moderator', query = '') =>
    (await as(token).get(`/communities/garden/modqueue${query}`).expect(200))
      .body as {
      items: Array<{
        target_type: string;
        target_id: string;
        report_count: number;
        reporter_count: number;
        reasons: Record<string, number>;
        reports: Array<Record<string, unknown>>;
        target: Record<string, unknown> | null;
      }>;
      total: number;
    };

  describe('routing', () => {
    it('routes post and comment reports to the community, open there', async () => {
      await report('reporter_a', 'post', 'p-1');
      await report('reporter_a', 'comment', 'm-1');
      expect(
        reports.map((r) => [r.target_type, r.community_id, r.community_status]),
      ).toEqual([
        ['post', 'c-garden', 'open'],
        ['comment', 'c-garden', 'open'],
      ]);
      // Administrators keep seeing them: their own status is untouched.
      expect(reports.every((r) => r.status === 'open')).toBe(true);
    });

    it('keeps account and community reports for administrators only', async () => {
      await report('reporter_a', 'user', 'author');
      await report('reporter_a', 'community', 'garden');
      expect(reports.map((r) => [r.community_id, r.community_status])).toEqual([
        [null, null],
        [null, null],
      ]);
      expect((await queue()).total).toBe(0);
      expect(
        (
          (
            await as('moderator')
              .get('/communities/garden/reports?status=any')
              .expect(200)
          ).body as { total: number }
        ).total,
      ).toBe(0);
    });
  });

  describe('the queue', () => {
    it('gathers several reports of one post into one entry, listing each, never the reporter', async () => {
      await report('reporter_a', 'post', 'p-1', 'spam');
      await report('reporter_b', 'post', 'p-1', 'harassment');
      await report('reporter_a', 'comment', 'm-1');
      const { items, total } = await queue();
      expect(total).toBe(2);
      const post = items.find((item) => item.target_id === 'p-1')!;
      expect(post).toMatchObject({
        target_type: 'post',
        report_count: 2,
        reporter_count: 2,
        reasons: { spam: 1, harassment: 1 },
        target: {
          type: 'post',
          id: 'p-1',
          title: 'Title p-1',
          author_username: 'author',
          removed: false,
        },
      });
      expect(post.reports).toHaveLength(2);
      expect(JSON.stringify(items)).not.toMatch(
        /u-a|u-b|reporter_a|reporter_b|reporter_id/,
      );
    });

    it('sorts by age and by number of reports, and filters by type', async () => {
      await report('reporter_a', 'post', 'p-2');
      await report('reporter_a', 'post', 'p-1');
      await report('reporter_b', 'post', 'p-1');
      await report('reporter_a', 'comment', 'm-1');
      expect((await queue()).items.map((i) => i.target_id)).toEqual([
        'p-2',
        'p-1',
        'm-1',
      ]);
      expect(
        (await queue('moderator', '?sort=newest')).items.map(
          (i) => i.target_id,
        ),
      ).toEqual(['m-1', 'p-1', 'p-2']);
      expect(
        (await queue('moderator', '?sort=most_reported')).items[0].target_id,
      ).toBe('p-1');
      expect(
        (await queue('moderator', '?target_type=comment')).items.map(
          (i) => i.target_id,
        ),
      ).toEqual(['m-1']);
      await as('moderator')
        .get('/communities/garden/modqueue?sort=hot')
        .expect(400);
    });

    it('omits withdrawn reports', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      await as('reporter_a').delete(`/reports/${id}`).expect(204);
      expect((await queue()).total).toBe(0);
    });
  });

  describe('access', () => {
    it.each(['moderator', 'creator'])('lets the %s in', async (token) => {
      await as(token).get('/communities/garden/modqueue').expect(200);
      await as(token).get('/communities/garden/reports').expect(200);
    });

    it('refuses anyone else with 403, and a hidden or unknown community with 404', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      for (const path of ['modqueue', 'reports', `reports/${id}`]) {
        await as('stranger').get(`/communities/garden/${path}`).expect(403);
        await as('author').get(`/communities/garden/${path}`).expect(403);
        await as('moderator').get(`/communities/hidden/${path}`).expect(404);
        await as('moderator').get(`/communities/nowhere/${path}`).expect(404);
      }
      await as('stranger')
        .post(`/communities/garden/reports/${id}/approve`)
        .expect(403);
      await as('stranger')
        .post(`/communities/garden/reports/${id}/remove`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/communities/garden/modqueue')
        .expect(401);
      expect(reports[0].community_status).toBe('open');
    });

    it("answers 404 for another community's report", async () => {
      const id = await report('reporter_a', 'post', 'p-hidden');
      await as('creator').get(`/communities/garden/reports/${id}`).expect(404);
      await as('creator')
        .post(`/communities/garden/reports/${id}/approve`)
        .expect(404);
    });
  });

  describe('approve', () => {
    it('closes the whole entry, keeps the content, logs once, and tells the reporter only the outcome', async () => {
      const first = await report('reporter_a', 'post', 'p-1');
      await report('reporter_b', 'post', 'p-1');
      const body: unknown = (
        await as('moderator')
          .post(`/communities/garden/reports/${first}/approve`)
          .expect(200)
      ).body;
      expect(body).toMatchObject({
        id: first,
        community_status: 'approved',
        community_reviewed_by_username: 'moderator',
        open_reports_on_target: 0,
      });
      expect(reports.map((r) => r.community_status)).toEqual([
        'approved',
        'approved',
      ]);
      expect(posts.get('p-1')!.removed_at).toBeNull();
      expect(logged).toEqual([
        expect.objectContaining({
          action: 'report_approved',
          targetId: 'p-1',
          metadata: { reports: 2 },
          actorId: 'u-mod',
        }),
      ]);
      expect((await queue()).total).toBe(0);

      const own = (await as('reporter_a').get(`/reports/${first}`).expect(200))
        .body as Record<string, unknown>;
      expect(own).toMatchObject({
        community_status: 'approved',
        status: 'open',
      });
      expect(JSON.stringify(own)).not.toMatch(/moderator|u-mod|reviewed/);
    });

    it('does not reopen: the same reporter cannot re-report, someone new opens a new entry', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      await as('moderator')
        .post(`/communities/garden/reports/${id}/approve`)
        .expect(200);
      await as('reporter_a')
        .post('/reports', {
          target_type: 'post',
          target: 'p-1',
          reason: 'spam',
        })
        .expect(409);
      expect((await queue()).total).toBe(0);
      await report('reporter_b', 'post', 'p-1');
      expect((await queue()).items).toMatchObject([
        { target_id: 'p-1', report_count: 1 },
      ]);
    });

    it('answers 409 for a closed report, and lets no reporter withdraw it', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      await as('creator')
        .post(`/communities/garden/reports/${id}/approve`)
        .expect(200);
      await as('moderator')
        .post(`/communities/garden/reports/${id}/approve`)
        .expect(409);
      await as('moderator')
        .post(`/communities/garden/reports/${id}/remove`)
        .expect(409);
      await as('reporter_a').delete(`/reports/${id}`).expect(409);
      expect(logged).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('removes the post and closes its reports in one step, logging both', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      await report('reporter_b', 'post', 'p-1');
      const body: unknown = (
        await as('moderator')
          .post(`/communities/garden/reports/${id}/remove`, {
            reason: 'Spam link',
          })
          .expect(200)
      ).body;
      expect(body).toMatchObject({
        community_status: 'removed',
        target: { removed: true },
      });
      expect(posts.get('p-1')).toMatchObject({
        removed_by: 'u-mod',
        removal_reason: 'Spam link',
      });
      expect(reports.map((r) => r.community_status)).toEqual([
        'removed',
        'removed',
      ]);
      expect(logged.map((entry) => entry.action)).toEqual([
        'post_removed',
        'report_removed',
      ]);
      expect(logged[1]).toMatchObject({ metadata: { reports: 2 } });
    });

    it('removes a comment the same way', async () => {
      const id = await report('reporter_a', 'comment', 'm-1');
      await as('creator')
        .post(`/communities/garden/reports/${id}/remove`)
        .expect(200);
      expect(comments.get('m-1')!.removed_at).not.toBeNull();
      expect(logged.map((entry) => entry.action)).toEqual([
        'comment_removed',
        'report_removed',
      ]);
    });

    it('only closes the reports of content already removed', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      posts.get('p-1')!.removed_at = new Date();
      await as('moderator')
        .post(`/communities/garden/reports/${id}/remove`)
        .expect(200);
      expect(logged.map((entry) => entry.action)).toEqual(['report_removed']);
    });

    it('closes open reports when the content is removed through its own route', async () => {
      await report('reporter_a', 'post', 'p-2');
      await as('moderator').post('/posts/p-2/remove', {}).expect(200);
      expect(reports[0].community_status).toBe('removed');
      expect(logged.map((entry) => entry.action)).toEqual([
        'post_removed',
        'report_removed',
      ]);
      expect((await queue()).total).toBe(0);
    });

    it('refuses content its author has since deleted, which approval closes', async () => {
      const id = await report('reporter_a', 'post', 'p-2');
      posts.delete('p-2');
      await as('moderator')
        .post(`/communities/garden/reports/${id}/remove`)
        .expect(409);
      await as('moderator')
        .post(`/communities/garden/reports/${id}/approve`)
        .expect(200);
    });

    it('validates the reason', async () => {
      const id = await report('reporter_a', 'post', 'p-1');
      await as('moderator')
        .post(`/communities/garden/reports/${id}/remove`, { reason: '' })
        .expect(400);
      await as('moderator')
        .post(`/communities/garden/reports/${id}/remove`, { unexpected: 1 })
        .expect(400);
      expect(reports[0].community_status).toBe('open');
    });
  });

  describe('GET /communities/:name/reports and /reports/:id', () => {
    it('lists reports singly with the counts of their content, open by default', async () => {
      const a = await report('reporter_a', 'post', 'p-1');
      await report('reporter_b', 'post', 'p-1');
      await report('reporter_a', 'post', 'p-2');
      await as('moderator')
        .post(`/communities/garden/reports/${a}/approve`)
        .expect(200);
      const open = (
        await as('moderator').get('/communities/garden/reports').expect(200)
      ).body as { items: Array<Record<string, unknown>>; total: number };
      expect(open.total).toBe(1);
      expect(open.items[0]).toMatchObject({
        target_id: 'p-2',
        community_status: 'open',
        open_reports_on_target: 1,
      });
      const approved = (
        await as('moderator')
          .get('/communities/garden/reports?status=approved')
          .expect(200)
      ).body as { total: number };
      expect(approved.total).toBe(2);
      expect(
        (
          (
            await as('moderator')
              .get('/communities/garden/reports?status=any')
              .expect(200)
          ).body as { total: number }
        ).total,
      ).toBe(3);
    });

    it('shows one report with the other open reports of its content', async () => {
      const a = await report('reporter_a', 'post', 'p-1');
      const b = await report('reporter_b', 'post', 'p-1', 'harassment');
      const body: unknown = (
        await as('moderator')
          .get(`/communities/garden/reports/${a}`)
          .expect(200)
      ).body;
      expect(body).toMatchObject({
        id: a,
        community_status: 'open',
        community_reviewed_by_username: null,
        open_reports_on_target: 2,
        other_open_reports: [{ id: b, reason: 'harassment' }],
      });
      expect(JSON.stringify(body)).not.toMatch(
        /"u-a"|"u-b"|reporter_a|reporter_b|reporter_id/,
      );
    });
  });
});
