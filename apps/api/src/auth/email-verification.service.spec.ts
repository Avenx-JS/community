import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import type { EmailTransport, OutboundMessage } from '../email/email-transport';
import {
  hashOpaqueToken,
  INVALIDATE_RESET_TOKENS_SQL,
  type AuthService,
} from './auth.service';
import {
  APPLY_EMAIL_CHANGE_SQL,
  CONSUME_VERIFICATION_TOKEN_SQL,
  DELETE_EMAIL_CHANGE_SQL,
  EMAIL_CHANGE_OWNER_SQL,
  EMAIL_IN_USE_SQL,
  EmailVerificationService,
  INSERT_VERIFICATION_TOKEN_SQL,
  INVALID_EMAIL_TOKEN_MESSAGE,
  INVALIDATE_VERIFICATION_TOKENS_SQL,
  LOCK_EMAIL_ACCOUNT_SQL,
  LOCK_EMAIL_CHANGE_SQL,
  LOCK_VERIFICATION_TOKEN_SQL,
  MARK_VERIFIED_SQL,
  maskEmail,
  UPSERT_EMAIL_CHANGE_SQL,
  VERIFICATION_TOKEN_OWNER_SQL,
} from './email-verification.service';

interface Account {
  id: string;
  email: string;
  email_verified_at: Date | null;
  password_hash: string;
}

// An in-memory model of the statements, with a clock for expiry.
function harness() {
  let now = Date.parse('2026-11-12T10:00:00Z');
  const accounts: Account[] = [
    {
      id: 'u-1',
      email: 'sam@example.com',
      email_verified_at: null,
      password_hash: 'pw:right',
    },
    {
      id: 'u-2',
      email: 'taken@example.com',
      email_verified_at: new Date(),
      password_hash: 'pw:other',
    },
  ];
  const tokens: Array<{
    token_hash: string;
    user_id: string;
    email: string;
    expires_at: number;
    used_at: number | null;
  }> = [];
  const changes: Array<{
    user_id: string;
    new_email: string;
    token_hash: string;
    expires_at: number;
  }> = [];
  const resetInvalidated: string[] = [];
  const sent: OutboundMessage[] = [];

  const execute = (sql: string, values: unknown[] = []) => {
    const v = values as string[];
    const rows = (r: unknown) => Promise.resolve([r, []]);
    switch (sql) {
      case LOCK_EMAIL_ACCOUNT_SQL:
        return rows(accounts.filter((a) => a.id === v[0]));
      case INVALIDATE_VERIFICATION_TOKENS_SQL:
        for (const t of tokens)
          if (t.user_id === v[0] && t.used_at === null) t.used_at = now;
        return rows({ affectedRows: 1 });
      case INSERT_VERIFICATION_TOKEN_SQL:
        tokens.push({
          token_hash: v[0],
          user_id: v[1],
          email: v[2],
          expires_at: now + Number(v[3]) * 1000,
          used_at: null,
        });
        return rows({ affectedRows: 1 });
      case VERIFICATION_TOKEN_OWNER_SQL:
        return rows(tokens.filter((t) => t.token_hash === v[0]));
      case LOCK_VERIFICATION_TOKEN_SQL:
        return rows(
          tokens
            .filter((t) => t.token_hash === v[0])
            .map((t) => ({ ...t, expired: t.expires_at <= now ? 1 : 0 })),
        );
      case CONSUME_VERIFICATION_TOKEN_SQL: {
        const t = tokens.find(
          (x) => x.token_hash === v[0] && x.used_at === null,
        );
        if (t) t.used_at = now;
        return rows({ affectedRows: t ? 1 : 0 });
      }
      case MARK_VERIFIED_SQL: {
        const a = accounts.find((x) => x.id === v[0] && x.email === v[1]);
        if (a && !a.email_verified_at) a.email_verified_at = new Date(now);
        return rows({ affectedRows: a ? 1 : 0 });
      }
      case EMAIL_IN_USE_SQL:
        return rows(
          accounts.filter((a) => a.email === v[0]).map(({ id }) => ({ id })),
        );
      case UPSERT_EMAIL_CHANGE_SQL: {
        const existing = changes.findIndex((c) => c.user_id === v[0]);
        const row = {
          user_id: v[0],
          new_email: v[1],
          token_hash: v[2],
          expires_at: now + Number(v[3]) * 1000,
        };
        if (existing >= 0) changes[existing] = row;
        else changes.push(row);
        return rows({ affectedRows: 1 });
      }
      case EMAIL_CHANGE_OWNER_SQL:
        return rows(changes.filter((c) => c.token_hash === v[0]));
      case LOCK_EMAIL_CHANGE_SQL:
        return rows(
          changes
            .filter((c) => c.token_hash === v[0])
            .map((c) => ({ ...c, expired: c.expires_at <= now ? 1 : 0 })),
        );
      case APPLY_EMAIL_CHANGE_SQL: {
        if (accounts.some((a) => a.email === v[0] && a.id !== v[1])) {
          return Promise.reject(
            Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }),
          );
        }
        const a = accounts.find((x) => x.id === v[1])!;
        a.email = v[0];
        a.email_verified_at = new Date(now);
        return rows({ affectedRows: 1 });
      }
      case DELETE_EMAIL_CHANGE_SQL: {
        const i = changes.findIndex((c) => c.user_id === v[0]);
        if (i >= 0) changes.splice(i, 1);
        return rows({ affectedRows: 1 });
      }
      case INVALIDATE_RESET_TOKENS_SQL:
        resetInvalidated.push(v[0]);
        return rows({ affectedRows: 0 });
    }
    return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
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
  const email = {
    send: jest.fn((message: OutboundMessage) => {
      sent.push(message);
      return Promise.resolve();
    }),
  } as unknown as EmailTransport;
  const auth = {
    passwordMatches: (password: string, stored: string) =>
      Promise.resolve(stored === `pw:${password}`),
  } as unknown as AuthService;
  const service = new EmailVerificationService(pool, email, auth);
  // The code is only in the email: read it back from there.
  const codeIn = (message: OutboundMessage) =>
    /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(message.text)?.[1];
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    service,
    accounts,
    tokens,
    changes,
    sent,
    resetInvalidated,
    codeIn,
    flush,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

describe('email verification codes', () => {
  it('stores only the hash of a code it mails to the current address', async () => {
    const h = harness();
    await h.service.requestVerification('u-1');
    await h.flush();
    const code = h.codeIn(h.sent[0])!;
    expect(h.sent[0].to).toBe('sam@example.com');
    expect(h.tokens).toEqual([
      expect.objectContaining({
        token_hash: hashOpaqueToken(code),
        email: 'sam@example.com',
      }),
    ]);
    expect(JSON.stringify(h.tokens)).not.toContain(code);
  });

  it('confirms the address once; the code then fails like an unknown one', async () => {
    const h = harness();
    await h.service.requestVerification('u-1');
    await h.flush();
    const code = h.codeIn(h.sent[0])!;
    await expect(h.service.verify(code)).resolves.toEqual({
      status: 'verified',
      email: 'sam@example.com',
    });
    expect(h.accounts[0].email_verified_at).not.toBeNull();
    await expect(h.service.verify(code)).rejects.toThrow(
      INVALID_EMAIL_TOKEN_MESSAGE,
    );
    await expect(h.service.verify('unknown-code')).rejects.toThrow(
      INVALID_EMAIL_TOKEN_MESSAGE,
    );
  });

  it('expires, and a new request supersedes the earlier code', async () => {
    const h = harness();
    await h.service.requestVerification('u-1');
    await h.service.requestVerification('u-1');
    await h.flush();
    const [first, second] = h.sent.map(h.codeIn) as string[];
    await expect(h.service.verify(first)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    h.advance(86400);
    await expect(h.service.verify(second)).rejects.toThrow(
      INVALID_EMAIL_TOKEN_MESSAGE,
    );
  });

  it('answers 409 for an address already confirmed, sending nothing', async () => {
    const h = harness();
    await expect(h.service.requestVerification('u-2')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await h.flush();
    expect(h.sent).toEqual([]);
  });

  it('voids a code sent to an address the account no longer has', async () => {
    const h = harness();
    await h.service.requestVerification('u-1');
    await h.flush();
    h.accounts[0].email = 'elsewhere@example.com';
    await expect(h.service.verify(h.codeIn(h.sent[0])!)).rejects.toThrow(
      INVALID_EMAIL_TOKEN_MESSAGE,
    );
  });
});

describe('email change', () => {
  it('needs the current password and changes nothing on a wrong one', async () => {
    const h = harness();
    await expect(
      h.service.requestEmailChange('u-1', 'wrong', 'new@example.com'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.changes).toEqual([]);
  });

  it('changes the address only once the code sent to the new one is confirmed, telling the old one', async () => {
    const h = harness();
    await h.service.requestEmailChange('u-1', 'right', ' New@Example.com ');
    await h.flush();
    expect(h.accounts[0].email).toBe('sam@example.com');
    const toNew = h.sent.find((m) => m.to === 'new@example.com')!;
    const toOld = h.sent.find((m) => m.to === 'sam@example.com')!;
    expect(toOld.text).toContain('n***@example.com');
    expect(toOld.text).not.toContain('new@example.com');
    expect(h.codeIn(toOld)).toBeUndefined();

    await expect(h.service.verify(h.codeIn(toNew)!)).resolves.toEqual({
      status: 'email_changed',
      email: 'new@example.com',
    });
    await h.flush();
    expect(h.accounts[0]).toMatchObject({ email: 'new@example.com' });
    expect(h.accounts[0].email_verified_at).not.toBeNull();
    expect(h.changes).toEqual([]);
    // Codes mailed to the old address, reset codes included, are void now.
    expect(h.resetInvalidated).toEqual(['u-1']);
    expect(
      h.sent.filter((m) => m.to === 'sam@example.com').map((m) => m.subject),
    ).toContain('Your email address was changed');
  });

  // The same answer as for a free address: the route cannot test which
  // addresses have accounts.
  it('stores no change for an address another account has, and sends that address a notice instead of a code', async () => {
    const h = harness();
    await expect(
      h.service.requestEmailChange('u-1', 'right', 'taken@example.com'),
    ).resolves.toBeUndefined();
    await h.flush();
    expect(h.changes).toEqual([]);
    const notice = h.sent.find((m) => m.to === 'taken@example.com')!;
    expect(h.codeIn(notice)).toBeUndefined();
  });

  it('refuses the current address with 400', async () => {
    const h = harness();
    await expect(
      h.service.requestEmailChange('u-1', 'right', 'SAM@example.com'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps one pending change: a new request voids the earlier code', async () => {
    const h = harness();
    await h.service.requestEmailChange('u-1', 'right', 'one@example.com');
    await h.service.requestEmailChange('u-1', 'right', 'two@example.com');
    await h.flush();
    const first = h.codeIn(h.sent.find((m) => m.to === 'one@example.com')!)!;
    await expect(h.service.verify(first)).rejects.toThrow(
      INVALID_EMAIL_TOKEN_MESSAGE,
    );
    expect(h.changes).toHaveLength(1);
  });

  it('answers 409 when another account took the address before confirmation', async () => {
    const h = harness();
    await h.service.requestEmailChange('u-1', 'right', 'race@example.com');
    await h.flush();
    h.accounts[1].email = 'race@example.com';
    await expect(
      h.service.verify(
        h.codeIn(h.sent.find((m) => m.to === 'race@example.com')!)!,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.accounts[0].email).toBe('sam@example.com');
  });

  it('expires', async () => {
    const h = harness();
    await h.service.requestEmailChange('u-1', 'right', 'late@example.com');
    await h.flush();
    h.advance(86401);
    await expect(
      h.service.verify(
        h.codeIn(h.sent.find((m) => m.to === 'late@example.com')!)!,
      ),
    ).rejects.toThrow(INVALID_EMAIL_TOKEN_MESSAGE);
  });
});

describe('maskEmail', () => {
  it.each([
    ['new@example.com', 'n***@example.com'],
    ['a@b.de', 'a***@b.de'],
    ['broken', '***'],
  ])('%s → %s', (input, masked) => {
    expect(maskEmail(input)).toBe(masked);
  });
});
