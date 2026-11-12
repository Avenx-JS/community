import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { COMMUNITY_ACCESS_SQL } from '../src/common/community-visibility';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  COMMUNITY_COLUMNS,
  LISTED_COMMUNITY_ID_SQL,
} from '../src/communities/communities.service';
import { COMMUNITY_ROLE_BY_NAME_SQL } from '../src/communities/community-access';
import {
  COUNT_FLAIRS_SQL,
  FLAIR_POST_SQL,
  FLAIR_SQL,
  INSERT_FLAIR_SQL,
  SET_POST_FLAIR_SQL,
} from '../src/communities/community-flairs.service';
import {
  DECIDE_JOIN_REQUEST_SQL,
  INSERT_SUBSCRIPTION_SQL,
  IS_MEMBER_SQL,
  JOIN_REQUEST_SQL,
  LOCK_OWN_JOIN_REQUEST_SQL,
  LOCK_PENDING_JOIN_REQUEST_SQL,
  PENDING_JOIN_REQUESTS_FROM,
  UPSERT_JOIN_REQUEST_SQL,
} from '../src/communities/community-join-requests.service';
import {
  DELETE_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_SQL,
  INVITEE_SQL,
  IS_MODERATOR_SQL,
  IS_SUBSCRIBED_SQL,
  LOCK_MODERATOR_INVITE_SQL,
  OWN_MODERATOR_INVITES_FROM,
} from '../src/communities/community-moderator-invites.service';
import {
  MUTE_COMMUNITY_SQL,
  UNMUTE_COMMUNITY_SQL,
} from '../src/communities/community-discovery.service';
import { CommunityRuleAcceptanceService } from '../src/communities/community-rule-acceptance.service';
import { POST_COLUMNS } from '../src/posts/posts.service';
import { APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL } from '../src/users/user-preferences.service';
import { answerSavedFlags } from './fakes/saved-posts';
import { answerVoteScores } from './fakes/vote-scores';

// Migration 038 end to end, over a fake database that keeps the state the
// new statements read and write: a private community, its members and
// moderators, join requests, moderator invitations, flairs and mutes.
describe('Community settings (e2e)', () => {
  let app: INestApplication<App>;
  let community: {
    id: string;
    name: string;
    creator_id: string;
    visibility: 'public' | 'restricted' | 'private';
  };
  let subscriptions: Set<string>;
  let moderators: Set<string>;
  let requests: Map<string, { status: string; message: string | null }>;
  let invites: Map<string, string>;
  let flairs: Array<{
    id: string;
    kind: string;
    text: string;
    background_color: string | null;
    mod_only: number;
  }>;
  let postFlair: string | null;
  let mutes: Set<string>;
  let log: Array<{ action: string; actor: string; metadata: unknown }>;

  const users: Record<string, string> = {
    'u-creator': 'creator',
    'u-mod': 'a_moderator',
    'u-member': 'member',
    'u-sam': 'sam',
    'u-outsider': 'outsider',
  };
  const byName = (username: string) =>
    Object.entries(users).find(([, name]) => name === username)?.[0];
  const isMember = (userId: unknown) =>
    typeof userId === 'string' &&
    (userId === community.creator_id ||
      subscriptions.has(userId) ||
      moderators.has(userId));
  const canModerate = (userId: unknown) =>
    userId === community.creator_id ||
    (typeof userId === 'string' && moderators.has(userId));
  const readable = (viewer: unknown) =>
    community.visibility !== 'private' || isMember(viewer);
  const post = () => ({
    id: 'p-1',
    title: 'Seed swap',
    content: 'Tomatoes',
    type: 'text',
    author_id: 'u-member',
    community_id: 'c-1',
    created_at: new Date('2026-11-01T10:00:00Z'),
    pinned_at: null,
    pinned_by: null,
    edited_at: null,
    locked_at: null,
    locked_by: null,
    media_id: null,
    flair_id: postFlair,
    removed_at: null,
    removed_by: null,
    removal_reason: null,
  });

  beforeEach(async () => {
    community = {
      id: 'c-1',
      name: 'garden',
      creator_id: 'u-creator',
      visibility: 'private',
    };
    subscriptions = new Set(['u-member', 'u-mod']);
    moderators = new Set(['u-mod']);
    requests = new Map();
    invites = new Map();
    flairs = [];
    postFlair = null;
    mutes = new Set();
    log = [];

    const run = (sql: string, values: unknown[]): [unknown, unknown] => {
      const rows = (value: unknown): [unknown, unknown] => [value, []];
      const flat = sql.replace(/\s+/g, ' ').trim();
      const score = answerVoteScores(sql, values);
      if (score) return score;
      const saved = answerSavedFlags(sql, values);
      if (saved) return saved;

      if (sql.startsWith(COMMUNITY_ROLE_BY_NAME_SQL)) {
        const [actor, , name] = values;
        return rows(
          name === community.name
            ? [{ ...community, can_moderate: canModerate(actor) ? 1 : 0 }]
            : [],
        );
      }
      if (sql === COMMUNITY_ACCESS_SQL) {
        return rows([
          {
            visibility: community.visibility,
            member: isMember(values[0]) ? 1 : 0,
          },
        ]);
      }
      if (sql === LISTED_COMMUNITY_ID_SQL) {
        return rows(
          values[1] === community.name
            ? [
                {
                  id: community.id,
                  access_visibility: community.visibility,
                  access_member: isMember(values[0]) ? 1 : 0,
                },
              ]
            : [],
        );
      }
      if (
        sql ===
        'SELECT id FROM communities WHERE name = ? AND deleted_at IS NULL AND suspended_at IS NULL LIMIT 1'
      ) {
        return rows(values[0] === community.name ? [{ id: community.id }] : []);
      }
      if (
        sql.startsWith(
          'SELECT id, creator_id, visibility FROM communities WHERE name = ?',
        )
      ) {
        // A copy, as a database row is: the update must not change it.
        return rows(values[0] === community.name ? [{ ...community }] : []);
      }
      if (sql.startsWith('UPDATE communities SET ')) {
        if (sql.includes('visibility = ?')) {
          community.visibility = values[0] as typeof community.visibility;
        }
        return rows({ affectedRows: 1 });
      }
      if (
        sql ===
        `SELECT ${COMMUNITY_COLUMNS} FROM communities WHERE id = ? LIMIT 1`
      ) {
        return rows([
          {
            ...community,
            description: null,
            created_at: new Date('2026-01-01T00:00:00Z'),
            nsfw: 0,
            allowed_post_types: 'text,link,media',
          },
        ]);
      }
      if (
        sql.startsWith(
          `SELECT ${COMMUNITY_COLUMNS}, icon_media_id, banner_media_id FROM communities WHERE name = ?`,
        )
      ) {
        return rows(
          values[0] === community.name
            ? [
                {
                  ...community,
                  description: 'Growing things',
                  created_at: new Date('2026-01-01T00:00:00Z'),
                  nsfw: 0,
                  allowed_post_types: 'text,link,media',
                  icon_media_id: null,
                  banner_media_id: null,
                },
              ]
            : [],
        );
      }
      if (flat.includes('FROM community_bans')) return rows([]);
      if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
        return rows([{ username: users[values[0] as string] }]);
      }
      if (sql === INVITEE_SQL) {
        const id = byName(values[0] as string);
        return rows(id ? [{ id, username: values[0] }] : []);
      }
      if (flat.startsWith('INSERT INTO community_moderation_actions')) {
        log.push({
          action: values[4] as string,
          actor: values[3] as string,
          metadata: values[7] === null ? null : JSON.parse(values[7] as string),
        });
        return rows({ affectedRows: 1 });
      }

      // Join requests.
      if (sql === IS_MEMBER_SQL) {
        return rows([{ member: isMember(values[0]) ? 1 : 0 }]);
      }
      if (sql === LOCK_OWN_JOIN_REQUEST_SQL) {
        const own = requests.get(values[2] as string);
        return rows(
          own
            ? [
                {
                  status: own.status,
                  retry_blocked: own.status === 'denied' ? 1 : 0,
                },
              ]
            : [],
        );
      }
      if (sql === UPSERT_JOIN_REQUEST_SQL) {
        requests.set(values[1] as string, {
          status: 'pending',
          message: (values[2] as string | null) ?? null,
        });
        return rows({ affectedRows: 1 });
      }
      if (sql === JOIN_REQUEST_SQL) {
        const own = requests.get(values[1] as string);
        return rows(
          own
            ? [
                {
                  user_id: values[1],
                  status: own.status,
                  message: own.message,
                  created_at: new Date('2026-11-02T10:00:00Z'),
                  decided_at:
                    own.status === 'pending'
                      ? null
                      : new Date('2026-11-02T11:00:00Z'),
                },
              ]
            : [],
        );
      }
      if (
        flat.endsWith(`${PENDING_JOIN_REQUESTS_FROM.replace(/\s+/g, ' ')}`) ||
        flat.includes(PENDING_JOIN_REQUESTS_FROM.replace(/\s+/g, ' '))
      ) {
        const pending = [...requests].filter(([, r]) => r.status === 'pending');
        if (flat.startsWith('SELECT COUNT(*)'))
          return rows([{ total: pending.length }]);
        return rows(
          pending.map(([id, r]) => ({
            username: users[id],
            display_name: null,
            message: r.message,
            created_at: new Date('2026-11-02T10:00:00Z'),
          })),
        );
      }
      if (sql === LOCK_PENDING_JOIN_REQUEST_SQL) {
        const id = byName(values[1] as string);
        return rows(
          id && requests.get(id)?.status === 'pending'
            ? [{ user_id: id, username: values[1] }]
            : [],
        );
      }
      if (sql === DECIDE_JOIN_REQUEST_SQL) {
        requests.get(values[3] as string)!.status = values[0] as string;
        return rows({ affectedRows: 1 });
      }
      if (sql === INSERT_SUBSCRIPTION_SQL) {
        subscriptions.add(values[0] as string);
        return rows({ affectedRows: 1 });
      }
      if (sql === APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL) {
        return rows({ affectedRows: 0 });
      }

      // Moderator invitations.
      if (sql === IS_MODERATOR_SQL) {
        return rows(
          moderators.has(values[1] as string) ? [{ moderator: 1 }] : [],
        );
      }
      if (sql === IS_SUBSCRIBED_SQL) {
        return rows(
          subscriptions.has(values[1] as string) ? [{ subscribed: 1 }] : [],
        );
      }
      if (sql === INSERT_MODERATOR_INVITE_SQL) {
        const fresh = !invites.has(values[1] as string);
        invites.set(values[1] as string, values[2] as string);
        return rows({ affectedRows: fresh ? 1 : 0 });
      }
      if (sql === LOCK_MODERATOR_INVITE_SQL) {
        const by = invites.get(values[1] as string);
        return rows(by ? [{ invited_by: by }] : []);
      }
      if (sql === DELETE_MODERATOR_INVITE_SQL) {
        return rows({
          affectedRows: invites.delete(values[1] as string) ? 1 : 0,
        });
      }
      if (sql === INSERT_MODERATOR_SQL) {
        moderators.add(values[1] as string);
        return rows({ affectedRows: 1 });
      }
      if (flat.includes(OWN_MODERATOR_INVITES_FROM.replace(/\s+/g, ' '))) {
        const own = invites.has(values[0] as string) ? [values[0]] : [];
        if (flat.startsWith('SELECT COUNT(*)'))
          return rows([{ total: own.length }]);
        return rows(
          own.map(() => ({
            name: community.name,
            description: null,
            invited_by: users[invites.get(values[0] as string)!],
            created_at: new Date('2026-11-03T10:00:00Z'),
          })),
        );
      }

      // Flairs.
      if (sql === COUNT_FLAIRS_SQL) return rows([{ total: flairs.length }]);
      if (sql === INSERT_FLAIR_SQL) {
        const [id, , kind, text, background_color, mod_only] = values;
        flairs.push({
          id: id as string,
          kind: kind as string,
          text: text as string,
          background_color: background_color as string | null,
          mod_only: mod_only ? 1 : 0,
        });
        return rows({ affectedRows: 1 });
      }
      if (sql === FLAIR_SQL) {
        return rows(
          flairs
            .filter((f) => f.id === values[0])
            .map((f) => ({ ...f, community_id: 'c-1' })),
        );
      }
      if (sql === FLAIR_POST_SQL) {
        const [actor, , postId, viewer] = values;
        return rows(
          postId === 'p-1' && readable(viewer)
            ? [{ ...post(), can_moderate: canModerate(actor) ? 1 : 0 }]
            : [],
        );
      }
      if (sql === SET_POST_FLAIR_SQL) {
        postFlair = values[0] as string | null;
        return rows({ affectedRows: 1 });
      }
      if (
        flat.startsWith(
          'SELECT id, text, background_color FROM community_flairs WHERE id IN',
        )
      ) {
        return rows(flairs.filter((f) => values.includes(f.id)));
      }

      // Reading the post: the viewer-aware predicate, bound after the id.
      if (
        sql.startsWith(`SELECT ${POST_COLUMNS}, `) &&
        flat.includes('FROM posts WHERE id = ?')
      ) {
        return rows(values[0] === 'p-1' && readable(values[1]) ? [post()] : []);
      }

      // Mutes.
      if (sql === MUTE_COMMUNITY_SQL) {
        mutes.add(values[0] as string);
        return rows({ affectedRows: 1 });
      }
      if (sql === UNMUTE_COMMUNITY_SQL) {
        mutes.delete(values[0] as string);
        return rows({ affectedRows: 1 });
      }
      throw new Error(`Unexpected SQL: ${flat}`);
    };
    const execute = (sql: string, values: unknown[] = []) =>
      Promise.resolve(run(sql, values));

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () =>
          Promise.resolve({
            execute,
            beginTransaction: () => Promise.resolve(),
            commit: () => Promise.resolve(),
            rollback: () => Promise.resolve(),
            release: () => undefined,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(CommunityRuleAcceptanceService)
      .useValue({ assertAcceptedOrThrow: () => Promise.resolve() })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const id = `u-${token.replace(/-token$/, '')}`;
          return Promise.resolve(
            users[id]
              ? { kind: 'valid', emailVerified: true, userId: id }
              : { kind: 'invalid' },
          );
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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

  const as = (who: string) => {
    const auth = { Authorization: `Bearer ${who}-token` };
    const server = app.getHttpServer();
    return {
      get: (path: string) => request(server).get(path).set(auth),
      post: (path: string) => request(server).post(path).set(auth),
      put: (path: string) => request(server).put(path).set(auth),
      patch: (path: string) => request(server).patch(path).set(auth),
      delete: (path: string) => request(server).delete(path).set(auth),
    };
  };
  const anonymous = () => request(app.getHttpServer());

  describe('a private community', () => {
    it('shows its page to everyone, with its settings, so that one can ask to join', async () => {
      const response = await anonymous().get('/communities/garden').expect(200);
      expect(response.body).toMatchObject({
        name: 'garden',
        visibility: 'private',
        nsfw: false,
        allowed_post_types: ['text', 'link', 'media'],
      });
    });

    it('answers its posts listing 403 to a non-member, and its posts 404', async () => {
      const listing = await as('outsider')
        .get('/communities/garden/posts')
        .expect(403);
      expect(listing.body).toMatchObject({ reason: 'private_community' });
      await anonymous().get('/communities/garden/posts').expect(403);
      await as('outsider').get('/posts/p-1').expect(404);
      await anonymous().get('/posts/p-1').expect(404);
    });

    it('serves its content to a member', async () => {
      await as('member').get('/posts/p-1').expect(200);
    });

    it('takes access from non-members the moment it becomes private', async () => {
      community.visibility = 'public';
      await as('outsider').get('/posts/p-1').expect(200);

      await as('creator')
        .patch('/communities/garden')
        .send({ visibility: 'private' })
        .expect(200);

      await as('outsider').get('/posts/p-1').expect(404);
      expect(log).toEqual([
        {
          action: 'community_updated',
          actor: 'creator',
          metadata: { fields: 'visibility', visibility: 'private' },
        },
      ]);
    });

    it('lets only the creator change its settings', async () => {
      await as('mod')
        .patch('/communities/garden')
        .send({ visibility: 'public' })
        .expect(403);
      await as('creator')
        .patch('/communities/garden')
        .send({ visibility: 'secret' })
        .expect(400);
      expect(community.visibility).toBe('private');
    });
  });

  describe('joining by request', () => {
    it('refuses a direct subscription with join_request_required', async () => {
      const response = await as('sam')
        .post('/communities/garden/subscribe')
        .expect(403);
      expect(response.body).toMatchObject({ reason: 'join_request_required' });
      expect(subscriptions.has('u-sam')).toBe(false);
    });

    it('takes one request, which a moderator approves into a membership, logged', async () => {
      const created = await as('sam')
        .post('/communities/garden/join-requests')
        .send({ message: 'I grow tomatoes' })
        .expect(201);
      expect(created.body).toMatchObject({
        community: 'garden',
        status: 'pending',
        message: 'I grow tomatoes',
        decided_at: null,
      });
      await as('sam')
        .post('/communities/garden/join-requests')
        .send({})
        .expect(409);

      const queue = await as('mod')
        .get('/communities/garden/join-requests')
        .expect(200);
      expect(queue.body).toMatchObject({
        total: 1,
        items: [{ username: 'sam', message: 'I grow tomatoes' }],
      });
      await as('member').get('/communities/garden/join-requests').expect(403);

      await as('mod')
        .post('/communities/garden/join-requests/sam/approve')
        .expect(204);
      expect(subscriptions.has('u-sam')).toBe(true);
      expect(log).toContainEqual({
        action: 'join_request_approved',
        actor: 'a_moderator',
        metadata: { username: 'sam' },
      });
      await as('sam').get('/posts/p-1').expect(200);
      await as('sam')
        .get('/communities/garden/join-requests/me')
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({ status: 'approved' }),
        );
    });

    it('records a denial, which blocks a new request for a while', async () => {
      await as('sam')
        .post('/communities/garden/join-requests')
        .send({})
        .expect(201);
      await as('creator')
        .post('/communities/garden/join-requests/sam/deny')
        .expect(204);
      expect(subscriptions.has('u-sam')).toBe(false);
      expect(log).toContainEqual(
        expect.objectContaining({ action: 'join_request_denied' }),
      );
      await as('sam')
        .post('/communities/garden/join-requests')
        .send({})
        .expect(409);
      await as('creator')
        .post('/communities/garden/join-requests/sam/approve')
        .expect(404);
    });

    it('is 409 for a public community and for a member', async () => {
      await as('member')
        .post('/communities/garden/join-requests')
        .send({})
        .expect(409);
      community.visibility = 'public';
      await as('sam')
        .post('/communities/garden/join-requests')
        .send({})
        .expect(409);
    });
  });

  describe('moderator invitations', () => {
    it('makes nobody a moderator without consent', async () => {
      // The direct appointment route is gone.
      await as('creator')
        .post('/communities/garden/moderators')
        .send({ username: 'member' })
        .expect(404);

      await as('creator')
        .post('/communities/garden/moderators/invites')
        .send({ username: 'member' })
        .expect(204);
      expect(moderators.has('u-member')).toBe(false);

      const own = await as('member')
        .get('/users/me/moderator-invites')
        .expect(200);
      expect(own.body).toMatchObject({
        total: 1,
        items: [{ community: { name: 'garden' }, invited_by: 'creator' }],
      });

      await as('member')
        .post('/communities/garden/moderators/invites/accept')
        .expect(204);
      expect(moderators.has('u-member')).toBe(true);
      expect(log.map((entry) => entry.action)).toEqual([
        'moderator_invited',
        'moderator_added',
      ]);
      await as('member')
        .post('/communities/garden/moderators/invites/accept')
        .expect(404);
    });

    it('lets only the creator invite, and only members', async () => {
      await as('mod')
        .post('/communities/garden/moderators/invites')
        .send({ username: 'member' })
        .expect(403);
      await as('creator')
        .post('/communities/garden/moderators/invites')
        .send({ username: 'outsider' })
        .expect(403);
      await as('creator')
        .post('/communities/garden/moderators/invites')
        .send({ username: 'a_moderator' })
        .expect(409);
      expect(invites.size).toBe(0);
    });

    it('is declined by the invitee and revoked by the creator, each logged', async () => {
      invites.set('u-member', 'u-creator');
      await as('member')
        .delete('/communities/garden/moderators/invites')
        .expect(204);
      invites.set('u-member', 'u-creator');
      await as('creator')
        .delete('/communities/garden/moderators/invites?username=member')
        .expect(204);
      expect(log.map((entry) => entry.action)).toEqual([
        'moderator_invite_declined',
        'moderator_invite_revoked',
      ]);
      await as('member')
        .delete('/communities/garden/moderators/invites?username=member')
        .expect(403);
    });
  });

  describe('flairs', () => {
    it('lets moderators create flairs and authors pick only open ones', async () => {
      const locked = await as('mod')
        .post('/communities/garden/flairs')
        .send({ kind: 'post', text: 'Official', mod_only: true })
        .expect(201);
      const open = await as('mod')
        .post('/communities/garden/flairs')
        .send({ kind: 'post', text: 'Question', background_color: '#00AA00' })
        .expect(201);
      expect(open.body).toMatchObject({
        text: 'Question',
        background_color: '#00aa00',
        mod_only: false,
      });
      await as('member')
        .post('/communities/garden/flairs')
        .send({ kind: 'post', text: 'Mine' })
        .expect(403);

      const lockedId = (locked.body as { id: string }).id;
      const openId = (open.body as { id: string }).id;
      await as('member')
        .put('/posts/p-1/flair')
        .send({ flair_id: lockedId })
        .expect(403);
      await as('member')
        .put('/posts/p-1/flair')
        .send({ flair_id: openId })
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ text: 'Question' }));
      const read = await as('member').get('/posts/p-1').expect(200);
      expect(read.body).toMatchObject({
        flair: { id: openId, text: 'Question', background_color: '#00aa00' },
      });

      await as('mod')
        .put('/posts/p-1/flair')
        .send({ flair_id: lockedId })
        .expect(200);
      await as('member').delete('/posts/p-1/flair').expect(403);
      await as('mod').delete('/posts/p-1/flair').expect(204);
      expect(postFlair).toBeNull();
    });

    it('hides a private community’s post flair route from non-members', async () => {
      await as('outsider')
        .put('/posts/p-1/flair')
        .send({ flair_id: '3f1c1f0e-8a7b-4c2e-9d3a-1b2c3d4e5f60' })
        .expect(404);
    });
  });

  it('mutes and unmutes idempotently', async () => {
    await as('member').post('/communities/garden/mute').expect(204);
    await as('member').post('/communities/garden/mute').expect(204);
    expect(mutes.has('u-member')).toBe(true);
    await as('member').delete('/communities/garden/mute').expect(204);
    expect(mutes.has('u-member')).toBe(false);
    await anonymous().post('/communities/garden/mute').expect(401);
  });
});
