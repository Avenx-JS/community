import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  AdminUpdateCommunityDto,
  ListAdminCommunitiesDto,
  RestoreCommunityDto,
  SuspendCommunityDto,
} from './admin-communities.dto';

// Under the global pipe, as the routes really run.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const list = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: ListAdminCommunitiesDto });
const update = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: AdminUpdateCommunityDto });

describe('ListAdminCommunitiesDto', () => {
  it('defaults to every community, newest first, page 1 of 20', async () => {
    await expect(list({})).resolves.toMatchObject({
      state: 'any',
      sort: 'new',
      page: 1,
      limit: 20,
    });
  });

  it.each(['any', 'active', 'suspended', 'deleted'])(
    'accepts state=%s',
    async (state) => {
      await expect(list({ state })).resolves.toMatchObject({ state });
    },
  );

  it('accepts every filter together', async () => {
    await expect(
      list({
        search: 'cats & dogs',
        creator_username: 'some_creator',
        state: 'suspended',
        page: '10000',
        limit: '100',
        sort: 'oldest',
      }),
    ).resolves.toMatchObject({ page: 10000, limit: 100, sort: 'oldest' });
  });

  it.each([
    { state: 'hidden' },
    { state: 'ANY' },
    { search: 'x'.repeat(101) },
    { search: 'bad\u0000text' },
    { creator_username: 'ab' },
    { creator_username: 'has-hyphen' },
    { page: '0' },
    { page: '10001' },
    { limit: '0' },
    { limit: '101' },
    { sort: 'name' },
    { name: 'a-community' },
    { unexpected: '1' },
  ])('refuses %o', async (query) => {
    await expect(list(query)).rejects.toThrow();
  });
});

describe('AdminUpdateCommunityDto', () => {
  it('accepts a description, trimmed, and an empty one that clears it', async () => {
    await expect(
      update({ description: '  Corrected  ' }),
    ).resolves.toMatchObject({
      description: 'Corrected',
    });
    await expect(update({ description: '   ' })).resolves.toMatchObject({
      description: '',
    });
    await expect(
      update({ description: 'x'.repeat(16383) }),
    ).resolves.toBeDefined();
  });

  it('needs at least one field', async () => {
    await expect(update({})).rejects.toThrow();
  });

  // The route key and the versioned rules document are out of reach.
  it.each([
    { name: 'renamed' },
    { rules: 'New rules' },
    { description: 'x', name: 'renamed' },
    { description: 'x', rules: 'New rules' },
    { description: 'x', creator_id: 'someone' },
    { description: 'x', suspended_at: null },
    { description: 'x', deleted_at: null },
    { description: 'x', unexpected: 1 },
  ])('refuses %o', async (body) => {
    await expect(update(body)).rejects.toThrow();
  });

  it.each([null, 42, 'x'.repeat(16384), 'bad\u0000text'])(
    'refuses the description %j',
    async (description) => {
      await expect(update({ description })).rejects.toThrow();
    },
  );
});

const suspend = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: SuspendCommunityDto });
const restore = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: RestoreCommunityDto });

describe('SuspendCommunityDto and RestoreCommunityDto', () => {
  it('accept a trimmed reason of 1 to 2000 characters', async () => {
    await expect(
      suspend({ reason: '  Spam network  ' }),
    ).resolves.toMatchObject({
      reason: 'Spam network',
    });
    await expect(
      restore({ restore_reason: 'x'.repeat(2000) }),
    ).resolves.toBeDefined();
  });

  it.each([
    {},
    { reason: '' },
    { reason: '   ' },
    { reason: 'x'.repeat(2001) },
    { reason: 'bad\u0000text' },
    { reason: 42 },
  ])('suspension refuses %o', async (body) => {
    await expect(suspend(body)).rejects.toThrow();
  });

  // Indefinite by design, and the actor comes from the token.
  it.each([
    { duration_hours: 24 },
    { expires_at: '2030-01-01T00:00:00Z' },
    { suspended_by: 'someone' },
    { unexpected: 1 },
  ])('suspension refuses the extra field %o', async (extra) => {
    await expect(suspend({ reason: 'Spam', ...extra })).rejects.toThrow();
  });

  it.each([
    {},
    { restore_reason: '' },
    { reason: 'Wrong key' },
    { restore_reason: 'ok', unexpected: 1 },
  ])('restoration refuses %o', async (body) => {
    await expect(restore(body)).rejects.toThrow();
  });
});
