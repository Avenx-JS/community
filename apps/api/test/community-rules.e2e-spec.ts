import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';

interface TestDocument {
  id: string;
  community_id: string;
  version: number;
  content_hash: string;
  published_at: Date;
  published_by: string | null;
}

interface TestRule {
  id: string;
  document_id: string;
  position: number;
  title: string;
  body: string | null;
}

const tokenUsers: Record<string, string> = {
  'creator-token': 'creator',
  'moderator-token': 'moderator',
  'member-token': 'member',
};

// Extra columns on every fake row let the tests prove that responses carry
// only documented fields.
const privateColumns = {
  email: 'private@example.com',
  password_hash: 'private-hash',
  token: 'private-token',
};

interface RulesBody {
  version: number | null;
  published_at: string | null;
}

interface HistoryBody {
  items: Array<{ version: number }>;
}

const rules = (...titles: string[]) => ({
  items: titles.map((title) => ({ title, body: `${title} body` })),
});

describe('Community rules endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let documents: TestDocument[];
  let ruleRows: TestRule[];
  let usernames: Map<string, string>;
  let failRuleInsert: boolean;
  let beforeCurrentRead: (() => Promise<void>) | null;
  let rateLimitCalls: Array<{ method: string; path: string }>;
  let clock: number;

  const communities = [
    { id: 'community-a', creator_id: 'creator', name: 'gardening' },
    { id: 'community-b', creator_id: 'someone', name: 'cooking' },
  ];

  const server = () => app.getHttpServer();

  beforeEach(async () => {
    documents = [];
    ruleRows = [];
    usernames = new Map([
      ['creator', 'creator_name'],
      ['moderator', 'moderator_name'],
    ]);
    failRuleInsert = false;
    beforeCurrentRead = null;
    rateLimitCalls = [];
    clock = Date.parse('2026-10-22T08:00:00.000Z');

    // A connection buffers its writes until commit. Like InnoDB, an
    // uncommitted insert reserves its (community_id, version) key for every
    // other transaction. FOR UPDATE is ignored, so concurrent requests reach
    // that unique-key backstop.
    const reservedVersions = new Set<string>();
    const createExecutor = (pending?: {
      documents: TestDocument[];
      rules: TestRule[];
    }) => {
      const visibleDocuments = () => [
        ...documents,
        ...(pending?.documents ?? []),
      ];
      const visibleRules = () => [...ruleRows, ...(pending?.rules ?? [])];

      return async (sql: string, values: unknown[]) => {
        if (sql.startsWith('SELECT id, creator_id FROM communities')) {
          const [name] = values as [string];
          return [
            communities
              .filter((community) => community.name === name)
              .map((community) => ({ ...community, ...privateColumns })),
            [],
          ];
        }

        if (
          sql.includes('FROM community_rule_documents') &&
          sql.includes('ORDER BY version DESC')
        ) {
          await beforeCurrentRead?.();
          const [communityId] = values as [string];
          const current = visibleDocuments()
            .filter((document) => document.community_id === communityId)
            .sort((left, right) => right.version - left.version)[0];
          return [current ? [{ ...current, ...privateColumns }] : [], []];
        }

        if (
          sql.includes('FROM community_rule_documents') &&
          sql.includes('community_id = ? AND version = ?')
        ) {
          const [communityId, version] = values as [string, number];
          return [
            visibleDocuments().filter(
              (document) =>
                document.community_id === communityId &&
                document.version === version,
            ),
            [],
          ];
        }

        if (
          sql.startsWith('SELECT published_at FROM community_rule_documents')
        ) {
          const [id] = values as [string];
          return [
            visibleDocuments().filter((document) => document.id === id),
            [],
          ];
        }

        if (
          sql.startsWith('SELECT position, title, body FROM community_rules')
        ) {
          const [documentId] = values as [string];
          return [
            visibleRules()
              .filter((rule) => rule.document_id === documentId)
              .sort((left, right) => left.position - right.position)
              .map((rule) => ({ ...rule, ...privateColumns })),
            [],
          ];
        }

        if (sql.includes('LEFT JOIN users u')) {
          const [communityId, limit, offset] = values as [
            string,
            number,
            number,
          ];
          const rows = visibleDocuments()
            .filter((document) => document.community_id === communityId)
            .sort((left, right) => right.version - left.version)
            .map((document) => ({
              ...privateColumns,
              version: document.version,
              published_at: document.published_at,
              published_by_username: document.published_by
                ? (usernames.get(document.published_by) ?? null)
                : null,
              rule_count: visibleRules().filter(
                (rule) => rule.document_id === document.id,
              ).length,
            }));
          return [rows.slice(offset, offset + limit), []];
        }

        if (
          sql.startsWith(
            'SELECT COUNT(*) AS total FROM community_rule_documents',
          )
        ) {
          const [communityId] = values as [string];
          return [
            [
              {
                total: visibleDocuments().filter(
                  (document) => document.community_id === communityId,
                ).length,
              },
            ],
            [],
          ];
        }

        if (sql.startsWith('INSERT INTO community_rule_documents')) {
          const [id, communityId, version, contentHash, publishedBy] =
            values as [string, string, number, string, string];
          const key = `${communityId}:${version}`;
          if (
            reservedVersions.has(key) ||
            documents.some(
              (document) =>
                document.community_id === communityId &&
                document.version === version,
            )
          ) {
            throw Object.assign(new Error('Duplicate entry'), {
              code: 'ER_DUP_ENTRY',
            });
          }
          reservedVersions.add(key);
          clock += 60_000;
          pending!.documents.push({
            id,
            community_id: communityId,
            version,
            content_hash: contentHash,
            published_at: new Date(clock),
            published_by: publishedBy,
          });
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('INSERT INTO community_rules')) {
          if (failRuleInsert) {
            throw new Error('Simulated item insert failure');
          }
          for (let index = 0; index < values.length; index += 5) {
            const [id, documentId, position, title, body] = values.slice(
              index,
              index + 5,
            ) as [string, string, number, string, string | null];
            pending!.rules.push({
              id,
              document_id: documentId,
              position,
              title,
              body,
            });
          }
          return [{ affectedRows: values.length / 5 }, []];
        }

        throw new Error(`Unexpected SQL query: ${sql}`);
      };
    };

    const pool = {
      execute: createExecutor(),
      getConnection: () => {
        const pending = {
          documents: [] as TestDocument[],
          rules: [] as TestRule[],
        };
        const end = () => {
          for (const document of pending.documents) {
            reservedVersions.delete(
              `${document.community_id}:${document.version}`,
            );
          }
          pending.documents = [];
          pending.rules = [];
          return Promise.resolve();
        };
        return Promise.resolve({
          execute: createExecutor(pending),
          beginTransaction: () => Promise.resolve(),
          commit: () => {
            documents.push(...pending.documents);
            ruleRows.push(...pending.rules);
            return end();
          },
          rollback: end,
          release: () => undefined,
        });
      },
    };

    const rateLimitService = {
      enforceApiRequest: (_ip: string, method: string, path: string) => {
        rateLimitCalls.push({ method, path });
        return Promise.resolve(null);
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(AuthRateLimitService)
      .useValue(rateLimitService)
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            tokenUsers[token]
              ? { kind: 'valid', userId: tokenUsers[token] }
              : { kind: 'invalid' },
          ),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalInterceptors(
      new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
    );
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

  const publish = (body: unknown, token = 'creator-token') =>
    request(server())
      .put('/communities/gardening/rules')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  it('reads an empty document without a token and 404s an unknown community', async () => {
    const empty = await request(server())
      .get('/communities/gardening/rules')
      .expect(200);
    expect(empty.body).toEqual({
      version: null,
      published_at: null,
      items: [],
    });

    const history = await request(server())
      .get('/communities/gardening/rules/versions')
      .expect(200);
    expect(history.body).toEqual({ items: [], page: 1, limit: 20, total: 0 });

    await request(server()).get('/communities/missing/rules').expect(404);
    await request(server())
      .get('/communities/missing/rules/versions')
      .expect(404);
    await request(server())
      .get('/communities/missing/rules/versions/1')
      .expect(404);
    await request(server()).get('/communities/bad%20name/rules').expect(400);
  });

  it('publishes as the creator and round-trips the document', async () => {
    const published = await publish({
      items: [
        { title: '  Be civil ', body: 'No personal attacks.' },
        { title: 'No spam', body: '  \n ' },
      ],
    }).expect(200);

    const expected = {
      version: 1,
      published_at: '2026-10-22T08:01:00.000Z',
      items: [
        { position: 1, title: 'Be civil', body: 'No personal attacks.' },
        { position: 2, title: 'No spam', body: null },
      ],
    };
    expect(published.body).toEqual(expected);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      community_id: 'community-a',
      version: 1,
      published_by: 'creator',
    });
    expect(ruleRows.map((rule) => [rule.position, rule.body])).toEqual([
      [1, 'No personal attacks.'],
      [2, null],
    ]);

    const current = await request(server())
      .get('/communities/gardening/rules')
      .expect(200);
    expect(current.body).toEqual(expected);
    const byVersion = await request(server())
      .get('/communities/gardening/rules/versions/1')
      .expect(200);
    expect(byVersion.body).toEqual(expected);
  });

  it('keeps earlier versions unchanged and lists history newest first', async () => {
    const v1 = await publish(rules('Be kind', 'No spam')).expect(200);
    const v1Rows = structuredClone(ruleRows);
    const v1Document = structuredClone(documents[0]);

    const unchanged = await publish(rules('Be kind', 'No spam')).expect(200);
    expect(unchanged.body).toEqual(v1.body);
    expect(documents).toHaveLength(1);

    const reordered = await publish(rules('No spam', 'Be kind')).expect(200);
    expect((reordered.body as RulesBody).version).toBe(2);
    const v3 = await publish(rules('Only rule')).expect(200);
    expect((v3.body as RulesBody).version).toBe(3);

    expect(documents[0]).toEqual(v1Document);
    expect(
      ruleRows.filter((rule) => rule.document_id === v1Document.id),
    ).toEqual(v1Rows);
    const oldVersion = await request(server())
      .get('/communities/gardening/rules/versions/1')
      .expect(200);
    expect(oldVersion.body).toEqual(v1.body);

    usernames.delete('creator');
    documents[1].published_by = null;
    const history = await request(server())
      .get('/communities/gardening/rules/versions?page=1&limit=2')
      .expect(200);
    expect(history.body).toEqual({
      items: [
        {
          version: 3,
          published_at: (v3.body as RulesBody).published_at,
          published_by_username: null,
          rule_count: 1,
        },
        {
          version: 2,
          published_at: (reordered.body as RulesBody).published_at,
          published_by_username: null,
          rule_count: 2,
        },
      ],
      page: 1,
      limit: 2,
      total: 3,
    });

    const secondPage = await request(server())
      .get('/communities/gardening/rules/versions?page=2&limit=2')
      .expect(200);
    expect(
      (secondPage.body as HistoryBody).items.map((item) => item.version),
    ).toEqual([1]);

    await request(server())
      .get('/communities/gardening/rules/versions/4')
      .expect(404);
  });

  it.each(['0', '-1', 'abc', '1.5', '4294967296'])(
    'rejects version %p with 400',
    async (version) => {
      await request(server())
        .get(`/communities/gardening/rules/versions/${version}`)
        .expect(400);
    },
  );

  it.each([
    'page=0',
    'page=10001',
    'limit=0',
    'limit=101',
    'page=one',
    'unexpected=1',
  ])('rejects history query %p with 400', async (query) => {
    await request(server())
      .get(`/communities/gardening/rules/versions?${query}`)
      .expect(400);
  });

  it('enforces authentication and creator-only authorization', async () => {
    await request(server())
      .put('/communities/gardening/rules')
      .send(rules('A'))
      .expect(401);
    await publish(rules('A'), 'moderator-token').expect(403);
    await publish(rules('A'), 'member-token').expect(403);
    await request(server())
      .put('/communities/cooking/rules')
      .set('Authorization', 'Bearer creator-token')
      .send(rules('A'))
      .expect(403);
    await request(server())
      .put('/communities/missing/rules')
      .set('Authorization', 'Bearer member-token')
      .send(rules('A'))
      .expect(404);
    expect(documents).toHaveLength(0);
  });

  it.each([
    ['zero items', { items: [] }],
    [
      'more than 50 items',
      { items: Array.from({ length: 51 }, () => ({ title: 'A' })) },
    ],
    ['a missing title', { items: [{ body: 'x' }] }],
    ['a blank title', { items: [{ title: '  ' }] }],
    ['a long title', { items: [{ title: 'x'.repeat(201) }] }],
    ['a long body', { items: [{ title: 'A', body: 'x'.repeat(4001) }] }],
    ['a control character', { items: [{ title: 'A\u0000' }] }],
    ['a position', { items: [{ title: 'A', position: 1 }] }],
    ['an unknown property', { items: [{ title: 'A' }], version: 1 }],
  ])('rejects %s with 400 and writes nothing', async (_, body) => {
    await publish(body).expect(400);
    expect(documents).toHaveLength(0);
    expect(ruleRows).toHaveLength(0);
  });

  it('lets exactly one of two concurrent publishes win', async () => {
    await publish(rules('Original')).expect(200);

    // Hold both requests after their hash check until both have read v1.
    let waiting = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeCurrentRead = () => {
      waiting += 1;
      if (waiting === 2) {
        release();
      }
      return bothRead;
    };

    const responses = await Promise.all([
      publish(rules('First')),
      publish(rules('Second')),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(documents.map((document) => document.version)).toEqual([1, 2]);
    expect(ruleRows).toHaveLength(2);
  });

  it('rolls back the document when inserting items fails', async () => {
    failRuleInsert = true;
    await publish(rules('A')).expect(500);
    expect(documents).toHaveLength(0);
    expect(ruleRows).toHaveLength(0);

    await request(server())
      .get('/communities/gardening/rules')
      .expect(200, { version: null, published_at: null, items: [] });
  });

  it('never returns private fields and stays rate limited', async () => {
    const responses = [
      await publish(rules('A')),
      await request(server()).get('/communities/gardening/rules'),
      await request(server()).get('/communities/gardening/rules/versions'),
      await request(server()).get('/communities/gardening/rules/versions/1'),
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.text).not.toMatch(
        /email|password|private-hash|private-token|token/i,
      );
    }
    expect(rateLimitCalls).toEqual([
      { method: 'PUT', path: '/communities/gardening/rules' },
      { method: 'GET', path: '/communities/gardening/rules' },
      { method: 'GET', path: '/communities/gardening/rules/versions' },
      { method: 'GET', path: '/communities/gardening/rules/versions/1' },
    ]);
  });
});
