import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { COMMUNITY_ACCESS_SQL } from '../common/community-visibility';
import { COMMUNITY_ROLE_BY_NAME_SQL } from './community-access';
import {
  CLEAR_USER_FLAIR_SQL,
  CommunityFlairsService,
  COUNT_FLAIRS_SQL,
  FLAIR_POST_SQL,
  FLAIR_SQL,
  INSERT_FLAIR_SQL,
  loadPostFlairs,
  MEMBER_SQL,
  SET_POST_FLAIR_SQL,
  SET_USER_FLAIR_SQL,
} from './community-flairs.service';

type Answer = unknown[] | { affectedRows: number };

const flair = (overrides: Record<string, unknown> = {}) => ({
  id: 'f-1',
  community_id: 'c-1',
  kind: 'post',
  text: 'News',
  background_color: '#ff4500',
  mod_only: 0,
  ...overrides,
});

describe('CommunityFlairsService', () => {
  let statements: Array<{ sql: string; values: unknown[] }>;
  let answers: Map<string, Answer>;
  let moderator: boolean;
  let visibility: string;
  let service: CommunityFlairsService;

  beforeEach(() => {
    statements = [];
    moderator = false;
    visibility = 'public';
    answers = new Map<string, Answer>([[FLAIR_SQL, [flair()]]]);
    const execute = (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith(COMMUNITY_ROLE_BY_NAME_SQL)) {
        return Promise.resolve([
          [
            {
              id: 'c-1',
              name: 'garden',
              creator_id: 'creator',
              visibility,
              can_moderate: moderator ? 1 : 0,
            },
          ],
          [],
        ]);
      }
      if (sql === COMMUNITY_ACCESS_SQL) {
        return Promise.resolve([[{ visibility, member: 0 }], []]);
      }
      if (sql.startsWith('SELECT id, community_id, kind')) {
        return Promise.resolve([answers.get(FLAIR_SQL) ?? [], []]);
      }
      return Promise.resolve([answers.get(sql) ?? [], []]);
    };
    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
    };
    service = new CommunityFlairsService({
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool);
  });

  const sqls = () => statements.map(({ sql }) => sql);
  const post = (overrides: Record<string, unknown> = {}) => ({
    id: 'p-1',
    author_id: 'author',
    community_id: 'c-1',
    removed_at: null,
    flair_id: null,
    can_moderate: 0,
    ...overrides,
  });

  describe('managing flairs', () => {
    it('creates one for a moderator', async () => {
      moderator = true;
      answers.set(COUNT_FLAIRS_SQL, [{ total: 3 }]);
      await expect(
        service.create('garden', 'mod', {
          kind: 'post',
          text: 'News',
          background_color: '#ff4500',
        }),
      ).resolves.toEqual({
        id: 'f-1',
        kind: 'post',
        text: 'News',
        background_color: '#ff4500',
        mod_only: false,
      });
      const insert = statements.find(({ sql }) => sql === INSERT_FLAIR_SQL);
      expect(insert?.values.slice(1)).toEqual([
        'c-1',
        'post',
        'News',
        '#ff4500',
        false,
      ]);
    });

    it('is 403 for a member, and 409 at the cap', async () => {
      await expect(
        service.create('garden', 'sam', { kind: 'post', text: 'News' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      moderator = true;
      answers.set(COUNT_FLAIRS_SQL, [{ total: 100 }]);
      await expect(
        service.create('garden', 'mod', { kind: 'post', text: 'News' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(sqls()).not.toContain(INSERT_FLAIR_SQL);
    });

    it('lists a private community only for members', async () => {
      visibility = 'private';
      await expect(service.list('garden', 'sam', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('is 404 deleting an unknown flair', async () => {
      moderator = true;
      answers.set(
        'DELETE FROM community_flairs WHERE id = ? AND community_id = ?',
        {
          affectedRows: 0,
        },
      );
      await expect(
        service.remove('garden', 'f-9', 'mod'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('post flairs', () => {
    it('lets the author pick a flair that is not mod_only', async () => {
      answers.set(FLAIR_POST_SQL, [post()]);
      await expect(
        service.setPostFlair('p-1', 'f-1', 'author'),
      ).resolves.toEqual({
        id: 'f-1',
        text: 'News',
        background_color: '#ff4500',
      });
      expect(
        statements.find(({ sql }) => sql === SET_POST_FLAIR_SQL)?.values,
      ).toEqual(['f-1', 'p-1']);
      // The caller is bound for the moderator check and the read access.
      expect(statements[0].values).toEqual([
        'author',
        'author',
        'p-1',
        'author',
      ]);
    });

    it('keeps mod_only flairs for moderators', async () => {
      answers.set(FLAIR_POST_SQL, [post()]);
      answers.set(FLAIR_SQL, [flair({ mod_only: 1 })]);
      await expect(
        service.setPostFlair('p-1', 'f-1', 'author'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      answers.set(FLAIR_POST_SQL, [post({ can_moderate: 1 })]);
      await expect(
        service.setPostFlair('p-1', 'f-1', 'mod'),
      ).resolves.toMatchObject({ id: 'f-1' });
    });

    it("refuses another author's post, a user flair and an unknown post", async () => {
      answers.set(FLAIR_POST_SQL, [post()]);
      await expect(
        service.setPostFlair('p-1', 'f-1', 'someone'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      answers.set(FLAIR_SQL, [flair({ kind: 'user' })]);
      await expect(
        service.setPostFlair('p-1', 'f-1', 'author'),
      ).rejects.toBeInstanceOf(BadRequestException);
      answers.set(FLAIR_POST_SQL, []);
      await expect(
        service.setPostFlair('p-1', 'f-1', 'author'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(sqls()).not.toContain(SET_POST_FLAIR_SQL);
    });

    it('lets the author clear only a flair they could have chosen', async () => {
      answers.set(FLAIR_POST_SQL, [post({ flair_id: 'f-1' })]);
      answers.set(FLAIR_SQL, [flair({ mod_only: 1 })]);
      await expect(
        service.clearPostFlair('p-1', 'author'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      answers.set(FLAIR_SQL, [flair()]);
      await service.clearPostFlair('p-1', 'author');
      expect(
        statements.find(({ sql }) => sql === SET_POST_FLAIR_SQL)?.values,
      ).toEqual([null, 'p-1']);
    });
  });

  describe('user flairs', () => {
    beforeEach(() => {
      answers.set(FLAIR_SQL, [flair({ kind: 'user' })]);
    });

    it('lets a member set their own', async () => {
      answers.set(MEMBER_SQL, [{ id: 'sam-id', member: 1 }]);
      await expect(
        service.setUserFlair('garden', 'sam', 'f-1', 'sam-id'),
      ).resolves.toEqual({
        flair: { id: 'f-1', text: 'News', background_color: '#ff4500' },
      });
      expect(
        statements.find(({ sql }) => sql === SET_USER_FLAIR_SQL)?.values,
      ).toEqual(['c-1', 'sam-id', 'f-1']);
    });

    it("keeps another member's flair and mod_only flairs for moderators", async () => {
      answers.set(MEMBER_SQL, [{ id: 'sam-id', member: 1 }]);
      await expect(
        service.setUserFlair('garden', 'sam', 'f-1', 'other'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      answers.set(FLAIR_SQL, [flair({ kind: 'user', mod_only: 1 })]);
      await expect(
        service.setUserFlair('garden', 'sam', 'f-1', 'sam-id'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      moderator = true;
      await expect(
        service.setUserFlair('garden', 'sam', 'f-1', 'mod'),
      ).resolves.toMatchObject({ flair: { id: 'f-1' } });
    });

    it('clears with null, and refuses a non-member', async () => {
      answers.set(MEMBER_SQL, [{ id: 'sam-id', member: 1 }]);
      await expect(
        service.setUserFlair('garden', 'sam', null, 'sam-id'),
      ).resolves.toEqual({ flair: null });
      expect(sqls()).toContain(CLEAR_USER_FLAIR_SQL);

      answers.set(MEMBER_SQL, [{ id: 'sam-id', member: 0 }]);
      await expect(
        service.setUserFlair('garden', 'sam', 'f-1', 'sam-id'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

describe('loadPostFlairs', () => {
  it('reads the distinct flairs of a page in one statement, none without flairs', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const executor = {
      execute: (sql: string, values: unknown[]) => {
        statements.push({ sql, values });
        return Promise.resolve([
          [{ id: 'f-1', text: 'News', background_color: null }],
          [],
        ]);
      },
    };

    await expect(
      loadPostFlairs(executor as never, [null, undefined]),
    ).resolves.toEqual(new Map());
    expect(statements).toHaveLength(0);

    const flairs = await loadPostFlairs(executor as never, [
      'f-1',
      'f-1',
      null,
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual(['f-1']);
    expect(flairs.get('f-1')).toEqual({
      id: 'f-1',
      text: 'News',
      background_color: null,
    });
  });
});
