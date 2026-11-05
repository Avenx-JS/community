import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  createPool,
  type Connection,
  type Pool,
  type RowDataPacket,
} from 'mysql2/promise';
import {
  CommentsService,
  type CommentReplyDto,
} from '../comments/comments.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// GET /comments/:id/replies and GET /posts/:postId/comments/top-level against
// a real MySQL server: a thread over the 500-comment ceiling of the tree route
// is fully reachable through the two, removal and deleted communities are
// honoured, and both are served by their (filter, created_at, id) index
// without a filesort. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

type CommentRow = [string, string, string, string | null, string, string];

integration('comment listings (MySQL)', () => {
  const database = `comment_listings_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let service: CommentsService;
  const issued: { sql: string; values: unknown[] }[] = [];
  // Every comment of p-big, by id.
  const bigThread: string[] = [];

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('u1', 'u1', 'u1@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'u1', 'one'), ('c-deleted', 'u1', 'deleted');
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'u1'
        WHERE id = 'c-deleted';
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-big', 'Big', 'Body', 'u1', 'c1'),
        ('p-removal', 'Removal', 'Body', 'u1', 'c1'),
        ('p-empty', 'Empty', 'Body', 'u1', 'c1'),
        ('p-deleted', 'Deleted', 'Body', 'u1', 'c-deleted');`);

    const comments: CommentRow[] = [];
    let sequence = 0;
    const add = (postId: string, parentId: string | null, id?: string) => {
      const commentId = id ?? `${postId}-${String(sequence).padStart(5, '0')}`;
      // created_at repeats in tens, so the id tiebreaker decides real orders.
      const minute = Math.floor(sequence / 10);
      const createdAt = `2026-01-01 ${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
      comments.push([
        commentId,
        postId,
        'u1',
        parentId,
        `Comment ${sequence}`,
        createdAt,
      ]);
      sequence += 1;
      return commentId;
    };

    // p-big: 60 roots with 3 replies of 3 replies each, 780 comments, plus a
    // 30-deep chain under the first root: 810 in all.
    for (let root = 0; root < 60; root += 1) {
      const rootId = add('p-big', null);
      for (let child = 0; child < 3; child += 1) {
        const childId = add('p-big', rootId);
        for (let grandchild = 0; grandchild < 3; grandchild += 1) {
          add('p-big', childId);
        }
      }
    }
    let chainParent = comments[0][0];
    for (let depth = 0; depth < 30; depth += 1) {
      chainParent = add('p-big', chainParent);
    }
    bigThread.push(...comments.map(([id]) => id));

    // 300 other posts with 4 roots each, so roots are common across the
    // table and parent_id IS NULL alone is not selective.
    const others: string[] = [];
    for (let post = 0; post < 300; post += 1) {
      others.push(`p-other-${post}`);
    }
    await connection.query(
      'INSERT INTO posts (id, title, content, author_id, community_id) VALUES ?',
      [others.map((id) => [id, id, 'Body', 'u1', 'c1'])],
    );
    for (const postId of others) {
      for (let root = 0; root < 4; root += 1) {
        add(postId, null);
      }
    }

    // p-removal: r-root has r-visible and r-removed; r-removed has two
    // replies of its own. p-deleted: d-root with one reply.
    add('p-removal', null, 'r-root');
    add('p-removal', 'r-root', 'r-visible');
    add('p-removal', 'r-root', 'r-removed');
    add('p-removal', 'r-removed', 'r-orphan-1');
    add('p-removal', 'r-removed', 'r-orphan-2');
    add('p-removal', null, 'r-removed-root');
    add('p-deleted', null, 'd-root');
    add('p-deleted', 'd-root', 'd-reply');

    for (let start = 0; start < comments.length; start += 1000) {
      await connection.query(
        'INSERT INTO comments (id, post_id, author_id, parent_id, content, created_at) VALUES ?',
        [comments.slice(start, start + 1000)],
      );
    }
    await connection.query(`
      UPDATE comments SET removed_at = UTC_TIMESTAMP(), removed_by = 'u1'
        WHERE id IN ('r-removed', 'r-removed-root');
      ANALYZE TABLE comments, posts, communities;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const recording = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'execute') {
          return (sql: string, values: (string | number)[] = []) => {
            issued.push({ sql, values });
            return target.execute(sql, values);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    service = new CommentsService(
      recording,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  const pageAll = async (
    list: (
      page: number,
    ) => Promise<{ items: CommentReplyDto[]; total: number }>,
  ) => {
    const items: CommentReplyDto[] = [];
    for (let page = 1; ; page += 1) {
      const result = await list(page);
      items.push(...result.items);
      if (page * 100 >= result.total) {
        return items;
      }
    }
  };

  it('refuses the tree of a thread over the ceiling with a 413 naming the routes', async () => {
    expect(bigThread.length).toBeGreaterThan(500);
    await expect(service.findThread('p-big')).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining(
        'GET /posts/:postId/comments/top-level',
      ) as unknown,
    });
  });

  it.each(['oldest', 'new'] as const)(
    'reaches every comment of that thread exactly once through the two routes (sort=%s)',
    async (sort) => {
      const seen: string[] = [];
      const visit = async (items: CommentReplyDto[]) => {
        for (const item of items) {
          seen.push(item.id);
          expect(item).not.toHaveProperty('replies');
          if (item.reply_count > 0) {
            await visit(
              await pageAll((page) =>
                service.findReplies(item.id, { page, limit: 100, sort }),
              ),
            );
          }
        }
      };
      await visit(
        await pageAll((page) =>
          service.findTopLevel('p-big', { page, limit: 100, sort }),
        ),
      );

      expect(seen).toHaveLength(bigThread.length);
      expect(new Set(seen).size).toBe(bigThread.length);
      expect([...seen].sort()).toEqual([...bigThread].sort());
    },
    120_000,
  );

  it.each(['oldest', 'new'] as const)(
    'pages each root exactly once in database order with the id tiebreaker (sort=%s)',
    async (sort) => {
      const seen: string[] = [];
      for (let page = 1; page <= 9; page += 1) {
        const result = await service.findTopLevel('p-big', {
          page,
          limit: 7,
          sort,
        });
        expect(result.total).toBe(60);
        seen.push(...result.items.map((item) => item.id));
      }
      const direction = sort === 'new' ? 'DESC' : 'ASC';
      const expected = await rows(
        `SELECT id FROM comments WHERE post_id = 'p-big' AND parent_id IS NULL ORDER BY created_at ${direction}, id ${direction}`,
      );
      expect(seen).toEqual(expected.map((row) => String(row.id)));
    },
  );

  it('returns direct children only, with reply counts from one grouped query', async () => {
    const root = bigThread[0];
    issued.length = 0;
    const result = await service.findReplies(root, { limit: 100 });

    // 3 children plus the head of the deep chain; no grandchild.
    expect(result.total).toBe(4);
    const direct = await rows(
      'SELECT id FROM comments WHERE parent_id = ? ORDER BY created_at, id',
      [root],
    );
    expect(result.items.map((item) => item.id)).toEqual(
      direct.map((row) => String(row.id)),
    );
    expect(result.items.every((item) => item.parent_id === root)).toBe(true);
    expect(result.items.map((item) => item.reply_count)).toEqual([3, 3, 3, 1]);
    expect(
      issued.filter(({ sql }) => sql.includes('GROUP BY parent_id')),
    ).toHaveLength(1);
    expect(issued).toHaveLength(4);
  });

  it('gives a leaf reply_count 0 and an empty page', async () => {
    const leaf = bigThread[bigThread.length - 1];
    await expect(service.findReplies(leaf, {})).resolves.toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      sort: 'oldest',
    });
    await expect(service.findTopLevel('p-empty', {})).resolves.toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('omits removed comments, and keeps the replies of a removed comment readable', async () => {
    const replies = await service.findReplies('r-root', {});
    expect(replies.items.map((item) => item.id)).toEqual(['r-visible']);
    expect(replies.total).toBe(1);

    const roots = await service.findTopLevel('p-removal', {});
    expect(roots.items).toEqual([
      expect.objectContaining({ id: 'r-root', reply_count: 1 }),
    ]);

    const orphans = await service.findReplies('r-removed', {});
    expect(orphans.items.map((item) => item.id)).toEqual([
      'r-orphan-1',
      'r-orphan-2',
    ]);
  });

  it('answers 404 for an unknown comment or post and for content of a deleted community', async () => {
    for (const call of [
      () => service.findReplies('no-such-comment', {}),
      () => service.findReplies('d-root', {}),
      () => service.findTopLevel('no-such-post', {}),
      () => service.findTopLevel('p-deleted', {}),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
  });

  // Measured plans: each listing is a ref on its (filter, created_at, id)
  // index read in order (backwards for sort=new), never a filesort.
  const planOf = async (run: () => Promise<unknown>) => {
    issued.length = 0;
    await run();
    const listing = issued.find(({ sql }) => sql.includes('ORDER BY'));
    expect(listing).toBeDefined();
    return rows(`EXPLAIN ${listing!.sql}`, listing!.values);
  };

  it.each(['oldest', 'new'] as const)(
    'plans the replies listing on idx_comments_parent_created without a filesort (sort=%s)',
    async (sort) => {
      const plan = await planOf(() =>
        service.findReplies(bigThread[0], { page: 1, limit: 20, sort }),
      );
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({
        table: 'comments',
        type: 'ref',
        key: 'idx_comments_parent_created',
      });
      expect(String(plan[0].Extra)).not.toContain('Using filesort');
    },
  );

  it.each(['oldest', 'new'] as const)(
    'plans the top-level listing on idx_comments_post_created without a filesort (sort=%s)',
    async (sort) => {
      const plan = await planOf(() =>
        service.findTopLevel('p-big', { page: 2, limit: 20, sort }),
      );
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({
        table: 'comments',
        type: 'ref',
        key: 'idx_comments_post_created',
      });
      expect(String(plan[0].Extra)).not.toContain('Using filesort');
    },
  );

  it('plans the grouped reply count as a range on idx_comments_parent_created', async () => {
    issued.length = 0;
    await service.findTopLevel('p-big', { limit: 20 });
    const grouped = issued.find(({ sql }) => sql.includes('GROUP BY'));
    expect(grouped).toBeDefined();
    const plan = await rows(`EXPLAIN ${grouped!.sql}`, grouped!.values);
    expect(plan[0]).toMatchObject({ key: 'idx_comments_parent_created' });
    expect(plan[0].type).not.toBe('ALL');
  });
});
