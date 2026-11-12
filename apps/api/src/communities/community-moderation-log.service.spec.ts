import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { canModerateCommunitySql } from '../common/community-moderation';
import {
  buildCommunityModerationMetadata,
  COMMUNITY_MODERATION_ACTIONS,
  CommunityModerationEntry,
  CommunityModerationLogService,
} from './community-moderation-log.service';
import { ListCommunityModerationActionsDto } from './dto/list-community-moderation-actions.dto';

const actorRow = [{ username: 'moderator' }];

type Execute = (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;

function fakeConnection(
  execute: Execute = () => Promise.resolve([[], []]),
  release = () => undefined,
): PoolConnection {
  return { execute, release } as unknown as PoolConnection;
}

function allTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return allTypeScriptFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

async function createService(pool: unknown) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CommunityModerationLogService,
      { provide: MYSQL_POOL, useValue: pool },
    ],
  }).compile();
  return module.get<CommunityModerationLogService>(
    CommunityModerationLogService,
  );
}

const base = { actorId: 'moderator-1', communityId: 'community-1' };

// Keys a caller might carelessly pass through; none may be stored.
const leaked = {
  body: 'the removed post body',
  content: 'the removed comment content',
  title: 'the removed post title',
  description: 'the edited community description',
  name: 'renamed_community',
  url: 'https://example.com/removed',
  email: 'private@example.com',
  password_hash: 'private-hash',
  token: 'secret-token',
  session_id: 'private-session',
  unexpected: 'discard me',
};

describe('CommunityModerationLogService', () => {
  let service: CommunityModerationLogService;

  beforeEach(async () => {
    service = await createService({
      getConnection: () => Promise.resolve(fakeConnection()),
    });
  });

  describe('buildCommunityModerationMetadata', () => {
    const cases: Array<
      [CommunityModerationEntry, Record<string, unknown> | null]
    > = [
      [
        {
          ...base,
          action: 'post_locked',
          targetType: 'post',
          targetId: 'post-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'post_unlocked',
          targetType: 'post',
          targetId: 'post-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'post_removed',
          targetType: 'post',
          targetId: 'post-1',
          metadata: { reason: 'Off-topic' },
        },
        { reason: 'Off-topic' },
      ],
      [
        {
          ...base,
          action: 'post_restored',
          targetType: 'post',
          targetId: 'post-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'post_pinned',
          targetType: 'post',
          targetId: 'post-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'post_unpinned',
          targetType: 'post',
          targetId: 'post-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'comment_locked',
          targetType: 'comment',
          targetId: 'comment-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'comment_unlocked',
          targetType: 'comment',
          targetId: 'comment-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'comment_removed',
          targetType: 'comment',
          targetId: 'comment-1',
          metadata: { reason: 'Personal attack' },
        },
        { reason: 'Personal attack' },
      ],
      [
        {
          ...base,
          action: 'comment_restored',
          targetType: 'comment',
          targetId: 'comment-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'member_banned',
          targetType: 'user',
          targetId: 'user-1',
          metadata: {
            username: 'member_one',
            reason: 'Repeated spam',
            expires_at: '2026-12-01T00:00:00.000Z',
          },
        },
        {
          username: 'member_one',
          reason: 'Repeated spam',
          expires_at: '2026-12-01T00:00:00.000Z',
        },
      ],
      [
        {
          ...base,
          action: 'member_unbanned',
          targetType: 'user',
          targetId: 'user-1',
          metadata: { username: 'member_one' },
        },
        { username: 'member_one' },
      ],
      [
        {
          ...base,
          action: 'member_removed',
          targetType: 'user',
          targetId: 'user-1',
          metadata: { username: 'member_one', reason: 'Ban evasion' },
        },
        { username: 'member_one', reason: 'Ban evasion' },
      ],
      [
        {
          ...base,
          action: 'moderator_added',
          targetType: 'user',
          targetId: 'user-1',
          metadata: { username: 'member_one' },
        },
        { username: 'member_one' },
      ],
      [
        {
          ...base,
          action: 'moderator_removed',
          targetType: 'user',
          targetId: 'user-1',
          metadata: { username: 'member_one' },
        },
        { username: 'member_one' },
      ],
      [
        {
          ...base,
          action: 'rules_published',
          targetType: 'rule_document',
          targetId: 'document-1',
          metadata: { version: 3 },
        },
        { version: 3 },
      ],
      [
        {
          ...base,
          action: 'community_updated',
          targetType: 'community',
          targetId: 'community-1',
          metadata: { fields: 'description' },
        },
        { fields: 'description' },
      ],
      [
        {
          ...base,
          action: 'community_deleted',
          targetType: 'community',
          targetId: 'community-1',
        },
        null,
      ],
      [
        {
          ...base,
          action: 'report_approved',
          targetType: 'post',
          targetId: 'post-1',
          metadata: { reports: 3 },
        },
        { reports: 3 },
      ],
      [
        {
          ...base,
          action: 'report_removed',
          targetType: 'comment',
          targetId: 'comment-1',
          metadata: { reports: 1 },
        },
        { reports: 1 },
      ],
      [
        {
          ...base,
          action: 'moderator_invited',
          targetType: 'user',
          targetId: 'user-2',
          metadata: { username: 'sam_42' },
        },
        { username: 'sam_42' },
      ],
      [
        {
          ...base,
          action: 'moderator_invite_revoked',
          targetType: 'user',
          targetId: 'user-2',
          metadata: { username: 'sam_42' },
        },
        { username: 'sam_42' },
      ],
      [
        {
          ...base,
          action: 'moderator_invite_declined',
          targetType: 'user',
          targetId: 'user-2',
          metadata: { username: 'sam_42' },
        },
        { username: 'sam_42' },
      ],
      [
        {
          ...base,
          action: 'join_request_approved',
          targetType: 'user',
          targetId: 'user-2',
          metadata: { username: 'sam_42' },
        },
        { username: 'sam_42' },
      ],
      [
        {
          ...base,
          action: 'join_request_denied',
          targetType: 'user',
          targetId: 'user-2',
          metadata: { username: 'sam_42' },
        },
        { username: 'sam_42' },
      ],
    ];

    it('covers every declared action', () => {
      expect(cases.map(([entry]) => entry.action).sort()).toEqual(
        [...COMMUNITY_MODERATION_ACTIONS].sort(),
      );
    });

    it.each(cases)(
      'keeps only allowlisted metadata for %o',
      (entry, expected) => {
        const withLeaks = {
          ...entry,
          metadata: { ...entry.metadata, ...leaked },
        } as unknown as CommunityModerationEntry;

        const metadata = buildCommunityModerationMetadata(withLeaks);

        expect(metadata).toEqual(expected);
        expect(JSON.stringify(metadata)).not.toMatch(
          /removed post|removed comment|community description|renamed|example\.com|hash|token|session|unexpected/i,
        );
      },
    );

    // Migration 038: who could see the community, from when.
    it('keeps the new visibility of a settings change, and only an enum value', () => {
      expect(
        buildCommunityModerationMetadata({
          ...base,
          action: 'community_updated',
          targetType: 'community',
          targetId: 'community-1',
          metadata: { fields: 'visibility,nsfw', visibility: 'private' },
        }),
      ).toEqual({ fields: 'visibility,nsfw', visibility: 'private' });
      expect(() =>
        buildCommunityModerationMetadata({
          ...base,
          action: 'community_updated',
          targetType: 'community',
          targetId: 'community-1',
          metadata: {
            fields: 'visibility',
            visibility: 'secret',
          } as unknown as { fields: string },
        }),
      ).toThrow(TypeError);
    });

    it('never stores a submitted content body, even alongside a reason', () => {
      const metadata = buildCommunityModerationMetadata({
        ...base,
        action: 'post_removed',
        targetType: 'post',
        targetId: 'post-1',
        metadata: {
          reason: 'Spam',
          body: 'Buy cheap watches',
        } as unknown as { reason: string },
      });

      expect(metadata).toEqual({ reason: 'Spam' });
      expect(Object.keys(metadata ?? {})).not.toContain('body');
      expect(JSON.stringify(metadata)).not.toContain('watches');
    });

    it('returns null when no allowlisted key survives', () => {
      expect(
        buildCommunityModerationMetadata({
          ...base,
          action: 'post_removed',
          targetType: 'post',
          targetId: 'post-1',
          metadata: { body: 'content' } as unknown as { reason: string },
        }),
      ).toBeNull();
      expect(
        buildCommunityModerationMetadata({
          ...base,
          action: 'moderator_added',
          targetType: 'user',
          targetId: 'user-1',
          metadata: {},
        }),
      ).toBeNull();
    });

    it.each([['a string'], [42], [null], [['reason']]])(
      'throws on non-object metadata %p',
      (metadata) => {
        expect(() =>
          buildCommunityModerationMetadata({
            ...base,
            action: 'post_removed',
            targetType: 'post',
            targetId: 'post-1',
            metadata,
          } as unknown as CommunityModerationEntry),
        ).toThrow(
          new TypeError('Community moderation metadata must be an object'),
        );
      },
    );

    it.each([
      ['post_removed', 'post', { reason: 7 }, 'reason'],
      ['post_removed', 'post', { reason: '   ' }, 'reason'],
      ['post_removed', 'post', { reason: 'x'.repeat(2001) }, 'reason'],
      ['post_removed', 'post', { reason: 'bell\u0007' }, 'reason'],
      ['member_banned', 'user', { username: 'bad name' }, 'username'],
      ['member_banned', 'user', { expires_at: 'tomorrow' }, 'expires_at'],
      ['rules_published', 'rule_document', { version: 0 }, 'version'],
      ['rules_published', 'rule_document', { version: 1.5 }, 'version'],
      ['rules_published', 'rule_document', { version: '2' }, 'version'],
      ['community_updated', 'community', { fields: 'name' }, 'fields'],
      ['community_updated', 'community', { fields: 'rules' }, 'fields'],
      [
        'community_updated',
        'community',
        { fields: 'description,description' },
        'fields',
      ],
      ['community_updated', 'community', { fields: '' }, 'fields'],
      [
        'community_updated',
        'community',
        { fields: 'A new description' },
        'fields',
      ],
    ])(
      'rejects an invalid value for %s metadata %o',
      (action, targetType, metadata, key) => {
        expect(() =>
          buildCommunityModerationMetadata({
            ...base,
            action,
            targetType,
            targetId: 'target-1',
            metadata,
          } as unknown as CommunityModerationEntry),
        ).toThrow(`Invalid community moderation metadata field: ${key}`);
      },
    );
  });

  describe('record', () => {
    it('uses the supplied connection, snapshots the actor username, and inserts every column', async () => {
      const calls: Array<{ sql: string; values?: unknown[] }> = [];
      const connection = fakeConnection((sql, values) => {
        calls.push({ sql, values });
        return Promise.resolve(
          sql.startsWith('SELECT username')
            ? [actorRow, []]
            : [{ affectedRows: 1 }, []],
        );
      });

      await service.record(connection, {
        ...base,
        action: 'post_removed',
        targetType: 'post',
        targetId: 'post-1',
        metadata: { reason: 'Spam' },
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({
        sql: 'SELECT username FROM users WHERE id = ? LIMIT 1',
        values: ['moderator-1'],
      });
      expect(calls[1]?.sql).toContain(
        'INSERT INTO community_moderation_actions',
      );
      expect(calls[1]?.sql).not.toContain('created_at');
      expect(calls[1]?.values).toEqual([
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        'community-1',
        'moderator-1',
        'moderator',
        'post_removed',
        'post',
        'post-1',
        '{"reason":"Spam"}',
      ]);
    });

    it('stores NULL metadata when nothing survives the allowlist', async () => {
      const values: unknown[][] = [];
      const connection = fakeConnection((sql, params) => {
        values.push(params ?? []);
        return Promise.resolve(
          sql.startsWith('SELECT username') ? [actorRow, []] : [{}, []],
        );
      });

      await service.record(connection, {
        ...base,
        action: 'post_pinned',
        targetType: 'post',
        targetId: 'post-1',
      });

      expect(values[1]?.[7]).toBeNull();
    });

    it('throws and writes nothing when the actor cannot be resolved', async () => {
      const calls: string[] = [];
      const connection = fakeConnection((sql) => {
        calls.push(sql);
        return Promise.resolve([[], []]);
      });

      await expect(
        service.record(connection, {
          ...base,
          action: 'post_locked',
          targetType: 'post',
          targetId: 'post-1',
        }),
      ).rejects.toThrow('Community moderation actor could not be resolved');
      expect(calls).toHaveLength(1);
      expect(calls.some((sql) => sql.includes('INSERT'))).toBe(false);
    });

    it('throws on invalid metadata before inserting', async () => {
      const calls: string[] = [];
      const connection = fakeConnection((sql) => {
        calls.push(sql);
        return Promise.resolve([actorRow, []]);
      });

      await expect(
        service.record(connection, {
          ...base,
          action: 'rules_published',
          targetType: 'rule_document',
          targetId: 'document-1',
          metadata: { version: -1 },
        }),
      ).rejects.toThrow(TypeError);
      expect(calls.some((sql) => sql.includes('INSERT'))).toBe(false);
    });

    it('acquires and releases its own connection for standalone records', async () => {
      const calls: string[] = [];
      let released = 0;
      const connection = fakeConnection(
        (sql) => {
          calls.push(sql);
          return Promise.resolve(
            sql.startsWith('SELECT username')
              ? [actorRow, []]
              : [{ affectedRows: 1 }, []],
          );
        },
        () => {
          released += 1;
        },
      );
      const standalone = await createService({
        getConnection: () => Promise.resolve(connection),
      });

      await standalone.record({
        ...base,
        action: 'moderator_added',
        targetType: 'user',
        targetId: 'user-1',
        metadata: { username: 'member_one' },
      });

      expect(calls).toHaveLength(2);
      expect(released).toBe(1);
    });

    it('releases its own connection when the standalone insert fails', async () => {
      let released = 0;
      const connection = fakeConnection(
        () => Promise.resolve([[], []]),
        () => {
          released += 1;
        },
      );
      const standalone = await createService({
        getConnection: () => Promise.resolve(connection),
      });

      await expect(
        standalone.record({
          ...base,
          action: 'post_locked',
          targetType: 'post',
          targetId: 'post-1',
        }),
      ).rejects.toThrow('could not be resolved');
      expect(released).toBe(1);
    });

    it('throws TypeError when an entry is passed where a connection is expected', async () => {
      const entry: CommunityModerationEntry = {
        ...base,
        action: 'post_locked',
        targetType: 'post',
        targetId: 'post-1',
      };
      await expect(
        service.record(entry as unknown as PoolConnection, entry),
      ).rejects.toThrow(new TypeError('Expected a database connection'));
    });

    it('throws TypeError when a connection is passed where an entry is expected', async () => {
      await expect(
        service.record(fakeConnection() as unknown as CommunityModerationEntry),
      ).rejects.toThrow(new TypeError('Expected a community moderation entry'));
    });

    it('rolls back the caller action if writing its log entry fails', async () => {
      let committed = false;
      let inTransaction = false;
      const connection = {
        beginTransaction: () => Promise.resolve(),
        commit: () => {
          committed = inTransaction;
          return Promise.resolve();
        },
        rollback: () => {
          inTransaction = false;
          return Promise.resolve();
        },
        release: () => undefined,
        execute: (sql: string) => {
          if (sql.startsWith('SELECT username')) {
            return Promise.resolve([actorRow, []]);
          }
          if (sql.includes('INSERT INTO community_moderation_actions')) {
            return Promise.reject(new Error('Log insert failed'));
          }
          return Promise.resolve([[], []]);
        },
      } as unknown as PoolConnection;

      await connection.beginTransaction();
      inTransaction = true;
      try {
        await service.record(connection, {
          ...base,
          action: 'post_removed',
          targetType: 'post',
          targetId: 'post-1',
        });
        await connection.commit();
      } catch {
        await connection.rollback();
      } finally {
        connection.release();
      }

      expect(committed).toBe(false);
      expect(inTransaction).toBe(false);
    });

    it('writes exactly one row that is rolled back with the caller transaction', async () => {
      let rows = 0;
      let rowsBeforeFailure = 0;
      const connection = {
        beginTransaction: () => Promise.resolve(),
        commit: () => Promise.resolve(),
        rollback: () => {
          rows = 0;
          return Promise.resolve();
        },
        release: () => undefined,
        execute: (sql: string) => {
          if (sql.startsWith('SELECT username')) {
            return Promise.resolve([actorRow, []]);
          }
          if (sql.includes('INSERT INTO community_moderation_actions')) {
            rows += 1;
            return Promise.resolve([{ affectedRows: 1 }, []]);
          }
          return Promise.resolve([[], []]);
        },
      } as unknown as PoolConnection;

      await connection.beginTransaction();
      try {
        await service.record(connection, {
          ...base,
          action: 'post_removed',
          targetType: 'post',
          targetId: 'post-1',
        });
        rowsBeforeFailure = rows;
        throw new Error('Moderation action failed after the log insert');
      } catch {
        await connection.rollback();
      }

      expect(rowsBeforeFailure).toBe(1);
      expect(rows).toBe(0);
    });
  });

  describe('findAll', () => {
    let queries: Array<{ sql: string; values: unknown[] }>;
    let results: unknown[][];
    let reader: CommunityModerationLogService;

    beforeEach(async () => {
      queries = [];
      results = [];
      reader = await createService({
        execute: (sql: string, values: unknown[]) => {
          queries.push({ sql, values });
          return Promise.resolve([results.shift() ?? [], []]);
        },
      });
    });

    const query = (
      overrides: Partial<ListCommunityModerationActionsDto> = {},
    ) => Object.assign(new ListCommunityModerationActionsDto(), overrides);

    it('authorizes with the shared moderation predicate in one lookup', async () => {
      results = [[{ id: 'community-1', can_moderate: 1 }], [], [{ total: 0 }]];

      await reader.findAll('gardening', 'user-1', query());

      expect(queries[0]?.sql).toContain(canModerateCommunitySql('c.id'));
      expect(queries[0]?.values).toEqual(['user-1', 'user-1', 'gardening']);
    });

    it('answers 404 for an unknown community before any authorization check', async () => {
      results = [[]];

      await expect(
        reader.findAll('missing', 'user-1', query()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
    });

    it.each([[0], ['0'], [false]])(
      'answers 403 when the caller neither created nor moderates the community (%p)',
      async (canModerate) => {
        results = [[{ id: 'community-1', can_moderate: canModerate }]];

        await expect(
          reader.findAll('gardening', 'user-1', query()),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(queries).toHaveLength(1);
      },
    );

    it('scopes every read to the community, orders stably and never joins', async () => {
      results = [
        [{ id: 'community-1', can_moderate: '1' }],
        [
          {
            id: 'entry-1',
            action: 'post_removed',
            actor_username: 'departed_mod',
            target_type: 'post',
            target_id: 'deleted-post',
            metadata: '{"reason":"Spam"}',
            created_at: new Date('2026-10-01T12:00:00.000Z'),
          },
        ],
        [{ total: '41' }],
      ];

      const result = await reader.findAll(
        'gardening',
        'user-1',
        query({ page: 3, limit: 20 }),
      );

      const [, list, count] = queries;
      expect(list?.sql).toMatch(/WHERE community_id = \?/);
      expect(list?.sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(list?.sql).not.toMatch(/JOIN|FROM users|actor_id/i);
      expect(list?.values).toEqual(['community-1', 20, 40]);
      expect(count?.sql).toBe(
        'SELECT COUNT(*) AS total FROM community_moderation_actions WHERE community_id = ?',
      );
      expect(count?.values).toEqual(['community-1']);
      expect(result).toEqual({
        items: [
          {
            id: 'entry-1',
            action: 'post_removed',
            actor_username: 'departed_mod',
            target_type: 'post',
            target_id: 'deleted-post',
            metadata: { reason: 'Spam' },
            created_at: '2026-10-01T12:00:00.000Z',
          },
        ],
        page: 3,
        limit: 20,
        total: 41,
      });
    });

    it('applies every filter to both items and total, and reverses for oldest', async () => {
      results = [[{ id: 'community-1', can_moderate: 1 }], [], [{ total: 0 }]];

      await reader.findAll(
        'gardening',
        'user-1',
        query({
          action: 'member_banned',
          actor_username: 'mod_one',
          target_type: 'user',
          from: '2026-10-01T00:00:00+02:00',
          to: '2026-10-02T00:00:00Z',
          sort: 'oldest',
        }),
      );

      const expectedValues = [
        'community-1',
        'mod_one',
        'member_banned',
        'user',
        '2026-09-30 22:00:00',
        '2026-10-02 00:00:00',
      ];
      expect(queries[1]?.sql).toContain('ORDER BY created_at ASC, id ASC');
      expect(queries[1]?.values).toEqual([...expectedValues, 20, 0]);
      expect(queries[2]?.values).toEqual(expectedValues);
      expect(queries[2]?.sql).toContain(
        "created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      );
    });
  });

  it('exposes no update or delete method and source contains no log mutations', () => {
    const methodNames = Object.getOwnPropertyNames(
      CommunityModerationLogService.prototype,
    );
    expect(methodNames).not.toContain('update');
    expect(methodNames).not.toContain('delete');

    const source = allTypeScriptFiles(resolve(process.cwd(), 'src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const table = 'community_moderation_actions';
    expect(source).not.toMatch(new RegExp(`UPDATE\\s+${table}`, 'i'));
    expect(source).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${table}`, 'i'));
  });
});
