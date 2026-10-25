import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let service: ReportsService;
  let poolCalls: Array<{ sql: string; values: unknown[] }>;
  let connectionCalls: Array<{ sql: string; values: unknown[] }>;
  let existingReports: Array<{ id: string }>;
  let targetExists: boolean;
  let contextAuthorId: string;
  let contextExists: boolean;
  let throwOnInsert: boolean;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };

  beforeEach(async () => {
    poolCalls = [];
    connectionCalls = [];
    existingReports = [];
    targetExists = true;
    contextAuthorId = 'reported-id';
    contextExists = true;
    throwOnInsert = false;
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        connectionCalls.push({ sql, values });
        if (sql.startsWith('SELECT id FROM user_reports')) {
          return Promise.resolve([existingReports, []]);
        }
        if (sql.startsWith('INSERT INTO user_reports')) {
          if (throwOnInsert) {
            return Promise.reject(new Error('insert failed'));
          }
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT created_at FROM user_reports')) {
          return Promise.resolve([
            [{ created_at: '2026-10-25T10:00:00.000Z' }],
            [],
          ]);
        }
        return Promise.resolve([[], []]);
      },
    };
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        poolCalls.push({ sql, values });
        if (sql.startsWith('SELECT id, username FROM users')) {
          return Promise.resolve([
            targetExists ? [{ id: 'reported-id', username: values[0] }] : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT author_id FROM')) {
          return Promise.resolve([
            contextExists ? [{ author_id: contextAuthorId }] : [],
            [],
          ]);
        }
        return Promise.resolve([[], []]);
      },
      getConnection: () => Promise.resolve(connection),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReportsService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  const reportInput = (
    overrides: Partial<CreateReportDto> = {},
  ): CreateReportDto => ({
    username: 'reported_user',
    reason: 'spam',
    ...overrides,
  });

  it('creates a reduced report DTO using the authenticated reporter id', async () => {
    const response = await service.create(reportInput(), 'reporter-id');

    expect(response).toEqual({
      id: expect.any(String),
      reported_username: 'reported_user',
      reason: 'spam',
      status: 'open',
      created_at: '2026-10-25T10:00:00.000Z',
    });
    expect(Object.keys(response).sort()).toEqual(
      ['id', 'reported_username', 'reason', 'status', 'created_at'].sort(),
    );
    const insert = connectionCalls.find((call) =>
      call.sql.startsWith('INSERT INTO user_reports'),
    );
    const duplicateCheck = connectionCalls.find((call) =>
      call.sql.startsWith('SELECT id FROM user_reports'),
    );
    expect(insert?.values).toEqual([
      response.id,
      'reporter-id',
      'reported-id',
      'spam',
      null,
      null,
      null,
    ]);
    expect(duplicateCheck?.values).toEqual([
      'reporter-id',
      'reported-id',
      null,
      null,
    ]);
    expect(connection.beginTransaction).toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });

  it('rejects unknown targets and self-reports without opening a transaction', async () => {
    targetExists = false;
    await expect(
      service.create(reportInput(), 'reporter-id'),
    ).rejects.toBeInstanceOf(NotFoundException);

    targetExists = true;
    await expect(
      service.create(reportInput(), 'reported-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('rejects reasons outside the shared schema vocabulary', async () => {
    await expect(
      service.create(
        { ...reportInput(), reason: 'unknown' } as CreateReportDto,
        'reporter-id',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(poolCalls).toHaveLength(0);
  });

  it('validates context existence and authorship using an allowlisted table', async () => {
    contextExists = false;
    await expect(
      service.create(
        reportInput({ context_type: 'post', context_id: 'post-1' }),
        'reporter-id',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    contextExists = true;
    contextAuthorId = 'another-id';
    await expect(
      service.create(
        reportInput({ context_type: 'comment', context_id: 'comment-1' }),
        'reporter-id',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(poolCalls.map((call) => call.sql)).toContain(
      'SELECT author_id FROM posts WHERE id = ? LIMIT 1',
    );
    expect(poolCalls.map((call) => call.sql)).toContain(
      'SELECT author_id FROM comments WHERE id = ? LIMIT 1',
    );
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('stores a valid context and uses null-safe duplicate matching', async () => {
    const response = await service.create(
      reportInput({ context_type: 'post', context_id: 'post-1' }),
      'reporter-id',
    );
    const duplicateCheck = connectionCalls.find((call) =>
      call.sql.startsWith('SELECT id FROM user_reports'),
    );
    const insert = connectionCalls.find((call) =>
      call.sql.startsWith('INSERT INTO user_reports'),
    );

    expect(response.status).toBe('open');
    expect(duplicateCheck?.sql).toContain(
      'context_type <=> ? AND context_id <=> ?',
    );
    expect(duplicateCheck?.values).toEqual([
      'reporter-id',
      'reported-id',
      'post',
      'post-1',
    ]);
    expect(insert?.values.slice(5)).toEqual(['post', 'post-1']);
  });

  it('accepts comments authored by the reported account', async () => {
    const response = await service.create(
      reportInput({ context_type: 'comment', context_id: 'comment-1' }),
      'reporter-id',
    );

    expect(response.status).toBe('open');
    expect(
      poolCalls.some((call) =>
        call.sql.startsWith('SELECT author_id FROM comments'),
      ),
    ).toBe(true);
  });

  it('conflicts only with active duplicate reports and rolls back', async () => {
    existingReports = [{ id: 'existing-report' }];

    await expect(
      service.create(reportInput(), 'reporter-id'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(
      connectionCalls.some((call) =>
        call.sql.startsWith('INSERT INTO user_reports'),
      ),
    ).toBe(false);
  });

  it('rolls back and releases the connection after an insert failure', async () => {
    throwOnInsert = true;

    await expect(service.create(reportInput(), 'reporter-id')).rejects.toThrow(
      'insert failed',
    );
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });
});
