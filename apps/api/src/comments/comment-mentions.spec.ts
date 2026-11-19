import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import type { CommunityBanPolicyService } from '../communities/community-ban-policy.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { MentionService } from '../notifications/mention.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { UserBlockPolicyService } from '../users/user-block-policy.service';
import { CommentsService } from './comments.service';

const created = new Date('2026-11-19T08:00:00.000Z');

// How CommentsService hands a comment to MentionService: on create, with
// the account post_comment or comment_reply already notifies; on an edit,
// with the version it replaces, and only when the content changed.
describe('CommentsService mentions', () => {
  let service: CommentsService;
  let mentions: { record: jest.Mock };
  let notifications: { record: jest.Mock };
  let editable: Record<string, unknown>;
  let parent: Record<string, unknown> | undefined;
  let order: string[];

  beforeEach(() => {
    order = [];
    parent = undefined;
    editable = {
      id: 'c-1',
      author_id: 'author',
      content: 'thanks @alice',
      created_at: created,
      edited_at: null,
      removed_at: null,
      post_removed_at: null,
      community_id: 'k-1',
      post_id: 'p-1',
      post_title: 'Tomatoes',
      post_author_id: 'post-author',
      parent_author_id: null,
    };
    const commentRow = (content: string, parentId: string | null = null) => ({
      id: 'c-new',
      post_id: 'p-1',
      author_id: 'author',
      parent_id: parentId,
      content,
      created_at: created,
      edited_at: null,
      locked_at: null,
      locked_by: null,
    });
    let lastContent = '';
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        order.push('commit');
        return Promise.resolve();
      },
      rollback: () => Promise.resolve(),
      release: () => undefined,
      execute: (sql: string, values: unknown[]) => {
        const rows = (value: unknown) => Promise.resolve([value, []]);
        if (sql.includes('FOR SHARE')) {
          return rows([
            {
              id: 'p-1',
              author_id: 'post-author',
              community_id: 'k-1',
              title: 'Tomatoes',
              locked_at: null,
              removed_at: null,
            },
          ]);
        }
        if (sql.includes('FOR UPDATE OF comments')) return rows([editable]);
        if (
          sql.startsWith('WITH RECURSIVE') ||
          sql.includes('parent_removed')
        ) {
          return rows(parent ? [parent] : []);
        }
        if (sql.startsWith('INSERT INTO comments')) {
          lastContent = values[4] as string;
          return rows({ affectedRows: 1 });
        }
        if (sql.startsWith('UPDATE comments SET content')) {
          lastContent = values[0] as string;
          return rows({ affectedRows: 1 });
        }
        if (/^SELECT .* FROM comments WHERE id = \? LIMIT 1$/s.test(sql)) {
          return rows([
            commentRow(lastContent || (editable.content as string)),
          ]);
        }
        if (sql.startsWith('INSERT')) return rows({ affectedRows: 1 });
        return rows([]);
      },
    };
    mentions = {
      record: jest.fn(() => {
        order.push('mentions');
        return Promise.resolve(0);
      }),
    };
    notifications = { record: jest.fn(() => Promise.resolve()) };
    service = new CommentsService(
      {
        getConnection: () => Promise.resolve(connection),
        execute: connection.execute,
      } as unknown as Pool,
      notifications as unknown as NotificationsService,
      {
        assertAcceptedOrThrow: () => Promise.resolve(),
      } as unknown as CommunityRuleAcceptanceService,
      {
        assertNotBlockedOrThrow: () => Promise.resolve(),
      } as unknown as UserBlockPolicyService,
      {
        assertNotBannedOrThrow: () => Promise.resolve(),
      } as unknown as CommunityBanPolicyService,
      mentions as unknown as MentionService,
    );
  });

  it('on create, passes the comment and skips the post author post_comment already notifies, before the commit', async () => {
    await service.create(
      'p-1',
      { content: ' @post_author @maintainer ' },
      'author',
    );

    expect(mentions.record).toHaveBeenCalledWith(expect.anything(), {
      authorId: 'author',
      communityId: 'k-1',
      subjectType: 'comment',
      subjectId: 'c-new',
      postId: 'p-1',
      postTitle: 'Tomatoes',
      text: '@post_author @maintainer',
      alreadyNotified: ['post-author'],
      excerpt: '@post_author @maintainer',
    });
    expect(order).toEqual(['mentions', 'commit']);
  });

  it('on an edit, passes the version it replaces and skips whom the comment notified', async () => {
    await service.update(
      'c-1',
      { content: 'thanks @alice and @bob' },
      'author',
    );

    expect(mentions.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subjectId: 'c-1',
        text: 'thanks @alice and @bob',
        previousText: 'thanks @alice',
        alreadyNotified: ['post-author'],
      }),
    );
  });

  it('on an edit of a reply, skips the parent comment author instead', async () => {
    editable = { ...editable, parent_author_id: 'parent-author' };
    await service.update('c-1', { content: '@parent @x' }, 'author');
    expect(mentions.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ alreadyNotified: ['parent-author'] }),
    );
  });

  it('records nothing for an edit that changes nothing', async () => {
    await service.update('c-1', { content: 'thanks @alice' }, 'author');
    expect(mentions.record).not.toHaveBeenCalled();
  });
});
