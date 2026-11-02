import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { MYSQL_POOL } from '../auth/auth.service';
import { OWN_PROFILE_SQL, PlatformRole, UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let userRows: Array<Record<string, unknown>>;
  let platformRoleRows: Array<{ role: PlatformRole }>;
  const pool = {
    execute: (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      if (sql.startsWith('SELECT role FROM users')) {
        return Promise.resolve([platformRoleRows, []]);
      }
      if (sql.startsWith('UPDATE')) {
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      return Promise.resolve([userRows, []]);
    },
  };

  beforeEach(async () => {
    queryCalls = [];
    // Includes the columns a careless SELECT * would leak.
    userRows = [
      {
        id: 'user-id',
        username: 'sample',
        email: 'sample@example.com',
        password_hash: 'private-hash',
        display_name: 'Sam',
        bio: 'Gardener',
        role: 'moderator',
        created_at: new Date('2026-10-21T20:00:00.000Z'),
        last_seen_at: new Date('2026-10-30T20:00:00.000Z'),
      },
    ];
    platformRoleRows = [{ role: 'admin' }];
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('returns only public profile fields', async () => {
    const profile = await service.getUserProfile('sample');
    expect(profile).toEqual({
      username: 'sample',
      display_name: 'Sam',
      bio: 'Gardener',
      created_at: '2026-10-21T20:00:00.000Z',
    });
    expect(Object.keys(profile)).toEqual([
      'username',
      'display_name',
      'bio',
      'created_at',
    ]);
    expect(queryCalls).toEqual([
      {
        sql: 'SELECT username, display_name, bio, created_at FROM users WHERE username = ? LIMIT 1',
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

  it('reads the own profile by bound id, without credentials or last_seen_at', async () => {
    const profile = await service.getOwnProfile('user-id');
    expect(profile).toEqual({
      id: 'user-id',
      username: 'sample',
      email: 'sample@example.com',
      display_name: 'Sam',
      bio: 'Gardener',
      role: 'moderator',
      created_at: '2026-10-21T20:00:00.000Z',
    });
    expect(queryCalls).toEqual([{ sql: OWN_PROFILE_SQL, values: ['user-id'] }]);
    expect(OWN_PROFILE_SQL).toBe(
      'SELECT id, username, email, display_name, bio, role, created_at FROM users WHERE id = ? LIMIT 1',
    );
  });

  it('throws 404 when the own account no longer exists', async () => {
    userRows = [];

    await expect(service.getOwnProfile('gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each([
    [{ display_name: 'Sam' }, 'display_name = ?', ['Sam']],
    [{ bio: 'Gardener' }, 'bio = ?', ['Gardener']],
    [
      { display_name: 'Sam', bio: 'Gardener' },
      'display_name = ?, bio = ?',
      ['Sam', 'Gardener'],
    ],
    [{ display_name: '' }, 'display_name = ?', [null]],
    [{ bio: '' }, 'bio = ?', [null]],
    [{ display_name: '', bio: '' }, 'display_name = ?, bio = ?', [null, null]],
  ])(
    'updates only the present fields of %o, by bound id',
    async (changes, assignments, values) => {
      await expect(
        service.updateOwnProfile('user-id', changes),
      ).resolves.toMatchObject({ id: 'user-id' });
      expect(queryCalls).toEqual([
        {
          sql: `UPDATE users SET ${assignments} WHERE id = ?`,
          values: [...values, 'user-id'],
        },
        { sql: OWN_PROFILE_SQL, values: ['user-id'] },
      ]);
    },
  );

  it('issues no UPDATE when no field is present', async () => {
    await service.updateOwnProfile('user-id', {});
    expect(queryCalls).toEqual([{ sql: OWN_PROFILE_SQL, values: ['user-id'] }]);
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
