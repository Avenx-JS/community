import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildNotificationMetadata,
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TYPES,
} from './notification-metadata';

const snapshot = {
  actor_username: 'alice',
  community_name: 'gardening',
  post_title: 'First tomatoes',
  excerpt: 'Mine ripened early this year.',
};

const privateFields = {
  email: 'private@example.com',
  password_hash: 'private-hash',
  token: 'secret-token',
  body: 'full comment text',
  unexpected: 'discard me',
};

describe('buildNotificationMetadata', () => {
  it.each(['post_comment', 'comment_reply', 'community_post'] as const)(
    'keeps the content snapshot and drops unknown fields for %s',
    (type) => {
      const metadata = buildNotificationMetadata(type, {
        ...snapshot,
        ...privateFields,
      });

      expect(metadata).toEqual(snapshot);
      expect(JSON.stringify(metadata)).not.toMatch(
        /email|password|hash|token|body|unexpected/i,
      );
    },
  );

  it('never stores the moderator username for content_removed', () => {
    expect(buildNotificationMetadata('content_removed', snapshot)).toEqual({
      community_name: 'gardening',
      post_title: 'First tomatoes',
      excerpt: 'Mine ripened early this year.',
    });
  });

  it.each([
    'report_resolved',
    'restriction_applied',
    'restriction_lifted',
  ] as const)('stores no snapshot for platform-level %s', (type) => {
    expect(buildNotificationMetadata(type, snapshot)).toBeNull();
  });

  it('returns null for absent or empty metadata', () => {
    expect(buildNotificationMetadata('post_comment', undefined)).toBeNull();
    expect(buildNotificationMetadata('post_comment', {})).toBeNull();
  });

  it('truncates content snapshots by code point with an ellipsis', () => {
    const metadata = buildNotificationMetadata('community_post', {
      post_title: '🍅'.repeat(121),
      excerpt: 'x'.repeat(200),
    });

    expect(metadata?.post_title).toBe(`${'🍅'.repeat(119)}…`);
    expect(Array.from(metadata?.post_title ?? '')).toHaveLength(120);
    expect(metadata?.excerpt).toBe('x'.repeat(200));
  });

  it('rejects identifiers that exceed their source column', () => {
    expect(() =>
      buildNotificationMetadata('post_comment', {
        actor_username: 'a'.repeat(51),
      }),
    ).toThrow('Invalid notification metadata field: actor_username');
    expect(() =>
      buildNotificationMetadata('post_comment', { community_name: '' }),
    ).toThrow('Invalid notification metadata field: community_name');
  });

  it('rejects non-string field values', () => {
    expect(() =>
      buildNotificationMetadata('post_comment', { excerpt: { html: '<b>' } }),
    ).toThrow('Invalid notification metadata field: excerpt');
  });

  it.each([null, 'text', 42, ['alice']])(
    'throws for non-object metadata %p',
    (value) => {
      expect(() => buildNotificationMetadata('post_comment', value)).toThrow(
        'Notification metadata must be an object',
      );
    },
  );
});

describe('notification enums', () => {
  it('match the notifications table definition in migration 010', () => {
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../../data/migrations/010_create_notifications.sql',
      ),
      'utf8',
    );
    const enumValues = (column: string) => {
      const definition =
        new RegExp(`\\b${column} ENUM\\(([^)]*)\\)`).exec(migration)?.[1] ?? '';
      return Array.from(
        definition.matchAll(/'([a-z_]+)'/g),
        ([, value]) => value,
      );
    };

    expect(enumValues('type')).toEqual([...NOTIFICATION_TYPES]);
    expect(enumValues('subject_type')).toEqual([...NOTIFICATION_SUBJECT_TYPES]);
  });
});
