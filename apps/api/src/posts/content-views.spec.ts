import { beforeEach, describe, expect, it } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { REMOVED_CONTENT_REVIEWER_SQL } from '../common/removed-content';
import {
  COMMENT_REVISION_SUBJECT_SQL,
  COMMENT_REVISIONS_SQL,
  COMMENT_REVISIONS_SUMMARY_SQL,
  ContentRevisionsService,
  POST_REVISION_SUBJECT_SQL,
  POST_REVISIONS_SQL,
  POST_REVISIONS_SUMMARY_SQL,
} from './content-revisions.service';
import {
  HIDDEN_POSTS_COUNT_SQL,
  HIDE_POST_SQL,
  HiddenPostsService,
  hiddenPostsSql,
  UNHIDE_POST_SQL,
} from './hidden-posts.service';
import {
  LABEL_POST_SQL,
  PostLabelsService,
  SET_LABEL_SQL,
} from './post-labels.service';
import {
  ANY_COMMENT_SQL,
  SAVE_COMMENT_SQL,
  SAVEABLE_COMMENT_SQL,
  SAVED_COMMENTS_COUNT_SQL,
  SavedCommentsService,
  savedCommentsSql,
  UNSAVE_COMMENT_SQL,
} from './saved-comments.service';
import { ANY_POST_SQL, SAVEABLE_POST_SQL } from './saved-posts.service';
import {
  VOTED_COMMENTS_COUNT_SQL,
  VOTED_COMMENTS_SQL,
  VOTED_POSTS_COUNT_SQL,
  VOTED_POSTS_SQL,
  VoteHistoryService,
} from './vote-history.service';

type Answer = unknown[] | { affectedRows: number };

function harness() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const answers = new Map<string, Answer>();
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return Promise.resolve([answers.get(sql) ?? [], []]);
  };
  const connection = {
    execute,
    beginTransaction: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    release: () => undefined,
  };
  const pool = {
    execute,
    getConnection: () => Promise.resolve(connection),
  } as unknown as Pool;
  return { pool, statements, answers };
}

describe('PostLabelsService', () => {
  let h: ReturnType<typeof harness>;
  let service: PostLabelsService;
  const post = (overrides: Record<string, unknown> = {}) => [
    {
      id: 'p-1',
      author_id: 'author',
      removed_at: null,
      nsfw_set_by: null,
      spoiler_set_by: null,
      can_moderate: 0,
      ...overrides,
    },
  ];
  const writes = () =>
    h.statements.filter(({ sql }) => sql.startsWith('UPDATE posts'));

  beforeEach(() => {
    h = harness();
    service = new PostLabelsService(h.pool);
  });

  it('records an author’s label as the author’s, binding the caller for every check', async () => {
    h.answers.set(LABEL_POST_SQL, post());
    await service.set('p-1', 'nsfw', 'author');
    expect(h.statements[0].values).toEqual([
      'author',
      'author',
      'p-1',
      'author',
    ]);
    expect(writes()).toEqual([
      { sql: SET_LABEL_SQL.nsfw, values: ['author', 'p-1'] },
    ]);
  });

  it('records a moderator’s label as theirs, and keeps it theirs when the author sets it again', async () => {
    h.answers.set(LABEL_POST_SQL, post({ can_moderate: 1 }));
    await service.set('p-1', 'spoiler', 'mod');
    expect(writes()).toEqual([
      { sql: SET_LABEL_SQL.spoiler, values: ['moderator', 'p-1'] },
    ]);

    h.answers.set(LABEL_POST_SQL, post({ spoiler_set_by: 'moderator' }));
    await service.set('p-1', 'spoiler', 'author');
    expect(writes()).toHaveLength(1);
  });

  it('lets only moderators remove a moderator’s label', async () => {
    h.answers.set(LABEL_POST_SQL, post({ nsfw_set_by: 'moderator' }));
    await expect(service.clear('p-1', 'nsfw', 'author')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(writes()).toEqual([]);

    h.answers.set(
      LABEL_POST_SQL,
      post({ nsfw_set_by: 'moderator', can_moderate: 1 }),
    );
    await service.clear('p-1', 'nsfw', 'mod');
    expect(writes()).toEqual([
      { sql: SET_LABEL_SQL.nsfw, values: [null, 'p-1'] },
    ]);
  });

  it('lets the author remove their own label, and is idempotent', async () => {
    h.answers.set(LABEL_POST_SQL, post({ nsfw_set_by: 'author' }));
    await service.clear('p-1', 'nsfw', 'author');
    h.answers.set(LABEL_POST_SQL, post());
    await service.clear('p-1', 'nsfw', 'author');
    expect(writes()).toHaveLength(1);
  });

  it('refuses everyone else, and hides a removed post from its author', async () => {
    h.answers.set(LABEL_POST_SQL, post());
    await expect(service.set('p-1', 'nsfw', 'someone')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    h.answers.set(LABEL_POST_SQL, post({ removed_at: new Date() }));
    await expect(service.set('p-1', 'nsfw', 'author')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    h.answers.set(LABEL_POST_SQL, []);
    await expect(service.set('p-1', 'nsfw', 'author')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(writes()).toEqual([]);
  });
});

describe('HiddenPostsService', () => {
  it('hides a readable post, idempotently, and unhides any existing one', async () => {
    const h = harness();
    const service = new HiddenPostsService(h.pool);
    h.answers.set(SAVEABLE_POST_SQL, [{ id: 'p-1' }]);
    h.answers.set(ANY_POST_SQL, [{ id: 'p-1' }]);

    await service.hide('p-1', 'sam');
    await service.unhide('p-1', 'sam');

    expect(h.statements).toEqual([
      { sql: SAVEABLE_POST_SQL, values: ['p-1', 'sam'] },
      { sql: HIDE_POST_SQL, values: ['sam', 'p-1'] },
      { sql: ANY_POST_SQL, values: ['p-1'] },
      { sql: UNHIDE_POST_SQL, values: ['sam', 'p-1'] },
    ]);
    expect(HIDE_POST_SQL).toContain(
      'ON DUPLICATE KEY UPDATE created_at = created_at',
    );
  });

  it('is 404 hiding a post the caller cannot read', async () => {
    const h = harness();
    await expect(
      new HiddenPostsService(h.pool).hide('p-1', 'sam'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.statements).toHaveLength(1);
  });

  it('lists the caller’s hidden posts that are still readable, newest hidden first', async () => {
    const h = harness();
    h.answers.set(HIDDEN_POSTS_COUNT_SQL, [{ total: '0' }]);
    await new HiddenPostsService(h.pool).list('sam', { page: 2, limit: 5 });
    expect(h.statements[0]).toEqual({
      sql: hiddenPostsSql('new'),
      values: ['sam', 'sam', 5, 5],
    });
    expect(hiddenPostsSql('new')).toContain('ORDER BY h.created_at DESC');
    expect(HIDDEN_POSTS_COUNT_SQL).toContain('p.removed_at IS NULL');
    expect(HIDDEN_POSTS_COUNT_SQL).toContain(
      "communities.visibility <> 'private'",
    );
  });
});

describe('SavedCommentsService', () => {
  it('saves only a readable comment and unsaves any existing one', async () => {
    const h = harness();
    const service = new SavedCommentsService(h.pool);
    await expect(service.save('c-1', 'sam')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    h.answers.set(SAVEABLE_COMMENT_SQL, [{ id: 'c-1' }]);
    h.answers.set(ANY_COMMENT_SQL, [{ id: 'c-1' }]);
    await service.save('c-1', 'sam');
    await service.unsave('c-1', 'sam');
    expect(h.statements.slice(1)).toEqual([
      { sql: SAVEABLE_COMMENT_SQL, values: ['c-1', 'sam'] },
      { sql: SAVE_COMMENT_SQL, values: ['sam', 'c-1'] },
      { sql: ANY_COMMENT_SQL, values: ['c-1'] },
      { sql: UNSAVE_COMMENT_SQL, values: ['sam', 'c-1'] },
    ]);
    for (const fragment of [
      'comments.removed_at IS NULL',
      'posts.removed_at IS NULL',
      "communities.visibility <> 'private'",
    ]) {
      expect(SAVEABLE_COMMENT_SQL).toContain(fragment);
    }
  });

  it('omits saves of hidden comments exactly as saved posts do', async () => {
    const h = harness();
    h.answers.set(SAVED_COMMENTS_COUNT_SQL, [{ total: 0 }]);
    h.answers.set(savedCommentsSql('oldest'), [
      {
        id: 'c-1',
        post_id: 'p-1',
        content: 'Nice',
        created_at: new Date('2026-11-01T10:00:00Z'),
        edited_at: null,
        post_title: 'Seeds',
        community_name: 'garden',
        saved_at: new Date('2026-11-02T10:00:00Z'),
      },
    ]);
    const result = await new SavedCommentsService(h.pool).list('sam', {
      sort: 'oldest',
    });
    expect(result.items).toEqual([
      {
        comment: {
          id: 'c-1',
          post_id: 'p-1',
          content: 'Nice',
          created_at: '2026-11-01T10:00:00.000Z',
          edited_at: null,
          post_title: 'Seeds',
          community_name: 'garden',
          score: 0,
        },
        saved_at: '2026-11-02T10:00:00.000Z',
      },
    ]);
    for (const fragment of [
      'c.removed_at IS NULL',
      'p.removed_at IS NULL',
      'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
    ]) {
      expect(SAVED_COMMENTS_COUNT_SQL).toContain(fragment);
    }
  });
});

describe('VoteHistoryService', () => {
  it.each([
    [1, 'posts', VOTED_POSTS_SQL, VOTED_POSTS_COUNT_SQL],
    [-1, 'posts', VOTED_POSTS_SQL, VOTED_POSTS_COUNT_SQL],
    [1, 'comments', VOTED_COMMENTS_SQL, VOTED_COMMENTS_COUNT_SQL],
  ] as const)(
    'lists the caller’s %s votes on %s, bound to the caller only',
    async (direction, type, listSql, countSql) => {
      const h = harness();
      h.answers.set(countSql, [{ total: 0 }]);
      const result = await new VoteHistoryService(h.pool).list(
        'sam',
        direction,
        { type },
      );
      expect(result).toEqual({ type, items: [], page: 1, limit: 20, total: 0 });
      expect(h.statements).toEqual([
        { sql: countSql, values: ['sam', direction, 'sam'] },
        { sql: listSql, values: ['sam', direction, 'sam', 20, 0] },
      ]);
    },
  );

  it('omits removed content and content in hidden communities', () => {
    for (const sql of [VOTED_POSTS_COUNT_SQL, VOTED_COMMENTS_COUNT_SQL]) {
      expect(sql).toContain('p.removed_at IS NULL');
      expect(sql).toContain(
        'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
      );
      expect(sql).toContain("communities.visibility <> 'private'");
    }
    expect(VOTED_COMMENTS_COUNT_SQL).toContain('c.removed_at IS NULL');
    expect(VOTED_POSTS_SQL).toMatch(/ORDER BY v\.created_at DESC, v\.id DESC/);
  });
});

describe('ContentRevisionsService', () => {
  const subject = (overrides: Record<string, unknown> = {}) => [
    {
      community_id: 'c-1',
      title: 'Now',
      content: 'Current text',
      created_at: new Date('2026-11-01T10:00:00Z'),
      edited_at: new Date('2026-11-03T10:00:00Z'),
      removed: 0,
      ...overrides,
    },
  ];

  it('separates the current version from earlier ones, with both timestamps', async () => {
    const h = harness();
    h.answers.set(POST_REVISION_SUBJECT_SQL, subject());
    h.answers.set(POST_REVISIONS_SQL, [
      {
        title: 'Before',
        content: 'Old text',
        version_at: new Date('2026-11-01T10:00:00Z'),
        replaced_at: new Date('2026-11-03T10:00:00Z'),
      },
    ]);
    h.answers.set(POST_REVISIONS_SUMMARY_SQL, [
      { total: 1, first_version_at: new Date('2026-11-01T10:00:00Z') },
    ]);

    await expect(
      new ContentRevisionsService(h.pool).forPost('p-1', 'sam', {}),
    ).resolves.toEqual({
      current: {
        title: 'Now',
        content: 'Current text',
        version_at: '2026-11-03T10:00:00.000Z',
        edited: true,
      },
      items: [
        {
          title: 'Before',
          content: 'Old text',
          version_at: '2026-11-01T10:00:00.000Z',
          replaced_at: '2026-11-03T10:00:00.000Z',
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
      complete: true,
    });
    expect(h.statements[0].values).toEqual(['p-1', 'sam']);
  });

  it('says the history is incomplete when edits before 039 left nothing', async () => {
    const h = harness();
    h.answers.set(COMMENT_REVISION_SUBJECT_SQL, subject({ title: undefined }));
    h.answers.set(COMMENT_REVISIONS_SUMMARY_SQL, [
      { total: 0, first_version_at: null },
    ]);
    const result = await new ContentRevisionsService(h.pool).forComment(
      'c-1',
      undefined,
      {},
    );
    expect(result).toMatchObject({
      current: { title: null, edited: true },
      items: [],
      complete: false,
    });
    expect(h.statements.map(({ sql }) => sql)).toContain(COMMENT_REVISIONS_SQL);
  });

  it('is complete for content never edited', async () => {
    const h = harness();
    h.answers.set(POST_REVISION_SUBJECT_SQL, subject({ edited_at: null }));
    await expect(
      new ContentRevisionsService(h.pool).forPost('p-1', undefined, {}),
    ).resolves.toMatchObject({
      current: { version_at: '2026-11-01T10:00:00.000Z', edited: false },
      complete: true,
    });
  });

  it('gives a removed post’s history only to its reviewers, and nothing for unreadable content', async () => {
    const h = harness();
    const service = new ContentRevisionsService(h.pool);
    h.answers.set(POST_REVISION_SUBJECT_SQL, subject({ removed: 1 }));
    await expect(service.forPost('p-1', 'sam', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.forPost('p-1', undefined, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.statements.map(({ sql }) => sql)).not.toContain(
      POST_REVISIONS_SQL,
    );

    h.answers.set(REMOVED_CONTENT_REVIEWER_SQL, [{ can_review: 1 }]);
    await expect(service.forPost('p-1', 'mod', {})).resolves.toMatchObject({
      current: { content: 'Current text' },
    });

    h.answers.set(COMMENT_REVISION_SUBJECT_SQL, []);
    await expect(service.forComment('c-1', 'mod', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reads the subject through the viewer-aware predicate', () => {
    for (const sql of [
      POST_REVISION_SUBJECT_SQL,
      COMMENT_REVISION_SUBJECT_SQL,
    ]) {
      expect(sql).toContain("communities.visibility <> 'private'");
    }
    expect(COMMENT_REVISION_SUBJECT_SQL).toContain(
      '(comments.removed_at IS NOT NULL OR posts.removed_at IS NOT NULL) AS removed',
    );
  });
});
