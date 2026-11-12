import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { readableCommunitySql } from '../common/community-visibility';
import { REMOVED_CONTENT_REVIEWER_SQL } from '../common/removed-content';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  commentListOrder,
  CommentsService,
  MAX_LOCK_ANCESTOR_DEPTH,
  PERMALINK_ANCESTORS_SQL,
  PERMALINK_COMMENT_SQL,
  THREAD_POST_SQL,
} from './comments.service';

interface Row {
  id: string;
  parent_id: string | null;
  removed?: boolean;
}

// A post p-1 in community-1 with the comments given, answering each
// statement of the permalink and thread reads by its SQL.
function harness(
  rows: Row[],
  options: {
    reviewer?: boolean;
    postRemoved?: boolean;
    communityHidden?: boolean;
  } = {},
) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const reviewerChecks = jest.fn();
  const comment = (row: Row) => ({
    id: row.id,
    post_id: 'p-1',
    parent_id: row.parent_id,
    author_id: `author-of-${row.id}`,
    content: `content of ${row.id}`,
    created_at: new Date('2026-11-10T12:00:00Z'),
    edited_at: null,
    locked_at: null,
    locked_by: null,
    removed_at: row.removed ? new Date('2026-11-11T08:00:00Z') : null,
    removed_by: row.removed ? 'moderator' : null,
    removal_reason: row.removed ? 'Spam' : null,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql === PERMALINK_COMMENT_SQL) {
      const row = byId.get(values[0] as string);
      return Promise.resolve([
        row && !options.communityHidden
          ? [
              {
                ...comment(row),
                community_id: 'community-1',
                post_removed_at: options.postRemoved
                  ? new Date('2026-11-11T09:00:00Z')
                  : null,
              },
            ]
          : [],
        [],
      ]);
    }
    if (sql === PERMALINK_ANCESTORS_SQL) {
      const chain: Row[] = [];
      let next = byId.get(values[0] as string);
      while (next && chain.length < Number(values[1])) {
        chain.push(next);
        next = next.parent_id ? byId.get(next.parent_id) : undefined;
      }
      return Promise.resolve([chain.reverse().map(comment), []]);
    }
    if (sql === REMOVED_CONTENT_REVIEWER_SQL) {
      reviewerChecks();
      return Promise.resolve([[{ can_review: options.reviewer ? 1 : 0 }], []]);
    }
    if (sql === THREAD_POST_SQL) {
      return Promise.resolve([
        [{ community_id: 'community-1', removed_at: null }],
        [],
      ]);
    }
    if (sql.startsWith('SELECT parent_id, COUNT(*)')) {
      return Promise.resolve([
        [{ parent_id: rows[0]?.id, reply_count: '1' }],
        [],
      ]);
    }
    if (sql.startsWith('SELECT target_id, SUM(value)')) {
      return Promise.resolve([[{ target_id: rows[0]?.id, score: '4' }], []]);
    }
    if (sql.includes('COUNT(*) AS total')) {
      return Promise.resolve([[{ total: 0 }], []]);
    }
    if (sql.includes('FROM posts')) {
      return Promise.resolve([[{ id: 'p-1' }], []]);
    }
    return Promise.resolve([rows.map(comment), []]);
  };
  const pool = { execute } as unknown as Pool;
  const service = new CommentsService(
    pool,
    {} as NotificationsService,
    {} as CommunityRuleAcceptanceService,
  );
  return { service, statements, reviewerChecks };
}

const CHAIN: Row[] = [
  { id: 'c-1', parent_id: null },
  { id: 'c-2', parent_id: 'c-1' },
  { id: 'c-3', parent_id: 'c-2' },
];

describe('GET /comments/:id', () => {
  it('returns a top-level comment without ancestors, in the flat shape', async () => {
    const { service, statements } = harness(CHAIN);
    await expect(service.findPermalink('c-1')).resolves.toEqual({
      post_id: 'p-1',
      comment: {
        id: 'c-1',
        post_id: 'p-1',
        parent_id: null,
        author_id: 'author-of-c-1',
        content: 'content of c-1',
        created_at: '2026-11-10T12:00:00.000Z',
        edited_at: null,
        locked_at: null,
        locked_by: null,
        reply_count: 1,
        score: 4,
      },
      ancestors: [],
    });
    expect(statements.some(({ sql }) => sql === PERMALINK_ANCESTORS_SQL)).toBe(
      false,
    );
  });

  it('returns the chain above a reply, root first, bounded like the lock walk', async () => {
    const { service, statements } = harness(CHAIN);
    const result = await service.findPermalink('c-3');
    expect(result.comment.id).toBe('c-3');
    expect(result.ancestors.map((item) => item.id)).toEqual(['c-1', 'c-2']);
    expect(
      statements.find(({ sql }) => sql === PERMALINK_ANCESTORS_SQL)?.values,
    ).toEqual(['c-2', MAX_LOCK_ANCESTOR_DEPTH]);
  });

  it('resolves the comment through its post, excluding hidden communities', async () => {
    expect(PERMALINK_COMMENT_SQL).toContain(
      'INNER JOIN posts ON posts.id = comments.post_id',
    );
    // Viewer-aware (migration 038): a private community's comments are its
    // members'.
    expect(PERMALINK_COMMENT_SQL).toContain(
      readableCommunitySql('posts.community_id'),
    );
    const { service } = harness(CHAIN, { communityHidden: true });
    await expect(service.findPermalink('c-3')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('is 404 for an unknown or deleted comment', async () => {
    const { service } = harness(CHAIN);
    await expect(service.findPermalink('gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('checks no reviewer when nothing on the chain is removed', async () => {
    const { service, reviewerChecks } = harness(CHAIN);
    await service.findPermalink('c-3', 'viewer');
    expect(reviewerChecks).not.toHaveBeenCalled();
  });

  describe('a removed comment', () => {
    const removed = CHAIN.map((row) =>
      row.id === 'c-3' ? { ...row, removed: true } : row,
    );

    it.each([undefined, 'viewer'])(
      'is 404 to a caller who may not review it (%s)',
      async (viewer) => {
        const { service } = harness(removed);
        await expect(
          service.findPermalink('c-3', viewer),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('is shown to a reviewer with its removal state', async () => {
      const { service } = harness(removed, { reviewer: true });
      const result = await service.findPermalink('c-3', 'moderator');
      expect(result.comment).toMatchObject({
        id: 'c-3',
        content: 'content of c-3',
        removed: true,
        removed_at: '2026-11-11T08:00:00.000Z',
        removed_by: 'moderator',
        removal_reason: 'Spam',
      });
    });
  });

  it('is 404 under a removed post, except for a reviewer', async () => {
    await expect(
      harness(CHAIN, { postRemoved: true }).service.findPermalink('c-3', 'v'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      harness(CHAIN, {
        postRemoved: true,
        reviewer: true,
      }).service.findPermalink('c-3', 'moderator'),
    ).resolves.toMatchObject({ comment: { id: 'c-3' } });
  });

  describe('a removed ancestor', () => {
    const removed = CHAIN.map((row) =>
      row.id === 'c-1' ? { ...row, removed: true } : row,
    );

    it('is a tombstone to everyone but reviewers, keeping its place', async () => {
      const { service, reviewerChecks } = harness(removed);
      const result = await service.findPermalink('c-3', 'viewer');
      expect(result.ancestors[0]).toEqual({
        id: 'c-1',
        post_id: 'p-1',
        parent_id: null,
        created_at: '2026-11-10T12:00:00.000Z',
        removed: true,
      });
      expect(result.ancestors[1]).toMatchObject({
        id: 'c-2',
        content: 'content of c-2',
      });
      expect(reviewerChecks).toHaveBeenCalledTimes(1);
    });

    it('is shown in full to a reviewer', async () => {
      const { service } = harness(removed, { reviewer: true });
      const result = await service.findPermalink('c-3', 'moderator');
      expect(result.ancestors[0]).toMatchObject({
        id: 'c-1',
        content: 'content of c-1',
        removed: true,
        removal_reason: 'Spam',
      });
    });
  });
});

describe('comment sorts', () => {
  it.each([
    ['oldest', 'ORDER BY created_at ASC, id ASC'],
    ['new', 'ORDER BY created_at DESC, id DESC'],
    ['top', 'ORDER BY score DESC, created_at ASC, id ASC'],
    ['controversial', 'ORDER BY controversy DESC, created_at ASC, id ASC'],
  ] as const)('sort=%s orders %s', (sort, order) => {
    expect(commentListOrder(sort)).toBe(order);
  });

  it.each(['oldest', 'top', 'controversial'] as const)(
    'the thread orders its siblings by sort=%s',
    async (sort) => {
      const { service, statements } = harness(CHAIN);
      await service.findThread('p-1', undefined, { sort });
      const listing = statements.find(({ sql }) =>
        sql.includes('FROM comments WHERE post_id = ?'),
      );
      expect(listing?.sql).toContain(`${commentListOrder(sort)} LIMIT ?`);
    },
  );

  it('the thread defaults to oldest', async () => {
    const { service, statements } = harness(CHAIN);
    await service.findThread('p-1');
    expect(
      statements.find(({ sql }) => sql.includes('FROM comments WHERE post_id'))
        ?.sql,
    ).toContain('ORDER BY created_at ASC, id ASC LIMIT ?');
  });

  // Rows arrive in sort order, and each level keeps it.
  it('keeps the row order among siblings at every depth', async () => {
    const { service } = harness([
      { id: 'b', parent_id: null },
      { id: 'a', parent_id: null },
      { id: 'b-2', parent_id: 'b' },
      { id: 'b-1', parent_id: 'b' },
    ]);
    const thread = await service.findThread('p-1', undefined, { sort: 'top' });
    expect(thread.comments.map((node) => node.id)).toEqual(['b', 'a']);
    expect(thread.comments[0].replies.map((node) => node.id)).toEqual([
      'b-2',
      'b-1',
    ]);
  });

  it.each(['top', 'controversial'] as const)(
    'the top-level and replies pages order by sort=%s',
    async (sort) => {
      const { service, statements } = harness(CHAIN);
      await service.findTopLevel('p-1', { sort });
      await service.findReplies('c-1', { sort });
      const pages = statements.filter(({ sql }) =>
        sql.includes('LIMIT ? OFFSET ?'),
      );
      expect(pages).toHaveLength(2);
      for (const page of pages) {
        expect(page.sql).toContain(
          `${commentListOrder(sort)} LIMIT ? OFFSET ?`,
        );
      }
    },
  );
});
