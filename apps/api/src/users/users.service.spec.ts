import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { MYSQL_POOL } from '../auth/auth.service';
import { PlatformRole, UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let userRows: Array<{
    id: string;
    username: string;
    created_at: Date | string;
  }>;
  let platformRoleRows: Array<{ role: PlatformRole }>;
  const pool = {
    execute: (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      if (sql.startsWith('SELECT role FROM users')) {
        return Promise.resolve([platformRoleRows, []]);
      }
      return Promise.resolve([userRows, []]);
    },
  };

  beforeEach(async () => {
    queryCalls = [];
    userRows = [
      {
        id: 'user-id',
        username: 'sample',
        created_at: new Date('2026-10-21T20:00:00.000Z'),
      },
    ];
    platformRoleRows = [{ role: 'admin' }];
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('returns only public profile fields', async () => {
    await expect(service.getUserProfile('sample')).resolves.toEqual({
      username: 'sample',
    });
    expect(queryCalls).toEqual([
      {
        sql: 'SELECT username FROM users WHERE username = ? LIMIT 1',
        values: ['sample'],
      },
    ]);
  });

  it('throws 404 when the username does not exist', async () => {
    userRows = [];

    await expect(service.getUserProfile('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns a platform role using a bound user id', async () => {
    await expect(service.getPlatformRole('user-id')).resolves.toBe('admin');
    expect(queryCalls).toEqual([
      {
        sql: 'SELECT role FROM users WHERE id = ? LIMIT 1',
        values: ['user-id'],
      },
    ]);
  });

  it('returns null when the platform role user does not exist', async () => {
    platformRoleRows = [];

    await expect(service.getPlatformRole('missing-id')).resolves.toBeNull();
  });
});
