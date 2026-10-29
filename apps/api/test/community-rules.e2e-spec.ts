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
  'outsider-token': 'outsider',
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
  let acceptanceClock: number;
  let acceptances: Array<{
    user_id: string;
    document_id: string;
    community_id: string;
    accepted_at: Date;
  }>;
  let statements: string[];

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
    acceptanceClock = Date.parse('2026-10-25T08:00:00.000Z');
    acceptances = [];
    statements = [];

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
        statements.push(sql);
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

        // CommunityRuleAcceptanceService.getState: the current document and
        // this user's acceptance of it.
        if (sql.includes('LEFT JOIN community_rule_acceptances a')) {
          const [userId, communityId] = values as [string, string];
          const current = visibleDocuments()
            .filter((document) => document.community_id === communityId)
            .sort((left, right) => right.version - left.version)[0];
          if (!current) {
            return [[], []];
          }
          const accepted = acceptances.find(
            (row) => row.user_id === userId && row.document_id === current.id,
          );
          return [
            [
              {
                document_id: current.id,
                version: current.version,
                accepted_at: accepted?.accepted_at ?? null,
              },
            ],
            [],
          ];
        }

        // getLatestAcceptance: the highest version this user accepted.
        if (sql.includes('FROM community_rule_acceptances a')) {
          const [userId, communityId] = values as [string, string];
          const latest = acceptances
            .filter(
              (row) =>
                row.user_id === userId && row.community_id === communityId,
            )
            .map((row) => ({
              version: visibleDocuments().find(
                (document) => document.id === row.document_id,
              )!.version,
              accepted_at: row.accepted_at,
            }))
            .sort((left, right) => right.version - left.version)[0];
          return [latest ? [{ ...latest, ...privateColumns }] : [], []];
        }

        // accept: INSERT ... SELECT that matches only the current version;
        // a duplicate keeps the original row and, with FOUND_ROWS, still
        // reports one affected row.
        if (sql.startsWith('INSERT INTO community_rule_acceptances')) {
          expect(sql).toContain('NOT EXISTS');
          expect(sql).toContain(
            'ON DUPLICATE KEY UPDATE accepted_at = accepted_at',
          );
          const [userId, communityId, version] = values as [
            string,
            string,
            number,
          ];
          const forCommunity = visibleDocuments().filter(
            (document) => document.community_id === communityId,
          );
          const document = forCommunity.find(
            (candidate) =>
              candidate.version === version &&
              !forCommunity.some((newer) => newer.version > version),
          );
          if (!document) {
            return [{ affectedRows: 0 }, []];
          }
          if (
            !acceptances.some(
              (row) =>
                row.user_id === userId && row.document_id === document.id,
            )
          ) {
            acceptanceClock += 60_000;
            acceptances.push({
              user_id: userId,
              document_id: document.id,
              community_id: document.community_id,
              accepted_at: new Date(acceptanceClock),
            });
          }
          return [{ affectedRows: 1 }, []];
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

  describe('acceptance', () => {
    const acceptancePath = '/communities/gardening/rules/acceptance';
    const getAcceptance = (token: string, path = acceptancePath) =>
      request(server()).get(path).set('Authorization', `Bearer ${token}`);
    const accept = (
      body: unknown,
      token = 'outsider-token',
      path = acceptancePath,
    ) =>
      request(server())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body as object);

    it('reports no acceptance needed for a community without rules', async () => {
      await getAcceptance('outsider-token').expect(200, {
        current_version: null,
        accepted_version: null,
        accepted_at: null,
        acceptance_required: false,
      });
    });

    it('answers 401, 400 and 404 for both routes', async () => {
      await request(server()).get(acceptancePath).expect(401);
      await request(server())
        .post(acceptancePath)
        .send({ version: 1 })
        .expect(401);
      await getAcceptance(
        'outsider-token',
        '/communities/missing/rules/acceptance',
      ).expect(404);
      await accept(
        { version: 1 },
        'outsider-token',
        '/communities/missing/rules/acceptance',
      ).expect(404);
      await getAcceptance(
        'outsider-token',
        '/communities/bad%20name/rules/acceptance',
      ).expect(400);
      await accept(
        { version: 1 },
        'outsider-token',
        '/communities/bad%20name/rules/acceptance',
      ).expect(400);
    });

    it('lets a non-member accept, 201 then 200, without creating membership', async () => {
      await publish(rules('Be kind')).expect(200);
      await getAcceptance('outsider-token').expect(200, {
        current_version: 1,
        accepted_version: null,
        accepted_at: null,
        acceptance_required: true,
      });

      const created = await accept({ version: 1 }).expect(201);
      expect(created.body).toEqual({
        current_version: 1,
        accepted_version: 1,
        accepted_at: '2026-10-25T08:01:00.000Z',
        acceptance_required: false,
      });
      expect(acceptances).toEqual([
        {
          user_id: 'outsider',
          document_id: documents[0].id,
          community_id: 'community-a',
          accepted_at: new Date('2026-10-25T08:01:00.000Z'),
        },
      ]);

      const repeated = await accept({ version: 1 }).expect(200);
      expect(repeated.body).toEqual(created.body);
      expect(acceptances).toHaveLength(1);
      expect(acceptances[0].accepted_at).toEqual(
        new Date('2026-10-25T08:01:00.000Z'),
      );

      expect(
        statements.some((sql) => sql.includes('community_subscriptions')),
      ).toBe(false);
    });

    it.each([
      ['stale', 1],
      ['ahead', 3],
    ])(
      'refuses a %s version with 409 and writes nothing',
      async (_, version) => {
        await publish(rules('v1')).expect(200);
        await publish(rules('v2')).expect(200);

        const response = await accept({ version }).expect(409);
        expect((response.body as { message: string }).message).toBe(
          `Version ${version} is not the current rules version (2)`,
        );
        expect(acceptances).toHaveLength(0);
      },
    );

    it('refuses with a distinct 409 when there are no rules to accept', async () => {
      const response = await accept({ version: 1 }).expect(409);

      expect((response.body as { message: string }).message).toBe(
        'This community has no published rules to accept',
      );
      expect(acceptances).toHaveLength(0);
    });

    it.each([
      {},
      { version: 0 },
      { version: -1 },
      { version: 1.5 },
      { version: '1' },
      { version: null },
      { version: 1, user_id: 'creator' },
      { version: 1, community_id: 'community-b' },
    ])('rejects body %o with 400 and writes nothing', async (body) => {
      await publish(rules('Be kind')).expect(200);

      await accept(body).expect(400);
      expect(acceptances).toHaveLength(0);
    });

    it('requires reacceptance after a new version and keeps the old row', async () => {
      await publish(rules('v1')).expect(200);
      await accept({ version: 1 }, 'member-token').expect(201);
      const v1Row = { ...acceptances[0] };

      await publish(rules('v1', 'v2 addition')).expect(200);
      await getAcceptance('member-token').expect(200, {
        current_version: 2,
        accepted_version: 1,
        accepted_at: v1Row.accepted_at.toISOString(),
        acceptance_required: true,
      });

      const v2 = await accept({ version: 2 }, 'member-token').expect(201);
      expect(v2.body).toMatchObject({
        current_version: 2,
        accepted_version: 2,
        acceptance_required: false,
      });
      expect(acceptances).toHaveLength(2);
      expect(acceptances[0]).toEqual(v1Row);
    });

    it('does not require reacceptance after a no-op republish', async () => {
      await publish(rules('Be kind', 'No spam')).expect(200);
      await accept({ version: 1 }, 'member-token').expect(201);

      const republished = await publish(rules('Be kind', 'No spam')).expect(
        200,
      );
      expect((republished.body as RulesBody).version).toBe(1);
      expect(documents).toHaveLength(1);
      await getAcceptance('member-token').expect(200, {
        current_version: 1,
        accepted_version: 1,
        accepted_at: acceptances[0].accepted_at.toISOString(),
        acceptance_required: false,
      });
    });

    it('keeps each account isolated to its own acceptance', async () => {
      await publish(rules('Be kind')).expect(200);
      await accept({ version: 1 }, 'member-token').expect(201);

      await getAcceptance('outsider-token').expect(200, {
        current_version: 1,
        accepted_version: null,
        accepted_at: null,
        acceptance_required: true,
      });
      await accept({ version: 1, user_id: 'member' }, 'outsider-token').expect(
        400,
      );
      expect(acceptances.map((row) => row.user_id)).toEqual(['member']);
    });

    it('never returns private fields and stays rate limited', async () => {
      await publish(rules('Be kind')).expect(200);
      rateLimitCalls = [];

      const responses = [
        await getAcceptance('outsider-token'),
        await accept({ version: 1 }),
        await accept({ version: 1 }),
      ];

      expect(responses.map((response) => response.status)).toEqual([
        200, 201, 200,
      ]);
      for (const response of responses) {
        expect(response.text).not.toMatch(
          /email|password|private-hash|private-token|token|session/i,
        );
      }
      expect(rateLimitCalls).toEqual([
        { method: 'GET', path: acceptancePath },
        { method: 'POST', path: acceptancePath },
        { method: 'POST', path: acceptancePath },
      ]);
    });
  });
});
