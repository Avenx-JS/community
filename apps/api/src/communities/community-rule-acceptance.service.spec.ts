import { Test, TestingModule } from '@nestjs/testing';
import type { PoolConnection } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';

type Query = { sql: string; values: unknown[] };

function fakeExecutor(queries: Query[], results: unknown[]) {
  return {
    execute: (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve([results.shift() ?? [], []]);
    },
  };
}

describe('CommunityRuleAcceptanceService', () => {
  let service: CommunityRuleAcceptanceService;
  let queries: Query[];
  let results: unknown[];

  beforeEach(async () => {
    queries = [];
    results = [];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityRuleAcceptanceService,
        { provide: MYSQL_POOL, useValue: fakeExecutor(queries, results) },
      ],
    }).compile();
    service = module.get(CommunityRuleAcceptanceService);
  });

  it('requires nothing when the community has no published rules', async () => {
    results.push([]);

    await expect(service.getState('user-1', 'community-1')).resolves.toEqual({
      currentVersion: null,
      currentDocumentId: null,
      acceptedAt: null,
      acceptanceRequired: false,
    });
  });

  it('requires acceptance of an unaccepted current document', async () => {
    results.push([{ document_id: 'doc-2', version: 2, accepted_at: null }]);

    await expect(service.getState('user-1', 'community-1')).resolves.toEqual({
      currentVersion: 2,
      currentDocumentId: 'doc-2',
      acceptedAt: null,
      acceptanceRequired: true,
    });
    expect(queries[0].sql).toContain('ORDER BY d.version DESC');
    expect(queries[0].sql).not.toContain('published_at');
    expect(queries[0].sql).toContain('a.user_id = ?');
    expect(queries[0].values).toEqual(['user-1', 'community-1']);
  });

  it('requires nothing once the current document is accepted', async () => {
    results.push([
      {
        document_id: 'doc-2',
        version: 2,
        accepted_at: new Date('2026-10-28T09:00:00.000Z'),
      },
    ]);

    await expect(service.getState('user-1', 'community-1')).resolves.toEqual({
      currentVersion: 2,
      currentDocumentId: 'doc-2',
      acceptedAt: '2026-10-28T09:00:00.000Z',
      acceptanceRequired: false,
    });
  });

  it('requires acceptance again when a newer version is published', async () => {
    // The query joins the acceptance of the current (highest) version only,
    // so an acceptance of v1 does not carry over to v2.
    results.push(
      [{ document_id: 'doc-1', version: 1, accepted_at: new Date() }],
      [{ document_id: 'doc-2', version: 2, accepted_at: null }],
      [{ document_id: 'doc-2', version: 2, accepted_at: new Date() }],
    );

    expect((await service.getState('u', 'c')).acceptanceRequired).toBe(false);
    expect(await service.getState('u', 'c')).toMatchObject({
      currentVersion: 2,
      acceptanceRequired: true,
    });
    expect((await service.getState('u', 'c')).acceptanceRequired).toBe(false);
  });

  it('derives the document and community in the insert and reports matches', async () => {
    results.push({ affectedRows: 1 });

    await expect(service.accept('user-1', 'community-1', 3)).resolves.toBe(
      true,
    );
    expect(queries[0].sql).toContain(
      'SELECT ?, d.id, d.community_id\n       FROM community_rule_documents d\n       WHERE d.community_id = ? AND d.version = ?',
    );
    expect(queries[0].sql).toContain(
      'ON DUPLICATE KEY UPDATE accepted_at = accepted_at',
    );
    expect(queries[0].sql).not.toMatch(
      /accepted_at\)\s*SELECT|UTC_TIMESTAMP|NOW\(/,
    );
    expect(queries[0].values).toEqual(['user-1', 'community-1', 3]);
  });

  it('reports an unknown community and version pair', async () => {
    results.push({ affectedRows: 0 });

    await expect(service.accept('user-1', 'community-1', 9)).resolves.toBe(
      false,
    );
  });

  it('runs on the given connection instead of the pool', async () => {
    const connectionQueries: Query[] = [];
    const connection = fakeExecutor(connectionQueries, [
      [],
      { affectedRows: 1 },
    ]) as unknown as PoolConnection;

    await service.getState('user-1', 'community-1', connection);
    await service.accept('user-1', 'community-1', 1, connection);

    expect(connectionQueries).toHaveLength(2);
    expect(queries).toHaveLength(0);
  });
});
