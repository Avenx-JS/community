import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let profileCalls: string[];
  const profile = {
    id: 'user-id',
    username: 'sample',
    created_at: '2026-10-21T20:00:00.000Z',
  };
  const usersService = {
    getUserProfile: (username: string) => {
      profileCalls.push(username);
      return Promise.resolve(profile);
    },
  } satisfies Pick<UsersService, 'getUserProfile'>;

  beforeEach(async () => {
    profileCalls = [];
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('delegates profile lookup by username to the users service', async () => {
    await expect(controller.getUserProfile('sample')).resolves.toEqual(profile);
    expect(profileCalls).toEqual(['sample']);
  });
});
