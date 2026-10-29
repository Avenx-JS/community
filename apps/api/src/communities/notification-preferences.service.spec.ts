import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { NotificationPreferencesService } from './notification-preferences.service';

describe('NotificationPreferencesService', () => {
  let service: NotificationPreferencesService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[][];

  beforeEach(async () => {
    queries = [];
    results = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return Promise.resolve([results.shift() ?? [], []]);
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationPreferencesService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    service = module.get(NotificationPreferencesService);
  });

  it('reports the default when no preference row exists', async () => {
    results = [[{ id: 'community-1', subscribed: 1, new_posts: null }]];

    await expect(service.get('gardening', 'user-1')).resolves.toEqual({
      new_posts: true,
      subscribed: true,
    });
    expect(queries[0].sql).toContain(
      'LEFT JOIN community_notification_preferences p',
    );
    expect(queries[0].values).toEqual(['user-1', 'user-1', 'gardening']);
  });

  it('reports the stored value and non-membership', async () => {
    results = [[{ id: 'community-1', subscribed: 0, new_posts: 0 }]];

    await expect(service.get('gardening', 'user-1')).resolves.toEqual({
      new_posts: false,
      subscribed: false,
    });
  });

  it('returns not found for an unknown community', async () => {
    results = [[]];
    await expect(service.get('unknown', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    results = [[]];
    await expect(
      service.update('unknown', 'user-1', { new_posts: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queries.some((query) => query.sql.startsWith('INSERT'))).toBe(false);
  });

  it('upserts the authenticated user preference and returns the effective value', async () => {
    results = [
      [{ id: 'community-1' }],
      [],
      [{ id: 'community-1', subscribed: 0, new_posts: 0 }],
    ];

    await expect(
      service.update('gardening', 'user-1', { new_posts: false }),
    ).resolves.toEqual({ new_posts: false, subscribed: false });

    expect(queries[1].sql).toBe(
      'INSERT INTO community_notification_preferences (user_id, community_id, new_posts) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE new_posts = VALUES(new_posts)',
    );
    expect(queries[1].values).toEqual(['user-1', 'community-1', false]);
    expect(queries[2].values).toEqual(['user-1', 'user-1', 'gardening']);
  });
});
