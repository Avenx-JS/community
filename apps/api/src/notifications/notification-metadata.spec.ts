import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNotificationEntry,
  buildNotificationMetadata,
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TYPES,
  type NotificationEntry,
} from './notification-metadata';

const privateFields = {
  email: 'private@example.com',
  password_hash: 'private-hash',
  token: 'secret-token',
  body: 'full comment text',
  moderator_username: 'the_moderator',
  unexpected: 'discard me',
};

const community = {
  actorId: 'actor-1',
  subjectId: 'subject-1',
  communityId: 'community-1',
  recipientId: 'recipient-1',
};

const platform = {
  actorId: null,
  subjectId: 'subject-1',
  communityId: null,
  recipientId: 'recipient-1',
};

// Builds from untyped metadata, as a producer bug or a cast would.
const build = (entry: Omit<NotificationEntry, 'metadata'>, metadata: unknown) =>
  buildNotificationMetadata({ ...entry, metadata } as NotificationEntry);

describe('buildNotificationMetadata', () => {
  it.each([
    [
      { ...community, type: 'post_comment', subjectType: 'comment' },
      {
        actor_username: 'alice',
        community_name: 'gardening',
        post_id: 'post-1',
        post_title: 'First tomatoes',
        excerpt: 'Mine ripened early.',
      },
    ],
    [
      { ...community, type: 'comment_reply', subjectType: 'comment' },
      {
        actor_username: 'alice',
        community_name: 'gardening',
        post_id: 'post-1',
        parent_comment_id: 'comment-1',
        post_title: 'First tomatoes',
        excerpt: 'Same here.',
      },
    ],
    [
      { ...community, type: 'community_post', subjectType: 'post' },
      {
        actor_username: 'alice',
        community_name: 'gardening',
        post_title: 'First tomatoes',
        excerpt: 'Pictures inside.',
      },
    ],
    [
      { ...platform, type: 'report_resolved', subjectType: 'report' },
      { status: 'resolved' },
    ],
    [
      { ...platform, type: 'restriction_applied', subjectType: 'restriction' },
      {
        restriction_type: 'suspension',
        expires_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    [
      { ...platform, type: 'restriction_lifted', subjectType: 'restriction' },
      { restriction_type: 'ban' },
    ],
    [
      {
        ...community,
        actorId: null,
        type: 'content_removed',
        subjectType: 'comment',
      },
      {
        community_name: 'gardening',
        post_title: 'First tomatoes',
        excerpt: 'Removed text.',
      },
    ],
  ] as const)(
    'keeps the allowed fields and drops unknown ones for %o',
    (entry, metadata) => {
      const result = build(entry, { ...metadata, ...privateFields });

      expect(result).toEqual(metadata);
      expect(JSON.stringify(result)).not.toMatch(
        /email|password|hash|token|body|moderator|unexpected/i,
      );
    },
  );

  it('drops fields that belong to other types', () => {
    expect(
      build(
        { ...community, type: 'community_post', subjectType: 'post' },
        { post_title: 'T', post_id: 'post-1', parent_comment_id: 'c-1' },
      ),
    ).toEqual({ post_title: 'T' });
    expect(
      build(
        { ...platform, type: 'restriction_lifted', subjectType: 'restriction' },
        {
          restriction_type: 'ban',
          expires_at: '2026-11-01T00:00:00.000Z',
          actor_username: 'admin',
        },
      ),
    ).toEqual({ restriction_type: 'ban' });
  });

  it('never stores an actor username for content_removed', () => {
    expect(
      build(
        { ...platform, type: 'content_removed', subjectType: 'post' },
        { actor_username: 'the_moderator', post_title: 'T' },
      ),
    ).toEqual({ post_title: 'T' });
  });

  it('returns null when nothing survives', () => {
    const entry = {
      ...community,
      type: 'post_comment',
      subjectType: 'comment',
    } as const;
    expect(build(entry, undefined)).toBeNull();
    expect(build(entry, {})).toBeNull();
    expect(build(entry, { unexpected: 'x' })).toBeNull();
  });

  it('caps post_title at 300 code points without splitting characters', () => {
    const result = build(
      { ...community, type: 'community_post', subjectType: 'post' },
      { post_title: '🍅'.repeat(301), excerpt: 'é'.repeat(201) },
    );

    expect(result?.post_title).toBe(`${'🍅'.repeat(299)}…`);
    expect(Array.from(result?.post_title ?? '')).toHaveLength(300);
    expect(result?.excerpt).toBe(`${'é'.repeat(199)}…`);
    expect(result?.post_title).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    );
  });

  it('keeps snapshots at exactly the cap unchanged', () => {
    const result = build(
      { ...community, type: 'community_post', subjectType: 'post' },
      { post_title: '🍅'.repeat(300), excerpt: 'x'.repeat(200) },
    );

    expect(result?.post_title).toBe('🍅'.repeat(300));
    expect(result?.excerpt).toBe('x'.repeat(200));
  });

  it.each(['', 'a b', 'post/1', 'x'.repeat(37), "1' OR '1'='1"])(
    'rejects malformed identifier %p',
    (postId) => {
      expect(() =>
        build(
          { ...community, type: 'post_comment', subjectType: 'comment' },
          { post_id: postId },
        ),
      ).toThrow('Invalid notification metadata field: post_id');
    },
  );

  it.each([
    '2026-11-01',
    '2026-11-01 00:00:00',
    '2026-13-01T00:00:00Z',
    'tomorrow',
  ])('rejects malformed expires_at %p', (expiresAt) => {
    expect(() =>
      build(
        {
          ...platform,
          type: 'restriction_applied',
          subjectType: 'restriction',
        },
        { restriction_type: 'suspension', expires_at: expiresAt },
      ),
    ).toThrow('Invalid notification metadata field: expires_at');
  });

  it('rejects values outside their enums and non-string values', () => {
    expect(() =>
      build(
        { ...platform, type: 'report_resolved', subjectType: 'report' },
        { status: 'open' },
      ),
    ).toThrow('Invalid notification metadata field: status');
    expect(() =>
      build(
        { ...platform, type: 'restriction_lifted', subjectType: 'restriction' },
        { restriction_type: 'warning' },
      ),
    ).toThrow('Invalid notification metadata field: restriction_type');
    expect(() =>
      build(
        { ...community, type: 'post_comment', subjectType: 'comment' },
        { excerpt: { html: '<b>' } },
      ),
    ).toThrow('Invalid notification metadata field: excerpt');
  });

  it('rejects names that exceed their source column', () => {
    const entry = {
      ...community,
      type: 'post_comment',
      subjectType: 'comment',
    } as const;
    expect(() => build(entry, { actor_username: 'a'.repeat(51) })).toThrow(
      'Invalid notification metadata field: actor_username',
    );
    expect(() => build(entry, { community_name: '' })).toThrow(
      'Invalid notification metadata field: community_name',
    );
  });

  it.each([null, 'text', 42, ['alice']])(
    'throws TypeError for non-object metadata %p',
    (value) => {
      expect(() =>
        build(
          { ...community, type: 'post_comment', subjectType: 'comment' },
          value,
        ),
      ).toThrow(new TypeError('Notification metadata must be an object'));
    },
  );
});

describe('assertNotificationEntry', () => {
  it('accepts content_removed for both posts and comments', () => {
    for (const subjectType of ['post', 'comment'] as const) {
      expect(() =>
        assertNotificationEntry({
          ...platform,
          communityId: 'community-1',
          type: 'content_removed',
          subjectType,
          metadata: {},
        }),
      ).not.toThrow();
    }
  });

  it.each([
    ['type', { type: 'vote' }],
    ['subject type', { subjectType: 'community' }],
    ['subject type', { subjectType: 'post' }],
    ['actor', { actorId: null }],
    ['community', { communityId: null }],
    ['identifier', { subjectId: '' }],
  ])('rejects a mismatched %s', (_, override) => {
    expect(() =>
      assertNotificationEntry({
        ...community,
        type: 'post_comment',
        subjectType: 'comment',
        metadata: { post_id: 'p', post_title: 't', excerpt: 'e' },
        ...override,
      } as unknown as NotificationEntry),
    ).toThrow(TypeError);
  });
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
