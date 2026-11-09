import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  CreateCommunityBanDto,
  LiftCommunityBanDto,
  ListCommunityBansDto,
} from './community-ban.dto';

// Under the global pipe, as the routes really run.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const create = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: CreateCommunityBanDto });
const lift = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: LiftCommunityBanDto });
const list = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: ListCommunityBansDto });
const BAN = { username: 'member', reason: 'Repeated spam' };

describe('CreateCommunityBanDto', () => {
  it('accepts a permanent ban and trims the reason', async () => {
    await expect(create({ ...BAN, reason: '  Spam  ' })).resolves.toEqual(
      Object.assign(new CreateCommunityBanDto(), {
        username: 'member',
        reason: 'Spam',
      }),
    );
  });

  it.each([1, 72, 8760, '24'])(
    'accepts duration_hours=%j',
    async (duration_hours) => {
      await expect(create({ ...BAN, duration_hours })).resolves.toMatchObject({
        duration_hours: Number(duration_hours),
      });
    },
  );

  it.each([0, -1, 1.5, 8761, 'soon', null])(
    'refuses duration_hours=%j',
    async (duration_hours) => {
      await expect(create({ ...BAN, duration_hours })).rejects.toThrow();
    },
  );

  it.each([undefined, '', '   ', 'x'.repeat(2001), 'bad\u0000text', 42])(
    'refuses the reason %j: a ban must carry a justification',
    async (reason) => {
      await expect(create({ username: 'member', reason })).rejects.toThrow();
    },
  );

  it.each(['ab', 'x'.repeat(51), 'has-hyphen', 'has space', undefined])(
    'refuses the username %j',
    async (username) => {
      await expect(create({ ...BAN, username })).rejects.toThrow();
    },
  );

  // The deadline and the actor come from the server only.
  it.each([
    { expires_at: '2030-01-01T00:00:00Z' },
    { created_by: 'someone' },
    { user_id: 'member-id' },
    { lifted_at: null },
    { unexpected: 1 },
  ])('refuses %o', async (extra) => {
    await expect(create({ ...BAN, ...extra })).rejects.toThrow();
  });
});

describe('LiftCommunityBanDto', () => {
  it('accepts an empty body and a trimmed reason', async () => {
    await expect(lift({})).resolves.toEqual(new LiftCommunityBanDto());
    await expect(lift({ lift_reason: '  Appeal  ' })).resolves.toMatchObject({
      lift_reason: 'Appeal',
    });
  });

  it.each([
    { lift_reason: '' },
    { lift_reason: 'x'.repeat(2001) },
    { lifted_by: 'x' },
  ])('refuses %o', async (body) => {
    await expect(lift(body)).rejects.toThrow();
  });
});

describe('ListCommunityBansDto', () => {
  it('defaults to active bans, page 1, limit 20', async () => {
    await expect(list({})).resolves.toMatchObject({
      active: 'active',
      page: 1,
      limit: 20,
    });
  });

  it.each(['any', 'active', 'lifted'])('accepts active=%s', async (active) => {
    await expect(list({ active })).resolves.toMatchObject({ active });
  });

  it.each([
    { active: 'true' },
    { active: 'expired' },
    { page: '0' },
    { page: '10001' },
    { limit: '101' },
    { username: 'x' },
  ])('refuses %o', async (query) => {
    await expect(list(query)).rejects.toThrow();
  });
});
