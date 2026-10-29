import 'reflect-metadata';
import type { PoolConnection } from 'mysql2/promise';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import type { NotificationEntry } from './notification-metadata';
import {
  NOTIFICATION_BATCH_SIZE,
  NotificationsService,
} from './notifications.service';

interface StoredRow {
  id: string;
  recipient_id: string;
  type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  community_id: string | null;
  metadata: string | null;
}

const columns = [
  'id',
  'recipient_id',
  'type',
  'actor_id',
  'subject_type',
  'subject_id',
  'community_id',
  'metadata',
] as const;

const entries = {
  post_comment: {
    recipientId: 'post-author',
    type: 'post_comment',
    actorId: 'commenter',
    subjectType: 'comment',
    subjectId: 'comment-1',
    communityId: 'community-1',
    metadata: {
      post_id: 'post-1',
      post_title: 'First tomatoes',
      excerpt: 'Mine ripened early.',
    },
  },
  comment_reply: {
    recipientId: 'parent-author',
    type: 'comment_reply',
    actorId: 'replier',
    subjectType: 'comment',
    subjectId: 'comment-2',
    communityId: 'community-1',
    metadata: {
      post_id: 'post-1',
      parent_comment_id: 'comment-1',
      excerpt: 'Same here.',
    },
  },
  community_post: {
    recipientId: 'member',
    type: 'community_post',
    actorId: 'poster',
    subjectType: 'post',
    subjectId: 'post-1',
    communityId: 'community-1',
    metadata: { post_title: 'First tomatoes' },
  },
  report_resolved: {
    recipientId: 'reporter',
    type: 'report_resolved',
    actorId: null,
    subjectType: 'report',
    subjectId: 'report-1',
    communityId: null,
    metadata: { status: 'rejected' },
  },
  restriction_applied: {
    recipientId: 'restricted',
    type: 'restriction_applied',
    actorId: null,
    subjectType: 'restriction',
    subjectId: 'restriction-1',
    communityId: null,
    metadata: {
      restriction_type: 'suspension',
      expires_at: '2026-11-01T00:00:00.000Z',
    },
  },
  restriction_lifted: {
    recipientId: 'restricted',
    type: 'restriction_lifted',
    actorId: null,
    subjectType: 'restriction',
    subjectId: 'restriction-1',
    communityId: null,
    metadata: { restriction_type: 'ban' },
  },
  content_removed: {
    recipientId: 'author',
    type: 'content_removed',
    actorId: null,
    subjectType: 'post',
    subjectId: 'post-1',
    communityId: 'community-1',
    metadata: { post_title: 'First tomatoes' },
  },
} satisfies Record<NotificationEntry['type'], NotificationEntry>;

const memberPost = (recipientId: string): typeof entries.community_post => ({
  ...entries.community_post,
  recipientId,
});

// An in-memory notifications table that honours the unique key the way
// ON DUPLICATE KEY UPDATE id = id does: a colliding row is left unchanged.
function createTable() {
  const rows: StoredRow[] = [];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let released = 0;

  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (!sql.startsWith('INSERT INTO notifications')) {
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    }
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE id = id$/);
    let affectedRows = 0;
    for (let index = 0; index < values.length; index += columns.length) {
      const row = Object.fromEntries(
        columns.map((column, offset) => [column, values[index + offset]]),
      ) as unknown as StoredRow;
      const duplicate = rows.some(
        (existing) =>
          existing.recipient_id === row.recipient_id &&
          existing.type === row.type &&
          existing.subject_type === row.subject_type &&
          existing.subject_id === row.subject_id,
      );
      if (!duplicate) {
        rows.push(row);
        affectedRows += 1;
      }
    }
    return Promise.resolve([{ affectedRows }, []]);
  };

  const connection = {
    execute,
    release: () => {
      released += 1;
    },
  } as unknown as PoolConnection;

  return {
    rows,
    statements,
    connection,
    released: () => released,
  };
}

async function createService(connection?: PoolConnection) {
  const pool = {
    getConnection: () =>
      connection
        ? Promise.resolve(connection)
        : Promise.reject(new Error('Pool must not be used')),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [NotificationsService, { provide: MYSQL_POOL, useValue: pool }],
  }).compile();
  return module.get(NotificationsService);
}

describe('NotificationsService', () => {
  let table: ReturnType<typeof createTable>;
  let service: NotificationsService;

  beforeEach(async () => {
    table = createTable();
    service = await createService();
  });

  it.each(Object.values(entries))(
    'inserts one row with the entry columns for $type',
    async (entry) => {
      await service.record(table.connection, entry);

      expect(table.statements).toHaveLength(1);
      expect(table.statements[0].sql).toBe(
        'INSERT INTO notifications (id, recipient_id, type, actor_id, subject_type, subject_id, community_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id',
      );
      expect(table.statements[0].values).toEqual([
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        entry.recipientId,
        entry.type,
        entry.actorId,
        entry.subjectType,
        entry.subjectId,
        entry.communityId,
        JSON.stringify(entry.metadata),
      ]);
      expect(table.released()).toBe(0);
    },
  );

  it('stores a NULL actor for every moderation type', async () => {
    const moderation = [
      entries.report_resolved,
      entries.restriction_applied,
      entries.restriction_lifted,
      entries.content_removed,
    ];
    for (const entry of moderation) {
      await service.record(table.connection, entry);
    }

    expect(table.rows.map((row) => row.actor_id)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('rejects a moderation entry that names an actor', async () => {
    await expect(
      service.record(table.connection, {
        ...entries.restriction_applied,
        actorId: 'admin-1',
      } as unknown as NotificationEntry),
    ).rejects.toThrow('Invalid notification actor for restriction_applied');
    expect(table.statements).toHaveLength(0);
  });

  it('inserts a repeated event once and leaves the first row unchanged', async () => {
    await service.record(table.connection, entries.post_comment);
    const first = { ...table.rows[0] };
    await service.record(table.connection, {
      ...entries.post_comment,
      metadata: { ...entries.post_comment.metadata, excerpt: 'Edited.' },
    });

    expect(table.statements).toHaveLength(2);
    expect(table.rows).toEqual([first]);
  });

  it('suppresses self-notifications without throwing', async () => {
    await expect(
      service.record(table.connection, {
        ...entries.comment_reply,
        recipientId: 'replier',
      }),
    ).resolves.toBeUndefined();
    expect(table.statements).toHaveLength(0);
  });

  it('acquires and releases its own connection for standalone records', async () => {
    const standalone = await createService(table.connection);

    await standalone.record(entries.community_post);

    expect(table.rows).toHaveLength(1);
    expect(table.released()).toBe(1);
  });

  it('releases its own connection when the insert fails', async () => {
    const failing = {
      execute: () => Promise.reject(new Error('Insert failed')),
      release: () => {
        released += 1;
      },
    } as unknown as PoolConnection;
    let released = 0;
    const standalone = await createService(failing);

    await expect(standalone.record(entries.community_post)).rejects.toThrow(
      'Insert failed',
    );
    expect(released).toBe(1);
  });

  it('rejects an entry in the connection position and a connection alone', async () => {
    await expect(
      service.record(
        entries.post_comment as unknown as PoolConnection,
        entries.post_comment,
      ),
    ).rejects.toThrow(new TypeError('Expected a database connection'));
    await expect(
      service.record(table.connection as unknown as NotificationEntry),
    ).rejects.toThrow(new TypeError('Expected a notification entry'));
    await expect(
      service.recordMany(entries.post_comment as unknown as PoolConnection, [
        entries.post_comment,
      ]),
    ).rejects.toThrow(TypeError);
    expect(table.statements).toHaveLength(0);
  });

  it.each([
    ['an unknown type', { ...entries.post_comment, type: 'vote' }],
    [
      'a subject type that does not match the type',
      { ...entries.post_comment, subjectType: 'post' },
    ],
    [
      'a community on a platform-level type',
      { ...entries.report_resolved, communityId: 'community-1' },
    ],
    [
      'a missing community on a community type',
      { ...entries.community_post, communityId: null },
    ],
    ['a malformed recipient', { ...entries.post_comment, recipientId: 'a b' }],
  ])('rejects %s without writing', async (_, entry) => {
    await expect(
      service.record(table.connection, entry as unknown as NotificationEntry),
    ).rejects.toThrow(TypeError);
    expect(table.statements).toHaveLength(0);
  });

  it('rolls back with the caller transaction when the action fails afterwards', async () => {
    let committed: StoredRow[] = [];
    const pending: StoredRow[] = [];
    const connection = {
      beginTransaction: () => Promise.resolve(),
      execute: async (sql: string, values: unknown[]) => {
        const result = await (
          table.connection.execute as (
            sql: string,
            values: unknown[],
          ) => Promise<unknown>
        )(sql, values);
        pending.push(...table.rows.splice(0));
        return result;
      },
      commit: () => {
        committed = [...committed, ...pending.splice(0)];
        return Promise.resolve();
      },
      rollback: () => {
        pending.splice(0);
        return Promise.resolve();
      },
      release: () => undefined,
    } as unknown as PoolConnection;

    await connection.beginTransaction();
    try {
      await service.record(connection, entries.post_comment);
      expect(pending).toHaveLength(1);
      throw new Error('Comment insert failed after the notification');
    } catch {
      await connection.rollback();
    }

    expect(pending).toHaveLength(0);
    expect(committed).toHaveLength(0);
  });

  it('surfaces a notification failure so the caller rolls back its action', async () => {
    const failing = {
      execute: () => Promise.reject(new Error('Notification insert failed')),
    } as unknown as PoolConnection;

    await expect(service.record(failing, entries.post_comment)).rejects.toThrow(
      'Notification insert failed',
    );
  });

  describe('recordMany', () => {
    it('writes all entries in one statement and drops self-notifications', async () => {
      await service.recordMany(table.connection, [
        memberPost('member-1'),
        memberPost('poster'),
        memberPost('member-2'),
      ]);

      expect(table.statements).toHaveLength(1);
      expect(table.statements[0].sql.match(/\(\?, \?/g)).toHaveLength(2);
      expect(table.rows.map((row) => row.recipient_id)).toEqual([
        'member-1',
        'member-2',
      ]);
    });

    it('splits large fan-outs into bounded batches', async () => {
      const recipients = Array.from(
        { length: NOTIFICATION_BATCH_SIZE * 2 + 1 },
        (_, index) => memberPost(`member-${index}`),
      );

      await service.recordMany(table.connection, recipients);

      expect(
        table.statements.map((statement) => statement.values.length / 8),
      ).toEqual([NOTIFICATION_BATCH_SIZE, NOTIFICATION_BATCH_SIZE, 1]);
      expect(table.rows).toHaveLength(recipients.length);
    });

    it('is idempotent against the unique key', async () => {
      const batch = [memberPost('member-1'), memberPost('member-2')];
      await service.recordMany(table.connection, batch);
      await service.recordMany(table.connection, [
        ...batch,
        memberPost('member-3'),
      ]);

      expect(table.rows.map((row) => row.recipient_id)).toEqual([
        'member-1',
        'member-2',
        'member-3',
      ]);
    });

    it('validates every entry before writing any batch', async () => {
      const recipients = Array.from(
        { length: NOTIFICATION_BATCH_SIZE + 1 },
        (_, index) => memberPost(`member-${index}`),
      );
      recipients.push({
        ...memberPost('member-x'),
        metadata: [] as unknown as { post_title: string },
      });

      await expect(
        service.recordMany(table.connection, recipients),
      ).rejects.toThrow('Notification metadata must be an object');
      expect(table.statements).toHaveLength(0);
    });

    it('issues no statement for an empty or fully suppressed batch', async () => {
      await service.recordMany(table.connection, []);
      await service.recordMany(table.connection, [memberPost('poster')]);

      expect(table.statements).toHaveLength(0);
    });
  });
});
