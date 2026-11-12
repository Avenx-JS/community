import { describe, expect, it, jest } from '@jest/globals';
import {
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Pool } from 'mysql2/promise';
import type { EmailTransport } from '../email/email-transport';
import { AuthGuard } from './auth.guard';
import {
  AuthService,
  hashOpaqueToken,
  LIST_SESSIONS_SQL,
  type AccessTokenValidationResult,
} from './auth.service';
import { REQUIRE_VERIFIED_EMAIL } from './require-verified-email.decorator';

function pool(answer: (sql: string, values: unknown[]) => unknown) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return Promise.resolve([answer(sql, values), []]);
  };
  const connection = {
    execute,
    beginTransaction: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    release: () => undefined,
  };
  return {
    statements,
    pool: {
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool,
  };
}

describe('GET /auth/sessions', () => {
  it('lists live sessions without tokens or full addresses, marking the current one', async () => {
    const { pool: p, statements } = pool(() => [
      {
        session_id: 's-1',
        token_hash: hashOpaqueToken('current-token'),
        created_at: new Date('2026-11-01T00:00:00Z'),
        last_used_at: new Date('2026-11-12T09:00:00Z'),
        ip_prefix: '203.0.113.0/24',
        user_agent: 'Firefox',
      },
      {
        session_id: 's-2',
        token_hash: hashOpaqueToken('other-token'),
        created_at: new Date('2026-11-02T00:00:00Z'),
        last_used_at: null,
        ip_prefix: null,
        user_agent: null,
      },
    ]);
    const result = await new AuthService(p, {} as EmailTransport).listSessions(
      'u-1',
      'current-token',
    );
    expect(statements[0]).toEqual({ sql: LIST_SESSIONS_SQL, values: ['u-1'] });
    expect(result.items).toEqual([
      {
        id: 's-1',
        created_at: '2026-11-01T00:00:00.000Z',
        last_used_at: '2026-11-12T09:00:00.000Z',
        ip_prefix: '203.0.113.0/24',
        user_agent: 'Firefox',
        current: true,
      },
      expect.objectContaining({
        id: 's-2',
        current: false,
        last_used_at: '2026-11-02T00:00:00.000Z',
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/token|[0-9a-f]{64}/);
  });

  it('counts only sessions with a current refresh token', () => {
    expect(LIST_SESSIONS_SQL).toContain(
      'r.used_at IS NULL AND r.revoked_at IS NULL',
    );
    expect(LIST_SESSIONS_SQL).toContain('r.expires_at > UTC_TIMESTAMP()');
  });
});

describe('DELETE /auth/sessions/:id', () => {
  it('deletes the access token and revokes the refresh tokens of that session only, in one transaction', async () => {
    const { pool: p, statements } = pool((sql) =>
      sql.startsWith('SELECT') ? [] : { affectedRows: 1 },
    );
    await new AuthService(p, {} as EmailTransport).revokeSession('u-1', 's-1');
    expect(statements.map(({ sql, values }) => [sql, values])).toEqual([
      [
        'SELECT token_hash FROM auth_refresh_tokens WHERE session_id = ? AND user_id = ? FOR UPDATE',
        ['s-1', 'u-1'],
      ],
      [
        'DELETE FROM auth_sessions WHERE session_id = ? AND user_id = ?',
        ['s-1', 'u-1'],
      ],
      [
        'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL',
        ['s-1', 'u-1'],
      ],
    ]);
  });

  it("answers 404 for another account's or an ended session", async () => {
    const { pool: p } = pool((sql) =>
      sql.startsWith('SELECT') ? [] : { affectedRows: 0 },
    );
    await expect(
      new AuthService(p, {} as EmailTransport).revokeSession('u-1', 's-x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('session origin', () => {
  it('stores the network and user agent at sign-in, never the full address', async () => {
    const { pool: p, statements } = pool((sql) =>
      sql.startsWith('SELECT') ? [] : { affectedRows: 1 },
    );
    const service = new AuthService(p, {} as EmailTransport);
    await (
      service as unknown as {
        createSession: (user: object, origin: object) => Promise<unknown>;
      }
    ).createSession(
      { id: 'u-1', username: 'sam' },
      { ipPrefix: '203.0.113.0/24', userAgent: 'Firefox' },
    );
    const insert = statements.find(({ sql }) =>
      sql.startsWith('INSERT INTO auth_sessions'),
    )!;
    expect(insert.sql).toContain('last_used_at, ip_prefix, user_agent');
    expect(insert.values.slice(-2)).toEqual(['203.0.113.0/24', 'Firefox']);
  });
});

describe('the verified-email gate', () => {
  const context = (required: boolean) => {
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer token' },
    };
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) =>
        key === REQUIRE_VERIFIED_EMAIL ? required : false,
      );
    return {
      reflector,
      request,
      ctx: {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as unknown as ExecutionContext,
    };
  };
  const guard = (result: AccessTokenValidationResult, reflector: Reflector) =>
    new AuthGuard(
      {
        validateAccessTokenState: () => Promise.resolve(result),
      } as unknown as AuthService,
      reflector,
    );

  it('lets a verified account through a route that requires it', async () => {
    const { ctx, reflector } = context(true);
    await expect(
      guard(
        { kind: 'valid', userId: 'u', emailVerified: true },
        reflector,
      ).canActivate(ctx),
    ).resolves.toBe(true);
  });

  it('refuses an unverified account with 403 and the reason', async () => {
    const { ctx, reflector } = context(true);
    const error = await guard(
      { kind: 'valid', userId: 'u', emailVerified: false },
      reflector,
    )
      .canActivate(ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      reason: 'email_unverified',
    });
  });

  // Fails closed: a result without the flag never passes.
  it('refuses when the flag is missing', async () => {
    const { ctx, reflector } = context(true);
    await expect(
      guard(
        { kind: 'valid', userId: 'u' } as AccessTokenValidationResult,
        reflector,
      ).canActivate(ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not check routes that do not require it', async () => {
    const { ctx, reflector } = context(false);
    await expect(
      guard(
        { kind: 'valid', userId: 'u', emailVerified: false },
        reflector,
      ).canActivate(ctx),
    ).resolves.toBe(true);
  });
});
