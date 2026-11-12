import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import {
  ADMIN_COMMUNITY_DETAIL_SQL,
  AdminCommunitiesService,
} from './admin-communities.service';
import type { AuditLogService } from './audit-log.service';
import {
  AdminUpdateCommunityDto,
  ListAdminCommunitiesDto,
} from './dto/admin-communities.dto';

type Call = { sql: string; values: unknown[] };

describe('AdminCommunitiesService', () => {
  let calls: Call[];
  let pageRows: Array<Record<string, unknown>>;
  let detailRow: Record<string, unknown> | undefined;
  let locked: Record<string, unknown> | undefined;
  let audits: Array<{ connection: unknown; entry: unknown }>;
  let failAudit: boolean;
  let tx: { commits: number; rollbacks: number; releases: number };
  let connection: Record<string, unknown>;
  let service: AdminCommunitiesService;

  const community = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: `community-${id}`,
    description: 'About it',
    creator_username: 'creator',
    created_at: '2026-01-01T00:00:00Z',
    suspended_at: null,
    deleted_at: null,
    ...overrides,
  });

  const answer = (sql: string, values: unknown[]): [unknown, unknown] => {
    calls.push({ sql, values });
    if (sql === ADMIN_COMMUNITY_DETAIL_SQL) {
      return [detailRow ? [detailRow] : [], []];
    }
    if (sql.startsWith('SELECT COUNT(*) AS total')) {
      return [[{ total: 42 }], []];
    }
    if (
      sql.startsWith(
        'SELECT community_id, COUNT(*) AS total FROM community_subscriptions',
      )
    ) {
      return [
        values.map((id, index) => ({ community_id: id, total: index + 10 })),
        [],
      ];
    }
    if (sql.startsWith('SELECT community_id, COUNT(*) AS total FROM posts')) {
      // A community with no posts is absent from the grouped result.
      return [
        values.slice(1).map((id) => ({ community_id: id, total: '3' })),
        [],
      ];
    }
    if (sql.startsWith('SELECT id, name FROM communities')) {
      return [locked ? [locked] : [], []];
    }
    if (sql.startsWith('UPDATE communities')) {
      return [{ affectedRows: 1 }, []];
    }
    return [pageRows, []];
  };

  beforeEach(() => {
    calls = [];
    pageRows = [];
    detailRow = undefined;
    locked = { id: 'c-1', name: 'a-community' };
    audits = [];
    failAudit = false;
    tx = { commits: 0, rollbacks: 0, releases: 0 };
    connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        tx.commits += 1;
        return Promise.resolve();
      },
      rollback: () => {
        tx.rollbacks += 1;
        return Promise.resolve();
      },
      release: () => {
        tx.releases += 1;
      },
      execute: (sql: string, values: unknown[]) =>
        Promise.resolve(answer(sql, values)),
    };
    service = new AdminCommunitiesService(
      {
        execute: (sql: string, values: unknown[]) =>
          Promise.resolve(answer(sql, values)),
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      {
        record: (onConnection: unknown, entry: unknown) => {
          audits.push({ connection: onConnection, entry });
          return failAudit
            ? Promise.reject(new Error('Audit insert failed'))
            : Promise.resolve();
        },
      } as unknown as AuditLogService,
    );
  });

  const list = (query: Partial<ListAdminCommunitiesDto> = {}) =>
    service.findAll(Object.assign(new ListAdminCommunitiesDto(), query));
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const page = () => calls[0];
  const count = () => calls[1];
  const whereOf = (sql: string) => {
    const text = flat(sql);
    const start = text.indexOf(' WHERE ');
    if (start < 0) return '';
    const end = text.indexOf(' ORDER BY');
    return text.slice(start, end < 0 ? undefined : end);
  };

  describe('findAll', () => {
    it('lists every community by default, with no state predicate', async () => {
      const result = await list();
      expect(whereOf(page().sql)).toBe('');
      expect(whereOf(count().sql)).toBe('');
      expect(page().values).toEqual([20, 0]);
      expect(result.filters).toEqual({
        search: null,
        creator_username: null,
        state: 'any',
        sort: 'new',
      });
    });

    it.each([
      ['active', ' WHERE c.deleted_at IS NULL AND c.suspended_at IS NULL'],
      [
        'suspended',
        ' WHERE c.suspended_at IS NOT NULL AND c.deleted_at IS NULL',
      ],
      ['deleted', ' WHERE c.deleted_at IS NOT NULL'],
    ] as const)('filters state=%s in page and count', async (state, where) => {
      await list({ state });
      expect(whereOf(page().sql)).toBe(where);
      expect(whereOf(count().sql)).toBe(where);
    });

    it('searches name and description case-insensitively, escaping LIKE wildcards', async () => {
      await list({ search: '  50%_off=  ' });
      expect(whereOf(page().sql)).toBe(
        " WHERE (LOWER(c.name) LIKE LOWER(?) ESCAPE '=' OR LOWER(c.description) LIKE LOWER(?) ESCAPE '=')",
      );
      expect(count().values).toEqual(['%50=%=_off==%', '%50=%=_off==%']);
    });

    it('filters on the creator through the left join', async () => {
      await list({ creator_username: 'some_creator', state: 'active' });
      expect(whereOf(page().sql)).toBe(
        ' WHERE creator.username = ? AND c.deleted_at IS NULL AND c.suspended_at IS NULL',
      );
      expect(flat(page().sql)).toContain(
        'LEFT JOIN users creator ON creator.id = c.creator_id',
      );
      expect(count().values).toEqual(['some_creator']);
    });

    it('orders newest or oldest first with an id tiebreaker, and pages', async () => {
      await list({ page: 3, limit: 15 });
      expect(flat(page().sql)).toMatch(
        /ORDER BY c\.created_at DESC, c\.id DESC LIMIT \? OFFSET \?$/,
      );
      expect(page().values).toEqual([15, 30]);
      calls = [];
      await list({ sort: 'oldest' });
      expect(flat(page().sql)).toContain('ORDER BY c.created_at ASC, c.id ASC');
    });

    // Grouped queries bounded to the page's ids, never a subquery per row.
    it.each([1, 5, 100])(
      'issues the same four statements for a page of %d',
      async (size) => {
        pageRows = Array.from({ length: size }, (_, index) =>
          community(`c-${index}`),
        );
        await list({ limit: 100 });
        expect(calls).toHaveLength(4);
        const grouped = calls.slice(2);
        for (const { sql, values } of grouped) {
          expect(flat(sql)).toMatch(
            /^SELECT community_id, COUNT\(\*\) AS total FROM (community_subscriptions|posts) WHERE community_id IN \((\?, )*\?\) GROUP BY community_id$/,
          );
          expect(values).toEqual(pageRows.map((row) => row.id));
        }
        expect(flat(page().sql)).not.toMatch(/\(SELECT COUNT/);
      },
    );

    it('issues no aggregate query for an empty page', async () => {
      const result = await list();
      expect(calls).toHaveLength(2);
      expect(result.items).toEqual([]);
    });

    it('maps each item, with 0 for a community absent from a count', async () => {
      pageRows = [
        community('c-a', {
          creator_username: null,
          deleted_at: '2026-02-01T00:00:00Z',
        }),
        community('c-b', { suspended_at: '2026-03-01T00:00:00Z' }),
      ];
      const { items, total } = await list();
      expect(total).toBe(42);
      expect(items).toEqual([
        {
          id: 'c-a',
          name: 'community-c-a',
          description: 'About it',
          creator_username: null,
          created_at: '2026-01-01T00:00:00.000Z',
          suspended_at: null,
          deleted_at: '2026-02-01T00:00:00.000Z',
          member_count: 10,
          post_count: 0,
        },
        {
          id: 'c-b',
          name: 'community-c-b',
          description: 'About it',
          creator_username: 'creator',
          created_at: '2026-01-01T00:00:00.000Z',
          suspended_at: '2026-03-01T00:00:00.000Z',
          deleted_at: null,
          member_count: 11,
          post_count: 3,
        },
      ]);
    });

    it('shows a deleted creator as null, never the placeholder username', async () => {
      await list();
      expect(flat(page().sql)).toContain(
        'CASE WHEN creator.deleted_at IS NULL THEN creator.username END AS creator_username',
      );
    });

    it('never selects an email or password', async () => {
      pageRows = [community('c-a')];
      await list({ search: 'x', creator_username: 'abc' });
      await service.findOne('c-a').catch(() => undefined);
      for (const { sql } of calls) {
        expect(sql).not.toMatch(/email|password/);
      }
    });
  });

  describe('findOne', () => {
    beforeEach(() => {
      detailRow = {
        ...community('c-1', {
          suspended_at: '2026-03-01T00:00:00Z',
          deleted_at: '2026-04-01T00:00:00Z',
        }),
        suspended_by_username: null,
        suspension_reason: 'Spam network',
        deleted_by_username: null,
        member_count: '7',
        post_count: 4,
        moderator_count: '2',
        comment_count: 9,
        rule_version: '3',
        open_report_count: '1',
      };
    });

    it('returns a suspended and deleted community with every detail field', async () => {
      await expect(service.findOne('c-1')).resolves.toEqual({
        id: 'c-1',
        name: 'community-c-1',
        description: 'About it',
        creator_username: 'creator',
        created_at: '2026-01-01T00:00:00.000Z',
        suspended_at: '2026-03-01T00:00:00.000Z',
        deleted_at: '2026-04-01T00:00:00.000Z',
        member_count: 7,
        post_count: 4,
        suspended_by_username: null,
        suspension_reason: 'Spam network',
        deleted_by_username: null,
        moderator_count: 2,
        comment_count: 9,
        rule_version: 3,
        open_report_count: 1,
      });
      expect(calls[0].values).toEqual(['c-1']);
      // No state filter: hidden communities are the point.
      expect(ADMIN_COMMUNITY_DETAIL_SQL).not.toMatch(
        /c\.(deleted|suspended)_at IS NULL/,
      );
    });

    it('returns null for a community without published rules', async () => {
      detailRow = { ...detailRow, rule_version: null };
      expect((await service.findOne('c-1')).rule_version).toBeNull();
    });

    it('reads each count from its own table, and reports as the queue shows them', () => {
      const sql = flat(ADMIN_COMMUNITY_DETAIL_SQL);
      expect(sql).toContain(
        "FROM user_reports ur WHERE ur.target_type = 'community' AND ur.target_id = c.id AND ur.status IN ('open', 'under_review') AND ur.withdrawn_at IS NULL",
      );
      expect(sql).toContain(
        'SELECT MAX(d.version) FROM community_rule_documents d',
      );
      expect(sql).toContain(
        'FROM community_moderators m WHERE m.community_id = c.id',
      );
      for (const alias of ['creator', 'suspender', 'deleter']) {
        expect(sql).toContain(
          `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.username END`,
        );
        expect(sql).toMatch(new RegExp(`LEFT JOIN users ${alias} ON`));
      }
    });

    it('answers an unknown id with 404', async () => {
      detailRow = undefined;
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    const update = (body: Partial<AdminUpdateCommunityDto>) =>
      service.update('c-1', body as AdminUpdateCommunityDto, 'admin-id');

    beforeEach(() => {
      detailRow = {
        ...community('c-1'),
        suspended_by_username: null,
        suspension_reason: null,
        deleted_by_username: null,
        member_count: 0,
        post_count: 0,
        moderator_count: 0,
        comment_count: 0,
        rule_version: null,
        open_report_count: 0,
      };
    });

    it('locks the row, sets only the description, audits, and returns the detail', async () => {
      const result = await update({ description: 'Corrected' });
      expect(calls[0].sql).toBe(
        'SELECT id, name FROM communities WHERE id = ? LIMIT 1 FOR UPDATE',
      );
      const writes = calls.filter(({ sql }) => sql.startsWith('UPDATE'));
      expect(writes).toEqual([
        {
          sql: 'UPDATE communities SET description = ? WHERE id = ?',
          values: ['Corrected', 'c-1'],
        },
      ]);
      expect(audits).toEqual([
        {
          connection,
          entry: {
            actorId: 'admin-id',
            action: 'community_updated',
            targetType: 'community',
            targetId: 'c-1',
            metadata: { community_name: 'a-community', fields: 'description' },
          },
        },
      ]);
      expect(result.id).toBe('c-1');
      expect(tx).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
    });

    it('stores an empty (trimmed) description as NULL', async () => {
      await update({ description: '' });
      expect(calls.find(({ sql }) => sql.startsWith('UPDATE'))!.values).toEqual(
        [null, 'c-1'],
      );
    });

    it('answers an unknown id with 404, writing nothing', async () => {
      locked = undefined;
      await expect(update({ description: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(calls.some(({ sql }) => sql.startsWith('UPDATE'))).toBe(false);
      expect(audits).toHaveLength(0);
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });

    it('rolls the change back when the audit entry cannot be written', async () => {
      failAudit = true;
      await expect(update({ description: 'x' })).rejects.toThrow(
        'Audit insert failed',
      );
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });
});

describe('AdminCommunitiesService suspension', () => {
  let calls: Array<{ sql: string; values: unknown[] }>;
  let locked: Record<string, unknown> | undefined;
  let updateAffected: number;
  let nameRow: Record<string, unknown> | undefined;
  let audits: Array<{ connection: unknown; entry: unknown }>;
  let failAudit: boolean;
  let tx: { commits: number; rollbacks: number; releases: number };
  let connection: Record<string, unknown>;
  let service: AdminCommunitiesService;

  const detail = {
    id: 'c-1',
    name: 'garden',
    description: null,
    creator_username: 'creator',
    created_at: '2026-01-01T00:00:00Z',
    suspended_at: '2026-11-01T00:00:00Z',
    deleted_at: null,
    suspended_by_username: 'admin',
    suspension_reason: 'Spam network',
    deleted_by_username: null,
    member_count: 3,
    post_count: 2,
    moderator_count: 1,
    comment_count: 4,
    rule_version: null,
    open_report_count: 0,
  };

  beforeEach(() => {
    calls = [];
    locked = {
      id: 'c-1',
      name: 'garden',
      suspended_at: null,
      deleted_at: null,
    };
    updateAffected = 1;
    nameRow = { name: 'garden' };
    audits = [];
    failAudit = false;
    tx = { commits: 0, rollbacks: 0, releases: 0 };
    connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        tx.commits += 1;
        return Promise.resolve();
      },
      rollback: () => {
        tx.rollbacks += 1;
        return Promise.resolve();
      },
      release: () => {
        tx.releases += 1;
      },
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT id, name, suspended_at, deleted_at')) {
          return Promise.resolve([locked ? [locked] : [], []]);
        }
        if (sql.startsWith('UPDATE communities')) {
          return Promise.resolve([{ affectedRows: updateAffected }, []]);
        }
        if (sql === 'SELECT name FROM communities WHERE id = ? LIMIT 1') {
          return Promise.resolve([nameRow ? [nameRow] : [], []]);
        }
        if (sql === ADMIN_COMMUNITY_DETAIL_SQL) {
          return Promise.resolve([[detail], []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    service = new AdminCommunitiesService(
      { getConnection: () => Promise.resolve(connection) } as unknown as Pool,
      {
        record: (onConnection: unknown, entry: unknown) => {
          audits.push({ connection: onConnection, entry });
          return failAudit
            ? Promise.reject(new Error('Audit insert failed'))
            : Promise.resolve();
        },
      } as unknown as AuditLogService,
    );
  });

  const updates = () => calls.filter(({ sql }) => sql.startsWith('UPDATE'));
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  describe('suspend', () => {
    const suspend = () =>
      service.suspend('c-1', { reason: 'Spam network' }, 'admin-id');

    it('locks the row, sets all three columns from the clock and the token, and audits once', async () => {
      const result = await suspend();
      expect(calls[0].sql).toBe(
        'SELECT id, name, suspended_at, deleted_at FROM communities WHERE id = ? LIMIT 1 FOR UPDATE',
      );
      expect(updates()).toHaveLength(1);
      expect(flat(updates()[0].sql)).toBe(
        'UPDATE communities SET suspended_at = UTC_TIMESTAMP(), suspended_by = ?, suspension_reason = ? WHERE id = ? AND suspended_at IS NULL AND deleted_at IS NULL',
      );
      expect(updates()[0].values).toEqual(['admin-id', 'Spam network', 'c-1']);
      expect(audits).toEqual([
        {
          connection,
          entry: {
            actorId: 'admin-id',
            action: 'community_suspended',
            targetType: 'community',
            targetId: 'c-1',
            metadata: { community_name: 'garden', reason: 'Spam network' },
          },
        },
      ]);
      expect(result).toMatchObject({
        id: 'c-1',
        suspension_reason: 'Spam network',
      });
      expect(tx).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
    });

    it.each([
      ['an unknown id', undefined, NotFoundException],
      [
        'an already suspended community, keeping the first decision',
        {
          id: 'c-1',
          name: 'garden',
          suspended_at: new Date(),
          deleted_at: null,
        },
        ConflictException,
      ],
      [
        'a soft-deleted community',
        {
          id: 'c-1',
          name: 'garden',
          suspended_at: null,
          deleted_at: new Date(),
        },
        ConflictException,
      ],
    ])('refuses %s, writing nothing', async (_name, row, error) => {
      locked = row;
      await expect(suspend()).rejects.toBeInstanceOf(error);
      expect(updates()).toHaveLength(0);
      expect(audits).toHaveLength(0);
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });

    // A suspension landing between the read and the update.
    it('answers 409 when the guarded update matches nothing', async () => {
      updateAffected = 0;
      await expect(suspend()).rejects.toBeInstanceOf(ConflictException);
      expect(audits).toHaveLength(0);
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });

    it('rolls the suspension back when the audit entry cannot be written', async () => {
      failAudit = true;
      await expect(suspend()).rejects.toThrow('Audit insert failed');
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });

    it('yields one suspension and one 409 for two concurrent calls', async () => {
      let suspended = false;
      let unlock: () => void = () => undefined;
      let held: Promise<void> | null = null;
      const concurrent = new AdminCommunitiesService(
        {
          getConnection: () => {
            let holds = false;
            const release = () => {
              if (holds) {
                holds = false;
                unlock();
              }
              return Promise.resolve();
            };
            return Promise.resolve({
              beginTransaction: () => Promise.resolve(),
              commit: release,
              rollback: release,
              release: () => undefined,
              execute: async (sql: string) => {
                if (sql.startsWith('SELECT id, name, suspended_at')) {
                  while (held) await held;
                  held = new Promise<void>((resolve) => {
                    unlock = () => {
                      held = null;
                      resolve();
                    };
                  });
                  holds = true;
                  return [
                    [
                      {
                        id: 'c-1',
                        name: 'garden',
                        suspended_at: suspended ? new Date() : null,
                        deleted_at: null,
                      },
                    ],
                    [],
                  ];
                }
                if (sql.startsWith('UPDATE communities')) {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  const changed = !suspended;
                  suspended = true;
                  return [{ affectedRows: changed ? 1 : 0 }, []];
                }
                return [[detail], []];
              },
            });
          },
        } as unknown as Pool,
        { record: () => Promise.resolve() } as unknown as AuditLogService,
      );
      const results = await Promise.allSettled([
        concurrent.suspend('c-1', { reason: 'A' }, 'admin-1'),
        concurrent.suspend('c-1', { reason: 'B' }, 'admin-2'),
      ]);
      expect(
        results.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )!;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
    });
  });

  describe('restore', () => {
    const restore = () =>
      service.restore('c-1', { restore_reason: 'Appeal upheld' }, 'admin-id');

    it('clears all three columns with a guarded update and audits once', async () => {
      await restore();
      expect(flat(updates()[0].sql)).toBe(
        'UPDATE communities SET suspended_at = NULL, suspended_by = NULL, suspension_reason = NULL WHERE id = ? AND suspended_at IS NOT NULL',
      );
      expect(updates()[0].values).toEqual(['c-1']);
      expect(audits).toEqual([
        {
          connection,
          entry: {
            actorId: 'admin-id',
            action: 'community_restored',
            targetType: 'community',
            targetId: 'c-1',
            metadata: {
              community_name: 'garden',
              restore_reason: 'Appeal upheld',
            },
          },
        },
      ]);
      expect(tx).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
    });

    it('tells 404 (unknown) from 409 (not suspended) when nothing was updated', async () => {
      updateAffected = 0;
      await expect(restore()).rejects.toBeInstanceOf(ConflictException);
      nameRow = undefined;
      await expect(restore()).rejects.toBeInstanceOf(NotFoundException);
      expect(audits).toHaveLength(0);
      expect(tx).toEqual({ commits: 0, rollbacks: 2, releases: 2 });
    });

    it('rolls the restoration back when the audit entry cannot be written', async () => {
      failAudit = true;
      await expect(restore()).rejects.toThrow('Audit insert failed');
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });
});
