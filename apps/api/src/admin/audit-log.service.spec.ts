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
    [
      {
        actorId: 'admin-1',
        action: 'user_role_changed',
        targetType: 'user',
        targetId: 'user-1',
        metadata: { from_role: 'user', to_role: 'admin' },
      },
      { from_role: 'user', to_role: 'admin' },
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
