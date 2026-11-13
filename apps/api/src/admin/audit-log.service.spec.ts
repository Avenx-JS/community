import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { MYSQL_POOL } from '../auth/auth.service';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditEntry,
  AuditLogService,
  buildAuditMetadata,
} from './audit-log.service';

const actorRow = [{ username: 'moderator' }];

function fakeConnection(
  execute: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>,
  release = () => undefined,
): PoolConnection {
  return {
    execute,
    release,
  } as unknown as PoolConnection;
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

describe('AuditLogService', () => {
  let service: AuditLogService;

  beforeEach(async () => {
    const pool = { getConnection: () => Promise.resolve(fakeConnection()) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditLogService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();
    service = module.get<AuditLogService>(AuditLogService);
  });

  it.each([
    [
      {
        actorId: 'admin-1',
        action: 'report_status_changed',
        targetType: 'report',
        targetId: 'report-1',
        metadata: {
          from_status: 'open',
          to_status: 'resolved',
          resolution: 'no_action',
        },
      },
      {
        from_status: 'open',
        to_status: 'resolved',
        resolution: 'no_action',
      },
    ],
    [
      {
        actorId: 'admin-1',
        action: 'user_suspended',
        targetType: 'user',
        targetId: 'user-1',
        metadata: {
          restriction_id: 'restriction-1',
          expires_at: '2026-11-01T00:00:00.000Z',
          report_id: 'report-1',
        },
      },
      {
        restriction_id: 'restriction-1',
        expires_at: '2026-11-01T00:00:00.000Z',
        report_id: 'report-1',
      },
    ],
    [
      {
        actorId: 'admin-1',
        action: 'user_banned',
        targetType: 'user',
        targetId: 'user-1',
        metadata: { restriction_id: 'restriction-1', report_id: null },
      },
      { restriction_id: 'restriction-1', report_id: null },
    ],
    [
      {
        actorId: 'admin-1',
        action: 'restriction_lifted',
        targetType: 'restriction',
        targetId: 'restriction-1',
        metadata: {
          restriction_id: 'restriction-1',
          restriction_type: 'ban',
        },
      },
      { restriction_id: 'restriction-1', restriction_type: 'ban' },
    ],
  ] as const)(
    'keeps only allowlisted metadata for action %s',
    (untypedEntry, expected) => {
      const entry = {
        ...untypedEntry,
        metadata: {
          ...untypedEntry.metadata,
          email: 'private@example.com',
          password_hash: 'private-hash',
          token: 'secret-token',
          session_id: 'private-session',
          reason: 'free text identifying a third party',
          resolution_note: 'private note',
          unexpected: 'discard me',
        },
      } as unknown as AuditEntry;

      const safeMetadata = buildAuditMetadata(entry);

      expect(safeMetadata).toEqual(expected);
      expect(JSON.stringify(safeMetadata)).not.toMatch(
        /email|password|hash|token|session|reason|note|unexpected/i,
      );
    },
  );

  // Migration 041: role changes and administrators' content actions carry a
  // required reason, and nothing else beyond their own keys.
  it.each([
    [
      {
        actorId: 'admin-1',
        action: 'user_role_changed',
        targetType: 'user',
        targetId: 'user-1',
        metadata: { from_role: 'user', to_role: 'admin', reason: 'Triage' },
      },
      { from_role: 'user', to_role: 'admin', reason: 'Triage' },
    ],
    [
      {
        actorId: 'admin-1',
        action: 'post_removed',
        targetType: 'post',
        targetId: 'post-1',
        metadata: {
          community_name: 'garden',
          previous_state: 'moderator_removed',
          reason: 'Doxxing',
        },
      },
      {
        community_name: 'garden',
        previous_state: 'moderator_removed',
        reason: 'Doxxing',
      },
    ],
    [
      {
        actorId: 'admin-1',
        action: 'comment_restored',
        targetType: 'comment',
        targetId: 'comment-1',
        metadata: { previous_state: 'admin_removed', reason: 'Appeal upheld' },
      },
      { previous_state: 'admin_removed', reason: 'Appeal upheld' },
    ],
  ] as const)(
    'keeps the reason and drops everything unlisted for %s',
    (untypedEntry, expected) => {
      const entry = {
        ...untypedEntry,
        metadata: {
          ...untypedEntry.metadata,
          email: 'private@example.com',
          token: 'secret-token',
          removal_reason: 'the stored reason, not copied',
          author_id: 'user-9',
        },
      } as unknown as AuditEntry;

      expect(buildAuditMetadata(entry)).toEqual(expected);
    },
  );

  it.each([
    ['previous_state', 'visible_soon'],
    ['reason', '   '],
    ['reason', 'x'.repeat(2001)],
    ['community_name', 'not a name'],
  ])('rejects an invalid %s on a content action', (key, value) => {
    expect(() =>
      buildAuditMetadata({
        actorId: 'admin-1',
        action: 'post_restored',
        targetType: 'post',
        targetId: 'post-1',
        metadata: { [key]: value },
      }),
    ).toThrow(`Invalid audit metadata field: ${key}`);
  });

  it('rejects invalid values for allowlisted metadata fields', () => {
    expect(() =>
      buildAuditMetadata({
        actorId: 'admin-1',
        action: 'report_status_changed',
        targetType: 'report',
        targetId: 'report-1',
        metadata: { to_status: 'private note' as never },
      }),
    ).toThrow('Invalid audit metadata field: to_status');
    expect(() =>
      buildAuditMetadata({
        actorId: 'admin-1',
        action: 'user_suspended',
        targetType: 'user',
        targetId: 'user-1',
        metadata: {
          restriction_id: 'restriction-1',
          expires_at: 'private@example.com',
        },
      }),
    ).toThrow('Invalid audit metadata field: expires_at');
  });

  describe('report assignment actions', () => {
    const leaked = {
      assignee_id: 'admin2-id',
      email: 'private@example.com',
      resolution_note: 'internal',
      previous_assignee: 'admin',
      unexpected: 'discard me',
    };

    it.each(['report_assigned', 'report_unassigned'] as const)(
      'writes %s against the report with only assignee_username',
      async (action) => {
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
          actorId: 'admin-1',
          action,
          targetType: 'report',
          targetId: 'report-1',
          metadata: { assignee_username: 'second_admin', ...leaked },
        } as unknown as AuditEntry);

        expect(calls[1]?.values).toEqual([
          expect.any(String),
          'admin-1',
          'moderator',
          action,
          'report',
          'report-1',
          JSON.stringify({ assignee_username: 'second_admin' }),
        ]);
      },
    );

    it.each(['report_assigned', 'report_unassigned'] as const)(
      'accepts a username snapshot of up to 50 characters for %s',
      (action) => {
        const entry = (assignee_username: string) => ({
          actorId: 'admin-1',
          action,
          targetType: 'report' as const,
          targetId: 'report-1',
          metadata: { assignee_username },
        });
        expect(buildAuditMetadata(entry('a'.repeat(50)))).toEqual({
          assignee_username: 'a'.repeat(50),
        });
        // A deleted account's placeholder, deleted_<uuid>, has hyphens.
        expect(
          buildAuditMetadata(
            entry('deleted_123e4567-e89b-12d3-a456-426614174000'),
          ),
        ).not.toBeNull();
        for (const bad of ['', 'a'.repeat(51), 'has space', 'a\u0000b']) {
          expect(() => buildAuditMetadata(entry(bad))).toThrow(
            'Invalid audit metadata field: assignee_username',
          );
        }
        expect(() =>
          buildAuditMetadata({
            ...entry('x'),
            metadata: { assignee_username: 42 },
          } as never),
        ).toThrow('Invalid audit metadata field: assignee_username');
      },
    );

    it('stores NULL metadata when no assignee is given', () => {
      expect(
        buildAuditMetadata({
          actorId: 'admin-1',
          action: 'report_unassigned',
          targetType: 'report',
          targetId: 'report-1',
          metadata: {},
        }),
      ).toBeNull();
    });
  });

  describe('community actions', () => {
    // Keys a caller might pass through; none may be stored for any action.
    const leaked = {
      email: 'private@example.com',
      password_hash: 'private-hash',
      token: 'secret-token',
      description: 'the old community description',
      old_description: 'before',
      new_description: 'after',
      unexpected: 'discard me',
    };

    it.each([
      [
        'community_suspended',
        { community_name: 'spam-hub', reason: 'Coordinated spam network' },
      ],
      ['community_restored', { community_name: 'spam-hub' }],
      [
        'community_updated',
        { community_name: 'spam-hub', fields: 'description' },
      ],
    ] as const)(
      'writes %s against the community target with only its allowlisted metadata',
      async (action, metadata) => {
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
          actorId: 'admin-1',
          action,
          targetType: 'community',
          targetId: 'community-1',
          metadata: { ...metadata, ...leaked },
        } as unknown as AuditEntry);

        expect(calls).toHaveLength(2);
        expect(calls[1]?.sql).toContain('INSERT INTO admin_actions');
        expect(calls[1]?.values).toEqual([
          expect.any(String),
          'admin-1',
          'moderator',
          action,
          'community',
          'community-1',
          JSON.stringify(metadata),
        ]);
        expect(String(calls[1]?.values?.[6])).not.toMatch(
          /email|password|token|old community|before|after|unexpected/,
        );
      },
    );

    it('stores NULL metadata when nothing survives the allowlist', () => {
      expect(
        buildAuditMetadata({
          actorId: 'admin-1',
          action: 'community_restored',
          targetType: 'community',
          targetId: 'community-1',
          metadata: { unexpected: 'x' } as never,
        }),
      ).toBeNull();
    });

    it('never stores a reason for restore or update', () => {
      for (const action of ['community_restored', 'community_updated']) {
        expect(
          buildAuditMetadata({
            actorId: 'admin-1',
            action,
            targetType: 'community',
            targetId: 'community-1',
            metadata: { community_name: 'spam-hub', reason: 'free text' },
          } as unknown as AuditEntry),
        ).toEqual({ community_name: 'spam-hub' });
      }
    });

    it.each([
      ['community_suspended', 'a string'],
      ['community_restored', ['community_name']],
      ['community_updated', 42],
      ['community_suspended', null],
    ])('rejects %s with non-object metadata %p', (action, metadata) => {
      expect(() =>
        buildAuditMetadata({
          actorId: 'admin-1',
          action,
          targetType: 'community',
          targetId: 'community-1',
          metadata,
        } as unknown as AuditEntry),
      ).toThrow('Audit metadata must be an object');
    });

    it.each([
      [
        'community_suspended',
        { community_name: 'x'.repeat(51) },
        'community_name',
      ],
      ['community_restored', { community_name: '' }, 'community_name'],
      ['community_updated', { community_name: 'bad name' }, 'community_name'],
      ['community_suspended', { community_name: 7 }, 'community_name'],
      ['community_suspended', { reason: 'x'.repeat(2001) }, 'reason'],
      ['community_suspended', { reason: '   ' }, 'reason'],
      ['community_suspended', { reason: 'bell\u0007' }, 'reason'],
      ['community_updated', { fields: 'name' }, 'fields'],
      ['community_updated', { fields: 'rules' }, 'fields'],
      ['community_updated', { fields: 'description,description' }, 'fields'],
      ['community_updated', { fields: '' }, 'fields'],
      ['community_updated', { fields: 'Hello, new description' }, 'fields'],
    ])('rejects %s metadata %o', (action, metadata, key) => {
      expect(() =>
        buildAuditMetadata({
          actorId: 'admin-1',
          action,
          targetType: 'community',
          targetId: 'community-1',
          metadata,
        } as unknown as AuditEntry),
      ).toThrow(`Invalid audit metadata field: ${key}`);
    });

    it('accepts a community name at the 50-character column width', () => {
      expect(
        buildAuditMetadata({
          actorId: 'admin-1',
          action: 'community_restored',
          targetType: 'community',
          targetId: 'community-1',
          metadata: { community_name: 'x'.repeat(50) },
        }),
      ).toEqual({ community_name: 'x'.repeat(50) });
    });
  });

  it('uses the supplied connection, resolves the actor from the database, and inserts a UUID', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const connection = fakeConnection((sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT username')) {
        return Promise.resolve([actorRow, []]);
      }
      return Promise.resolve([{ affectedRows: 1 }, []]);
    });

    await service.record(connection, {
      actorId: 'admin-1',
      action: 'user_banned',
      targetType: 'user',
      targetId: 'user-1',
      metadata: { restriction_id: 'restriction-1' },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      sql: 'SELECT username FROM users WHERE id = ? LIMIT 1',
      values: ['admin-1'],
    });
    expect(calls[1]?.sql).toContain('INSERT INTO admin_actions');
    expect(calls[1]?.sql).not.toContain('created_at');
    expect(calls[1]?.values).toEqual([
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      'admin-1',
      'moderator',
      'user_banned',
      'user',
      'user-1',
      '{"restriction_id":"restriction-1"}',
    ]);
  });

  it('acquires and releases its own connection for standalone records', async () => {
    const calls: string[] = [];
    let released = false;
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
        released = true;
      },
    );
    const pool = { getConnection: () => Promise.resolve(connection) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditLogService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();
    const standaloneService = module.get<AuditLogService>(AuditLogService);

    await standaloneService.record({
      actorId: 'admin-1',
      action: 'restriction_lifted',
      targetType: 'restriction',
      targetId: 'restriction-1',
    });

    expect(calls).toHaveLength(2);
    expect(released).toBe(true);
  });

  it('rolls back the caller action if writing its audit record fails', async () => {
    let actionCommitted = false;
    let actionInTransaction = false;
    let auditInserted = false;
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        actionCommitted = actionInTransaction;
        return Promise.resolve();
      },
      rollback: () => {
        actionInTransaction = false;
        auditInserted = false;
        return Promise.resolve();
      },
      release: () => undefined,
      execute: (sql: string) => {
        if (sql.startsWith('SELECT username')) {
          return Promise.resolve([actorRow, []]);
        }
        if (sql.includes('INSERT INTO admin_actions')) {
          return Promise.reject(new Error('Audit insert failed'));
        }
        return Promise.resolve([[], []]);
      },
    } as unknown as PoolConnection;

    await connection.beginTransaction();
    actionInTransaction = true;
    try {
      await service.record(connection, {
        actorId: 'admin-1',
        action: 'user_banned',
        targetType: 'user',
        targetId: 'user-1',
      });
      auditInserted = true;
      await connection.commit();
    } catch {
      await connection.rollback();
    } finally {
      connection.release();
    }

    expect(actionCommitted).toBe(false);
    expect(actionInTransaction).toBe(false);
    expect(auditInserted).toBe(false);
  });

  it('rolls back the audit row when the caller fails after audit insertion', async () => {
    let actionInTransaction = false;
    let auditRows = 0;
    let auditWasInserted = false;
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => {
        actionInTransaction = false;
        auditRows = 0;
        return Promise.resolve();
      },
      release: () => undefined,
      execute: (sql: string) => {
        if (sql.startsWith('SELECT username')) {
          return Promise.resolve([actorRow, []]);
        }
        if (sql.includes('INSERT INTO admin_actions')) {
          auditRows += 1;
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.resolve([[], []]);
      },
    } as unknown as PoolConnection;

    await connection.beginTransaction();
    actionInTransaction = true;
    try {
      await service.record(connection, {
        actorId: 'admin-1',
        action: 'user_banned',
        targetType: 'user',
        targetId: 'user-1',
      });
      auditWasInserted = auditRows === 1;
      throw new Error('Moderation action failed after audit insertion');
    } catch {
      await connection.rollback();
    } finally {
      connection.release();
    }

    expect(auditWasInserted).toBe(true);
    expect(actionInTransaction).toBe(false);
    expect(auditRows).toBe(0);
  });

  it('exposes no update or delete method and source contains no audit mutations', () => {
    const methodNames = Object.getOwnPropertyNames(AuditLogService.prototype);
    expect(methodNames).not.toContain('update');
    expect(methodNames).not.toContain('delete');

    const sourceDirectory = resolve(process.cwd(), 'src');
    const source = allTypeScriptFiles(sourceDirectory)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const updateStatement = new RegExp(
      ['UPDATE', 'admin_actions'].join('\\s+'),
      'i',
    );
    const deleteStatement = new RegExp(
      ['DELETE FROM', 'admin_actions'].join('\\s+'),
      'i',
    );

    expect(source).not.toMatch(updateStatement);
    expect(source).not.toMatch(deleteStatement);
  });

  it('migration declares all lookup indexes and keeps polymorphic targets unlinked', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        '..',
        '..',
        'data',
        'migrations',
        '004_create_admin_actions.sql',
      ),
      'utf8',
    );

    expect(migration.match(/INDEX idx_admin_actions_/g)).toHaveLength(4);
    expect(migration).toContain(
      'FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL',
    );
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(\s*target_id\s*\)/i);
  });
});

describe('community_restored metadata', () => {
  const entry = (metadata: Record<string, unknown>) =>
    ({
      actorId: 'admin-1',
      action: 'community_restored',
      targetType: 'community',
      targetId: 'community-1',
      metadata,
    }) as unknown as AuditEntry;

  it('keeps the restore reason, a reversal being a decision too', () => {
    expect(
      buildAuditMetadata(
        entry({ community_name: 'spam-hub', restore_reason: 'Appeal upheld' }),
      ),
    ).toEqual({ community_name: 'spam-hub', restore_reason: 'Appeal upheld' });
  });

  it.each(['', '   ', 'x'.repeat(2001), 'bad\u0000text'])(
    'refuses the restore reason %j',
    (restore_reason) => {
      expect(() => buildAuditMetadata(entry({ restore_reason }))).toThrow(
        'Invalid audit metadata field: restore_reason',
      );
    },
  );
});
