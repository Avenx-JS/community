import 'reflect-metadata';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ALLOW_RESTRICTED } from '../auth/allow-restricted.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationsController } from './notifications.controller';

describe('NotificationsController', () => {
  let app: INestApplication<App>;
  let inbox: {
    list: jest.Mock;
    unreadCount: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(async () => {
    inbox = {
      list: jest.fn(() => Promise.resolve({ items: [] })),
      unreadCount: jest.fn(() => Promise.resolve({ unread: 3 })),
      findOne: jest.fn(() => Promise.resolve({ id: 'from-findOne' })),
    };
    const module = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationInboxService, useValue: inbox }],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user: unknown } };
        }) => {
          context.switchToHttp().getRequest().user = { id: 'user-a' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // "unread-count" also matches the :id pattern, so a reordering would
  // silently answer 404 from findOne instead of the count.
  it('routes unread-count to its own handler, not to :id', async () => {
    const response = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .expect(200);

    expect(response.body).toEqual({ unread: 3 });
    expect(inbox.unreadCount).toHaveBeenCalledWith('user-a');
    expect(inbox.findOne).not.toHaveBeenCalled();
  });

  it('passes only the authenticated user as recipient', async () => {
    await request(app.getHttpServer())
      .get('/notifications?type=post_comment')
      .expect(200);
    await request(app.getHttpServer())
      .get('/notifications/notification-1')
      .expect(200);

    expect(inbox.list.mock.calls[0][0]).toBe('user-a');
    expect(inbox.findOne).toHaveBeenCalledWith('user-a', 'notification-1');
  });

  it('marks exactly the three read routes as reachable while restricted', () => {
    const prototype = NotificationsController.prototype;
    const handlers = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(handlers.sort()).toEqual(['findOne', 'list', 'unreadCount']);
    for (const name of handlers) {
      expect(
        Reflect.getMetadata(
          ALLOW_RESTRICTED,
          Object.getOwnPropertyDescriptor(prototype, name)?.value as object,
        ),
      ).toBe(true);
    }
  });
});
