import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { CLOSE_COMMUNITY_REPORTS_SQL } from '../reports/community-report-review';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  ADMIN_COMMENT_DETAIL_SQL,
  ADMIN_POST_DETAIL_SQL,
  ADMIN_REMOVE_SQL,
  ADMIN_RESTORE_SQL,
  AdminContentService,
  LOCK_COMMENT_SQL,
  LOCK_POST_SQL,
} from './admin-content.service';
import type { AuditLogService } from './audit-log.service';
import {
  ListAdminCommentsDto,
  ListAdminPostsDto,
} from './dto/admin-content.dto';

const created = new Date('2026-11-01T10:00:00.000Z');

const detailRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'post-1',
  community_id: 'community-1',
  community_name: 'garden',
  community_state: 'suspended',
  author_id: 'author',
  author_username: 'sam',
  created_at: created,
  edited_at: null,
  score: '3',
  locked_at: null,
  removed_at: null,
  removed_by: null,
  removed_by_username: null,
  removal_reason: null,
  removed_by_admin: 0,
  title: 'Tomatoes',
  type: 'text',
  pinned_at: null,
  content: 'Body',
  upvotes: '4',
  downvotes: '1',
  comment_count: '2',
  open_report_count: '1',
  ...overrides,
});

describe('AdminContentService', () => {
  let service: AdminContentService;
  let locked: Record<string, unknown> | undefined;
  let detail: Record<string, unknown>;
  let affected: number;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let audit: { record: jest.Mock };
  let notifications: { record: jest.Mock };
  let tx: string[];

  beforeEach(() => {
    calls = [];
    tx = [];
    affected = 1;
    locked = {
      id: 'post-1',
      author_id: 'author',
      title: 'Tomatoes',
      content: 'A comment',
      community_id: 'community-1',
      community_name: 'garden',
      removed_at: null,
      removed_by_admin: 0,
      post_removed_at: null,
    };
    detail = detailRow();
    const execute = (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql === LOCK_POST_SQL || sql === LOCK_COMMENT_SQL) {
        return Promise.resolve([locked ? [locked] : [], []]);
      }
      if (sql === ADMIN_POST_DETAIL_SQL || sql === ADMIN_COMMENT_DETAIL_SQL) {
        return Promise.resolve([[detail], []]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total')) {
        return Promise.resolve([[{ total: '1' }], []]);
      }
      if (sql.startsWith('SELECT')) {
        return Promise.resolve([[detail], []]);
      }
      return Promise.resolve([{ affectedRows: affected }, []]);
    };
    const connection = {
      beginTransaction: () => {
        tx.push('begin');
        return Promise.resolve();
      },
      commit: () => {
        tx.push('commit');
        return Promise.resolve();
      },
      rollback: () => {
        tx.push('rollback');
        return Promise.resolve();
      },
      release: () => {
        tx.push('release');
      },
      execute,
    };
    audit = { record: jest.fn(() => Promise.resolve()) };
    notifications = { record: jest.fn(() => Promise.resolve()) };
    service = new AdminContentService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      audit as unknown as AuditLogService,
      notifications as unknown as NotificationsService,
    );
  });

  const writes = () =>
    calls.filter(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql));

  describe('reads', () => {
    it('lists every post with no hidden filter, newest first, and states the filters', async () => {
      const result = await service.findPosts(new ListAdminPostsDto());
      const [list, count] = calls;
      expect(list.sql).not.toMatch(/WHERE/);
      expect(list.sql).toMatch(
        /ORDER BY p\.created_at DESC, p\.id DESC LIMIT \? OFFSET \?$/,
      );
      expect(list.values).toEqual([20, 0]);
      expect(count.sql).toMatch(/^SELECT COUNT\(\*\) AS total FROM posts p/);
      expect(result.total).toBe(1);
      expect(result.filters).toEqual({
        search: null,
        community_id: null,
        author_username: null,
        state: 'any',
        community_state: 'any',
        sort: 'new',
      });
      expect(result.items[0]).toMatchObject({
        id: 'post-1',
        community_state: 'suspended',
        score: 3,
        removal: null,
      });
    });

    it.each([
      ['visible', 'p.removed_at IS NULL'],
      ['removed', 'p.removed_at IS NOT NULL'],
      [
        'moderator_removed',
        'p.removed_at IS NOT NULL AND p.removed_by_admin = FALSE',
      ],
      ['admin_removed', 'p.removed_by_admin = TRUE'],
    ] as const)('filters state=%s by %s', async (state, predicate) => {
      await service.findPosts(
        Object.assign(new ListAdminPostsDto(), { state }),
      );
      expect(calls[0].sql).toContain(`WHERE ${predicate}`);
    });

    it('binds every filter value and escapes the search', async () => {
      await service.findComments(
        Object.assign(new ListAdminCommentsDto(), {
          search: '50%_off',
          community_id: 'community-1',
          author_username: 'sam',
          post_id: 'post-1',
          community_state: 'deleted',
          sort: 'oldest',
          page: 3,
          limit: 10,
        }),
      );
      expect(calls[0].sql).toContain(
        "LOWER(cm.content) LIKE LOWER(?) ESCAPE '='",
      );
      expect(calls[0].sql).toContain('c.deleted_at IS NOT NULL');
      expect(calls[0].sql).toContain('ORDER BY cm.created_at ASC, cm.id ASC');
      expect(calls[0].values).toEqual([
        '%50=%=_off%',
        'community-1',
        'sam',
        'post-1',
        10,
        20,
      ]);
      expect(calls[1].values).toEqual([
        '%50=%=_off%',
        'community-1',
        'sam',
        'post-1',
      ]);
    });

    it('distinguishes an administrator removal from a moderator removal', async () => {
      detail = detailRow({
        removed_at: created,
        removed_by: 'admin-1',
        removed_by_username: 'root',
        removal_reason: 'Doxxing',
        removed_by_admin: 1,
      });
      await expect(service.findPost('post-1')).resolves.toMatchObject({
        removal: {
          removed_at: created.toISOString(),
          removed_by_id: 'admin-1',
          removed_by_username: 'root',
          reason: 'Doxxing',
          source: 'admin',
        },
        comment_count: 2,
        open_report_count: 1,
      });
      detail = detailRow({ removed_at: created, removed_by_admin: 0 });
      await expect(service.findPost('post-1')).resolves.toMatchObject({
        removal: { source: 'moderator', removed_by_id: null },
      });
    });

    // A suspended or deleted community never hides content here.
    it('reads by id alone, whatever the community state', () => {
      expect(ADMIN_POST_DETAIL_SQL).toMatch(/WHERE p\.id = \? LIMIT 1$/);
      expect(ADMIN_COMMENT_DETAIL_SQL).toMatch(/WHERE cm\.id = \? LIMIT 1$/);
      for (const sql of [
        ADMIN_POST_DETAIL_SQL,
        ADMIN_COMMENT_DETAIL_SQL,
        LOCK_POST_SQL,
        LOCK_COMMENT_SQL,
      ]) {
        expect(sql).not.toMatch(/\bc\.(suspended_at|deleted_at) IS NULL/);
      }
    });

    it('answers 404 for an unknown post or comment', async () => {
      detail = undefined as unknown as Record<string, unknown>;
      await expect(service.findPost('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.findComment('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('removal', () => {
    it('removes visible content as an administrator, notifies without reason or actor, closes community reports and audits the reason', async () => {
      await service.removePost('post-1', { reason: 'Doxxing' }, 'admin-1');

      expect(writes()).toEqual([
        {
          sql: ADMIN_REMOVE_SQL('posts'),
          values: ['admin-1', 'Doxxing', 'post-1'],
        },
        {
          sql: CLOSE_COMMUNITY_REPORTS_SQL,
          values: ['removed', 'admin-1', 'community-1', 'post', 'post-1'],
        },
      ]);
      expect(ADMIN_REMOVE_SQL('posts')).toContain('removed_by_admin = TRUE');
      expect(notifications.record).toHaveBeenCalledWith(expect.anything(), {
        recipientId: 'author',
        type: 'content_removed',
        actorId: null,
        subjectType: 'post',
        subjectId: 'post-1',
        communityId: 'community-1',
        metadata: { post_title: 'Tomatoes' },
      });
      expect(audit.record).toHaveBeenCalledWith(expect.anything(), {
        actorId: 'admin-1',
        action: 'post_removed',
        targetType: 'post',
        targetId: 'post-1',
        metadata: {
          community_name: 'garden',
          previous_state: 'visible',
          reason: 'Doxxing',
        },
      });
      expect(tx).toEqual(['begin', 'commit', 'release']);
    });

    it("takes over a moderator's removal without notifying the author again", async () => {
      locked = { ...locked, removed_at: created, removed_by_admin: 0 };
      await service.removeComment(
        'comment-1',
        { reason: 'Escalated' },
        'admin-1',
      );

      expect(writes()[0]).toEqual({
        sql: ADMIN_REMOVE_SQL('comments'),
        values: ['admin-1', 'Escalated', 'post-1'],
      });
      expect(notifications.record).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'comment_removed',
          targetType: 'comment',
          metadata: expect.objectContaining({
            previous_state: 'moderator_removed',
          }),
        }),
      );
    });

    it("answers 409 for an administrator's removal, writing nothing", async () => {
      locked = { ...locked, removed_at: created, removed_by_admin: 1 };
      await expect(
        service.removePost('post-1', { reason: 'Again' }, 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(writes()).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
      expect(tx).toEqual(['begin', 'rollback', 'release']);
    });

    it('answers 404 for unknown content', async () => {
      locked = undefined;
      await expect(
        service.removeComment('nope', { reason: 'x' }, 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rolls the removal back when the audit entry fails', async () => {
      audit.record.mockImplementationOnce(() =>
        Promise.reject(new Error('audit failed')),
      );
      await expect(
        service.removePost('post-1', { reason: 'Doxxing' }, 'admin-1'),
      ).rejects.toThrow('audit failed');
      expect(tx).toEqual(['begin', 'rollback', 'release']);
    });
  });

  describe('restoration', () => {
    it.each([
      [1, 'admin_removed'],
      [0, 'moderator_removed'],
    ] as const)(
      'restores any removal (removed_by_admin=%s) and audits it as %s',
      async (flag, previous) => {
        locked = { ...locked, removed_at: created, removed_by_admin: flag };
        await service.restorePost(
          'post-1',
          { reason: 'Appeal upheld' },
          'admin-1',
        );

        expect(writes()).toEqual([
          { sql: ADMIN_RESTORE_SQL('posts'), values: ['post-1'] },
        ]);
        expect(ADMIN_RESTORE_SQL('posts')).toContain(
          'removed_by_admin = FALSE',
        );
        expect(notifications.record).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(expect.anything(), {
          actorId: 'admin-1',
          action: 'post_restored',
          targetType: 'post',
          targetId: 'post-1',
          metadata: {
            community_name: 'garden',
            previous_state: previous,
            reason: 'Appeal upheld',
          },
        });
      },
    );

    it('answers 409 for visible content', async () => {
      await expect(
        service.restoreComment('comment-1', { reason: 'x' }, 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(writes()).toEqual([]);
    });

    it('answers 409 for a comment whose post is removed', async () => {
      locked = {
        ...locked,
        removed_at: created,
        removed_by_admin: 1,
        post_removed_at: created,
      };
      await expect(
        service.restoreComment('comment-1', { reason: 'x' }, 'admin-1'),
      ).rejects.toThrow('restore the post first');
      expect(writes()).toEqual([]);
    });

    it('answers 409 when the row changed concurrently', async () => {
      locked = { ...locked, removed_at: created };
      affected = 0;
      await expect(
        service.restorePost('post-1', { reason: 'x' }, 'admin-1'),
      ).rejects.toThrow('changed concurrently');
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
