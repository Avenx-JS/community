import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { AccountDeletionService } from './account-deletion.service';
import { UserActivityService } from './user-activity.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let calls: Array<[string, ...unknown[]]>;
  const profile = {
    username: 'sample',
    display_name: null,
    bio: null,
    created_at: '2026-10-21T20:00:00.000Z',
    avatar: null,
  };
  const ownProfile = {
    ...profile,
    id: 'user-id',
    email: 'sample@example.com',
    role: 'user' as const,
  };
  const usersService = {
    getUserProfile: (username: string) => {
      calls.push(['getUserProfile', username]);
      return Promise.resolve(profile);
    },
    getOwnProfile: (userId: string) => {
      calls.push(['getOwnProfile', userId]);
      return Promise.resolve(ownProfile);
    },
    updateOwnProfile: (userId: string, changes: object) => {
      calls.push(['updateOwnProfile', userId, changes]);
      return Promise.resolve(ownProfile);
    },
  } satisfies Pick<
    UsersService,
    'getUserProfile' | 'getOwnProfile' | 'updateOwnProfile'
  >;
  const accountDeletion = {
    deleteOwnAccount: (userId: string, password: string) => {
      calls.push(['deleteOwnAccount', userId, password]);
      return Promise.resolve();
    },
  } satisfies Pick<AccountDeletionService, 'deleteOwnAccount'>;
  const emptyPage = { items: [], page: 1, limit: 20, total: 0 };
  const userActivity = {
    listPosts: (username: string, query: object) => {
      calls.push(['listPosts', username, query]);
      return Promise.resolve(emptyPage);
    },
    listComments: (username: string, query: object) => {
      calls.push(['listComments', username, query]);
      return Promise.resolve(emptyPage);
    },
    listCommunities: (username: string, query: object) => {
      calls.push(['listCommunities', username, query]);
      return Promise.resolve(emptyPage);
    },
  } satisfies Pick<
    UserActivityService,
    'listPosts' | 'listComments' | 'listCommunities'
  >;
  const request = { user: { id: 'user-id' } } as AuthenticatedRequest;

  beforeEach(async () => {
    calls = [];
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: usersService },
        { provide: AccountDeletionService, useValue: accountDeletion },
        { provide: UserActivityService, useValue: userActivity },
        // AuthGuard's dependency; the guard itself does not run here.
        { provide: AuthService, useValue: {} },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('delegates profile lookup by username to the users service', async () => {
    await expect(controller.getUserProfile('sample')).resolves.toEqual(profile);
    expect(calls).toEqual([['getUserProfile', 'sample']]);
  });

  it('reads and updates the own profile by the authenticated id only', async () => {
    await controller.getOwnProfile(request);
    await controller.updateOwnProfile(request, { bio: 'Hi' });
    expect(calls).toEqual([
      ['getOwnProfile', 'user-id'],
      ['updateOwnProfile', 'user-id', { bio: 'Hi' }],
    ]);
  });

  it('deletes only the authenticated account, passing the confirmed password', async () => {
    await expect(
      controller.deleteOwnAccount(request, { password: 'correct password' }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['deleteOwnAccount', 'user-id', 'correct password'],
    ]);
  });

  // Nest registers routes in prototype order and Express matches the first,
  // so /users/me must be declared before /users/:username.
  it('declares the /users/me routes before /users/:username', () => {
    const routes = new MetadataScanner()
      .getAllMethodNames(UsersController.prototype)
      .map((name) => {
        const handler = (
          UsersController.prototype as unknown as Record<string, object>
        )[name];
        return {
          name,
          path: Reflect.getMetadata(PATH_METADATA, handler) as string,
          method: Reflect.getMetadata(
            METHOD_METADATA,
            handler,
          ) as RequestMethod,
        };
      });
    const position = (path: string, method: RequestMethod) =>
      routes.findIndex(
        (route) => route.path === path && route.method === method,
      );

    expect(routes[position('me', RequestMethod.GET)]?.name).toBe(
      'getOwnProfile',
    );
    expect(routes[position('me', RequestMethod.PATCH)]?.name).toBe(
      'updateOwnProfile',
    );
    expect(position(':username', RequestMethod.GET)).toBeGreaterThan(
      position('me', RequestMethod.GET),
    );
    // The activity listings come after both, as the issue specifies.
    for (const path of [
      ':username/posts',
      ':username/comments',
      ':username/communities',
    ]) {
      expect([path, position(path, RequestMethod.GET)]).toEqual([
        path,
        expect.any(Number),
      ]);
      expect(position(path, RequestMethod.GET)).toBeGreaterThan(
        position(':username', RequestMethod.GET),
      );
    }
  });

  it('delegates the activity listings by username and query only', async () => {
    const query = { page: 2, limit: 5 };
    await controller.listUserPosts('sample', { ...query, sort: 'oldest' });
    await controller.listUserComments('sample', query);
    await controller.listUserCommunities('sample', query);

    expect(calls).toEqual([
      ['listPosts', 'sample', { ...query, sort: 'oldest' }],
      ['listComments', 'sample', query],
      ['listCommunities', 'sample', query],
    ]);
  });
});
