import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';
import type { HashOptions } from 'argon2';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { isSqlTrue } from '../common/community-moderation';
import { readPositiveInteger } from '../common/read-positive-integer';
import { EmailTransport } from '../email/email-transport';
import { EmailDeliveryError } from '../email/smtp-email.transport';
import type { ClientOrigin } from './client-origin';

// SHA-256 of an opaque token: how every credential of this API is stored
// (sessions, refresh tokens, password reset and email verification codes).
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const NO_ORIGIN: ClientOrigin = { ipPrefix: null, userAgent: null };

// A live session: its access row, and a current refresh token (not used, not
// revoked, not expired). Bound to [user]. The newest use first.
export const LIST_SESSIONS_SQL = `SELECT s.session_id, s.token_hash, s.created_at, s.last_used_at, s.ip_prefix, s.user_agent
       FROM auth_sessions s
       WHERE s.user_id = ?
         AND EXISTS (
           SELECT 1 FROM auth_refresh_tokens r
           WHERE r.session_id = s.session_id
             AND r.used_at IS NULL AND r.revoked_at IS NULL
             AND r.expires_at > UTC_TIMESTAMP()
         )
       ORDER BY COALESCE(s.last_used_at, s.created_at) DESC, s.session_id ASC`;

export interface SessionDto {
  id: string;
  created_at: string;
  // The last token rotation: accurate to the access token's 15 minutes.
  last_used_at: string;
  // The client network (/24 or /48), never the full address.
  ip_prefix: string | null;
  user_agent: string | null;
  // Whether this is the session the request was made with.
  current: boolean;
}

export const MYSQL_POOL = Symbol('MYSQL_POOL');

const accessTokenLifetimeMs = 15 * 60 * 1000;
const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const scryptParameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const passwordHashParameters: HashOptions = {
  type: argon2id,
  version: 0x13,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};
const argon2HashPattern =
  /^\$argon2id\$v=19\$m=19456,p=1,t=2\$[A-Za-z0-9+/]{20,24}\$[A-Za-z0-9+/]{40,44}$/;
const legacyScryptHashPattern =
  /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;

export const LOCK_PASSWORD_SQL =
  'SELECT id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE';
// Binds the hash that was verified, so a concurrent change is never
// overwritten: the same compare-and-set login uses for its rehash.
export const CHANGE_PASSWORD_SQL =
  'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?';

export const RESET_ACCOUNT_BY_EMAIL_SQL =
  'SELECT id, email FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1';
export const INVALIDATE_RESET_TOKENS_SQL =
  'UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL';
export const INSERT_RESET_TOKEN_SQL =
  'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))';
export const RESET_TOKEN_OWNER_SQL =
  'SELECT user_id FROM password_reset_tokens WHERE token_hash = ? LIMIT 1';
// Expiry is decided in SQL, against the same clock and session time zone that
// wrote expires_at. Comparing in JavaScript would be off by the UTC offset on a
// server whose session time zone is not UTC.
export const LOCK_RESET_TOKEN_SQL =
  'SELECT user_id, used_at, expires_at <= UTC_TIMESTAMP() AS expired FROM password_reset_tokens WHERE token_hash = ? FOR UPDATE';
export const RESET_PASSWORD_SQL =
  'UPDATE users SET password_hash = ? WHERE id = ?';
export const CONSUME_RESET_TOKEN_SQL =
  'UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE token_hash = ? AND used_at IS NULL';

// One message for unknown, used and expired alike: telling them apart would
// tell an attacker which guesses are close.
export const INVALID_RESET_TOKEN_MESSAGE = 'Invalid or expired reset token';

interface PasswordVerification {
  valid: boolean;
  needsRehash: boolean;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyLength,
      scryptParameters,
      (error, key) => {
        if (error) {
          reject(error);
        } else {
          resolve(key);
        }
      },
    );
  });
}

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

interface PasswordRow extends RowDataPacket {
  id: string;
  password_hash: string;
}

interface SessionUserRow extends RowDataPacket {
  id: string;
  email_verified?: number | string | boolean | null;
  restriction_type?: 'suspension' | 'ban';
  restriction_expires_at?: Date | string | null;
}

interface ActiveRestrictionRow extends RowDataPacket {
  type: 'suspension' | 'ban';
  expires_at: Date | string | null;
}

interface RefreshTokenRow extends RowDataPacket {
  session_id: string;
  user_id: string;
  expires_at: Date | string;
  used_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface ResetAccountRow extends RowDataPacket {
  id: string;
  email: string;
}

interface ResetTokenRow extends RowDataPacket {
  user_id: string;
  used_at: Date | string | null;
  expired: number | string | boolean;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

export interface LoginInput {
  identifier: string;
  password: string;
}

export interface ActiveRestriction {
  type: 'suspension' | 'ban';
  expires_at: string | null;
}

export type AccessTokenValidationResult =
  // emailVerified: the account's current address is confirmed
  // (users.email_verified_at). Routes that require it check it in AuthGuard.
  | { kind: 'valid'; userId: string; emailVerified: boolean }
  | { kind: 'restricted'; userId: string; restriction: ActiveRestriction }
  | { kind: 'invalid' };

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: {
    id: string;
    username: string;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly activityWriteIntervalSeconds = readPositiveInteger(
    'USER_ACTIVITY_WRITE_INTERVAL_SECONDS',
    300,
  );
  private readonly passwordResetTtlSeconds = readPositiveInteger(
    'PASSWORD_RESET_TTL_SECONDS',
    3600,
  );

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly email: EmailTransport,
  ) {}

  // Set by EmailVerificationService, which registration notifies: a new
  // account is sent its verification code at once. Optional, so the service
  // also runs without it (unit tests).
  onRegistered?: (userId: string) => void;

  async register(
    input: RegisterInput,
    origin: ClientOrigin = NO_ORIGIN,
  ): Promise<AuthResponse> {
    const username = input.username.trim();
    const email = input.email.trim().toLowerCase();
    const passwordHash = await this.hashPassword(input.password);
    const id = randomUUID();

    try {
      await this.pool.execute<ResultSetHeader>(
        'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
        [id, username, email, passwordHash],
      );
    } catch (error) {
      if (this.isDuplicateEntry(error)) {
        throw new ConflictException('Registration could not be completed');
      }
      throw error;
    }

    const user: UserRow = {
      id,
      username,
      email,
      password_hash: passwordHash,
      created_at: new Date(),
    } as UserRow;

    const session = await this.createSession(user, origin);
    this.onRegistered?.(id);
    return session;
  }

  async login(
    input: LoginInput,
    origin: ClientOrigin = NO_ORIGIN,
  ): Promise<AuthResponse> {
    const identifier = input.identifier.trim().toLowerCase();
    const [users] = await this.pool.execute<UserRow[]>(
      'SELECT id, username, email, password_hash, created_at FROM users WHERE (email = ? OR username = ?) AND deleted_at IS NULL LIMIT 1',
      [identifier, identifier],
    );
    const user = users[0];

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const verification = await this.verifyPassword(
      input.password,
      user.password_hash,
    );
    if (!verification.valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (verification.needsRehash) {
      const passwordHash = await this.hashPassword(input.password);
      await this.pool.execute<ResultSetHeader>(CHANGE_PASSWORD_SQL, [
        passwordHash,
        user.id,
        user.password_hash,
      ]);
      user.password_hash = passwordHash;
    }

    const restriction = await this.getActiveRestriction(user.id);
    if (restriction) {
      throw new ForbiddenException(this.restrictionErrorPayload(restriction));
    }

    return this.createSession(user, origin);
  }

  async validateAccessToken(token: string): Promise<string | null> {
    const result = await this.validateAccessTokenState(token);
    return result.kind === 'valid' ? result.userId : null;
  }

  // GET /auth/sessions: the caller's live sessions. Never a token or a full
  // address: the token hash is compared here and dropped.
  async listSessions(
    userId: string,
    currentAccessToken: string,
  ): Promise<{ items: SessionDto[] }> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        session_id: string;
        token_hash: string;
        created_at: Date | string;
        last_used_at: Date | string | null;
        ip_prefix: string | null;
        user_agent: string | null;
      })[]
    >(LIST_SESSIONS_SQL, [userId]);
    const current = this.hashToken(currentAccessToken);
    return {
      items: rows.map((row) => ({
        id: row.session_id,
        created_at: new Date(row.created_at).toISOString(),
        last_used_at: new Date(
          row.last_used_at ?? row.created_at,
        ).toISOString(),
        ip_prefix: row.ip_prefix,
        user_agent: row.user_agent,
        current: row.token_hash === current,
      })),
    };
  }

  // DELETE /auth/sessions/:id: ends one session at once. Its access token is
  // deleted and every refresh token of it revoked in one transaction, so the
  // next refresh with it is refused. Another account's session is 404, like
  // an unknown one.
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await connection.execute(
        'SELECT token_hash FROM auth_refresh_tokens WHERE session_id = ? AND user_id = ? FOR UPDATE',
        [sessionId, userId],
      );
      const [deleted] = await connection.execute<ResultSetHeader>(
        'DELETE FROM auth_sessions WHERE session_id = ? AND user_id = ?',
        [sessionId, userId],
      );
      const [revoked] = await connection.execute<ResultSetHeader>(
        'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL',
        [sessionId, userId],
      );
      if (deleted.affectedRows === 0 && revoked.affectedRows === 0) {
        throw new NotFoundException('Session not found');
      }
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async validateAccessTokenState(
    token: string,
  ): Promise<AccessTokenValidationResult> {
    const tokenHash = this.hashToken(token);
    // A derived table, because the shared predicate's bare expires_at would be
    // ambiguous with auth_sessions.expires_at in the join's ON clause.
    const [sessions] = await this.pool.execute<SessionUserRow[]>(
      `SELECT auth_sessions.user_id AS id,
         users.email_verified_at IS NOT NULL AS email_verified,
         restriction.type AS restriction_type,
         restriction.expires_at AS restriction_expires_at
       FROM auth_sessions
       JOIN users ON users.id = auth_sessions.user_id
       LEFT JOIN (
         SELECT user_id, type, expires_at
         FROM user_restrictions
         WHERE ${ACTIVE_USER_RESTRICTION_PREDICATE}
       ) restriction
         ON restriction.user_id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = ?
         AND auth_sessions.expires_at > UTC_TIMESTAMP()
       LIMIT 1`,
      [tokenHash],
    );

    const session = sessions[0];
    if (!session) {
      return { kind: 'invalid' };
    }

    if (session.restriction_type) {
      return {
        kind: 'restricted',
        userId: session.id,
        restriction: {
          type: session.restriction_type,
          expires_at:
            session.restriction_expires_at === null ||
            session.restriction_expires_at === undefined
              ? null
              : new Date(session.restriction_expires_at).toISOString(),
        },
      };
    }

    const userId = session.id;
    try {
      await this.pool.execute<ResultSetHeader>(
        `UPDATE users
         SET last_seen_at = UTC_TIMESTAMP()
         WHERE id = ?
           AND deleted_at IS NULL
           AND (last_seen_at IS NULL
                OR last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND))`,
        [userId, this.activityWriteIntervalSeconds],
      );
    } catch {
      // Activity is best-effort telemetry; token validation has already succeeded.
    }

    return {
      kind: 'valid',
      userId,
      emailVerified: isSqlTrue(session.email_verified ?? 0),
    };
  }

  async logout(token: string): Promise<void> {
    const [sessions] = await this.pool.execute<
      (RowDataPacket & { session_id: string })[]
    >('SELECT session_id FROM auth_sessions WHERE token_hash = ? LIMIT 1', [
      this.hashToken(token),
    ]);
    const session = sessions[0];
    if (!session) {
      return;
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await connection.execute(
        'SELECT token_hash FROM auth_refresh_tokens WHERE session_id = ? FOR UPDATE',
        [session.session_id],
      );
      await connection.execute<ResultSetHeader>(
        'DELETE FROM auth_sessions WHERE session_id = ?',
        [session.session_id],
      );
      await connection.execute<ResultSetHeader>(
        'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL',
        [session.session_id],
      );
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async logoutAll(userId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await this.revokeAllSessions(userId, connection);
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // Revokes every access and refresh credential of an account inside the
  // caller's transaction, so the revocation commits or rolls back with it.
  async revokeAllSessions(
    userId: string,
    connection: PoolConnection,
  ): Promise<void> {
    await connection.execute(
      'SELECT token_hash FROM auth_refresh_tokens WHERE user_id = ? FOR UPDATE',
      [userId],
    );
    await connection.execute<ResultSetHeader>(
      'DELETE FROM auth_sessions WHERE user_id = ?',
      [userId],
    );
    await connection.execute<ResultSetHeader>(
      'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL',
      [userId],
    );
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      // FOR UPDATE serialises concurrent changes: the second waits, then
      // verifies against the hash the first one wrote.
      const [rows] = await connection.execute<PasswordRow[]>(
        LOCK_PASSWORD_SQL,
        [userId],
      );
      const row = rows[0];
      if (!row) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // Accepts a legacy scrypt hash exactly as login does; the Argon2id hash
      // written below upgrades it as a side effect.
      const verification = await this.verifyPassword(
        currentPassword,
        row.password_hash,
      );
      if (!verification.valid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const passwordHash = await this.hashPassword(newPassword);
      const [result] = await connection.execute<ResultSetHeader>(
        CHANGE_PASSWORD_SQL,
        [passwordHash, userId, row.password_hash],
      );
      if (result.affectedRows !== 1) {
        throw new ConflictException('The password was changed concurrently');
      }

      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }

    // Deliberately after the commit and allowed to fail: the password is
    // already changed, and a revocation failure must not roll that back or
    // turn the response into an error the client would retry against the
    // new password. Unlike a restriction there is no per-request backstop:
    // refresh does not consult the password, so on failure surviving access
    // tokens work until they expire (15 minutes) and surviving refresh tokens
    // until they are revoked by a later logout-all or expire (30 days).
    try {
      await this.logoutAll(userId);
    } catch {
      this.logger.warn('Session revocation failed after password change');
    }
  }

  // Resolves as soon as the account lookup, which both paths share, is done. The
  // rest runs detached so the response cannot depend on whether the address
  // exists: an SMTP send takes far longer than doing nothing, and a failed write
  // on the known path would otherwise be a 500 only known addresses can produce.
  async forgotPassword(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    const [accounts] = await this.pool.execute<ResetAccountRow[]>(
      RESET_ACCOUNT_BY_EMAIL_SQL,
      [email],
    );
    const account = accounts[0];
    // users.email has an accent-insensitive collation, so bób@ matches bob@.
    // Only the address itself counts: variants would otherwise each get their
    // own rate-limit bucket and could mail-bomb one account.
    if (!account || account.email.toLowerCase() !== email) {
      return;
    }
    void this.issuePasswordReset(account);
  }

  // Never rejects: nothing awaits it. Logs carry no token, address or body.
  private async issuePasswordReset(account: ResetAccountRow): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    try {
      if (!(await this.storePasswordResetToken(account.id, token))) {
        return;
      }
    } catch {
      this.logger.warn('Password reset could not be issued');
      return;
    }

    try {
      // The stored address, never the submitted one.
      await this.email.send({
        to: account.email,
        subject: 'Reset your password',
        text: this.passwordResetEmailText(token),
      });
    } catch (error) {
      const code = error instanceof EmailDeliveryError ? error.code : undefined;
      this.logger.warn(
        `Password reset email could not be sent${code ? ` (${code})` : ''}`,
      );
    }
  }

  private async storePasswordResetToken(
    userId: string,
    token: string,
  ): Promise<boolean> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      // Serialises concurrent requests for one account, so exactly one link is
      // left live, and holds off a concurrent account deletion. Always the users
      // row before the token rows, as in resetPassword and account deletion.
      const [accounts] = await connection.execute<PasswordRow[]>(
        LOCK_PASSWORD_SQL,
        [userId],
      );
      if (!accounts[0]) {
        await connection.rollback();
        transactionStarted = false;
        return false;
      }
      await connection.execute<ResultSetHeader>(INVALIDATE_RESET_TOKENS_SQL, [
        userId,
      ]);
      await connection.execute<ResultSetHeader>(INSERT_RESET_TOKEN_SQL, [
        this.hashToken(token),
        userId,
        this.passwordResetTtlSeconds,
      ]);
      await connection.commit();
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private passwordResetEmailText(token: string): string {
    const minutes = Math.ceil(this.passwordResetTtlSeconds / 60);
    return [
      'Someone asked to reset the password for your account.',
      '',
      `Your reset code, valid for ${minutes} minutes and usable once:`,
      '',
      token,
      '',
      'If this was not you, ignore this message: your password has not changed.',
    ].join('\n');
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const invalid = () => new BadRequestException(INVALID_RESET_TOKEN_MESSAGE);
    const tokenHash = this.hashToken(token);
    // Unlocked, only to find which users row to lock first. The token is judged
    // below, under its own lock.
    const [owners] = await this.pool.execute<
      (RowDataPacket & { user_id: string })[]
    >(RESET_TOKEN_OWNER_SQL, [tokenHash]);
    const userId = owners[0]?.user_id;
    if (!userId) {
      throw invalid();
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // A deleted account's password_hash must stay the placeholder.
      const [accounts] = await connection.execute<PasswordRow[]>(
        LOCK_PASSWORD_SQL,
        [userId],
      );
      if (!accounts[0]) {
        throw invalid();
      }

      // The lock is what stops two concurrent resets both consuming one token.
      const [tokens] = await connection.execute<ResetTokenRow[]>(
        LOCK_RESET_TOKEN_SQL,
        [tokenHash],
      );
      const current = tokens[0];
      if (!current || current.used_at !== null || isSqlTrue(current.expired)) {
        throw invalid();
      }

      await connection.execute<ResultSetHeader>(RESET_PASSWORD_SQL, [
        await this.hashPassword(newPassword),
        userId,
      ]);
      const [consumed] = await connection.execute<ResultSetHeader>(
        CONSUME_RESET_TOKEN_SQL,
        [tokenHash],
      );
      if (consumed.affectedRows !== 1) {
        throw invalid();
      }
      await connection.execute<ResultSetHeader>(INVALIDATE_RESET_TOKENS_SQL, [
        userId,
      ]);

      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }

    // After the commit and allowed to fail, as in changePassword, whose comment
    // sets out what survives a failure here.
    try {
      await this.logoutAll(userId);
    } catch {
      this.logger.warn('Session revocation failed after password reset');
    }
  }

  // Re-confirms a signed-in user's password. Fails closed for any stored value
  // that is neither an Argon2id nor a legacy scrypt hash.
  async passwordMatches(
    password: string,
    storedHash: string,
  ): Promise<boolean> {
    return (await this.verifyPassword(password, storedHash)).valid;
  }

  private async getActiveRestriction(
    userId: string,
    executor: Pool | PoolConnection = this.pool,
  ): Promise<ActiveRestriction | null> {
    const [rows] = await executor.execute<ActiveRestrictionRow[]>(
      `SELECT type, expires_at
       FROM user_restrictions
       WHERE user_id = ? AND ${ACTIVE_USER_RESTRICTION_PREDICATE}
       LIMIT 1`,
      [userId],
    );
    const restriction = rows[0];
    if (!restriction) {
      return null;
    }
    return {
      type: restriction.type,
      expires_at:
        restriction.expires_at === null
          ? null
          : new Date(restriction.expires_at).toISOString(),
    };
  }

  private restrictionErrorPayload(restriction: ActiveRestriction): {
    type: 'suspension' | 'ban';
    expires_at?: string;
  } {
    return restriction.type === 'suspension'
      ? {
          type: restriction.type,
          expires_at: restriction.expires_at ?? undefined,
        }
      : { type: restriction.type };
  }

  async refresh(
    refreshToken: string,
    origin: ClientOrigin = NO_ORIGIN,
  ): Promise<AuthResponse> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    let response: AuthResponse | undefined;
    let reusedToken = false;
    let missingSession = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [refreshTokens] = await connection.execute<RefreshTokenRow[]>(
        'SELECT session_id, user_id, expires_at, used_at, revoked_at FROM auth_refresh_tokens WHERE token_hash = ? FOR UPDATE',
        [this.hashToken(refreshToken)],
      );
      const currentToken = refreshTokens[0];

      if (!currentToken || currentToken.revoked_at !== null) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      if (currentToken.used_at !== null) {
        await connection.execute<ResultSetHeader>(
          'DELETE FROM auth_sessions WHERE session_id = ?',
          [currentToken.session_id],
        );
        await connection.execute<ResultSetHeader>(
          'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL',
          [currentToken.session_id],
        );
        reusedToken = true;
      } else if (new Date(currentToken.expires_at).getTime() <= Date.now()) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      } else {
        const [users] = await connection.execute<UserRow[]>(
          'SELECT id, username, email, password_hash, created_at FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
          [currentToken.user_id],
        );
        const user = users[0];
        if (!user) {
          throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const restriction = await this.getActiveRestriction(
          user.id,
          connection,
        );
        if (restriction) {
          if (restriction.type === 'ban') {
            await connection.execute<ResultSetHeader>(
              'DELETE FROM auth_sessions WHERE user_id = ?',
              [user.id],
            );
            await connection.execute<ResultSetHeader>(
              'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL',
              [user.id],
            );
            transactionStarted = false;
            await connection.commit();
            throw new ForbiddenException(
              this.restrictionErrorPayload(restriction),
            );
          }
          transactionStarted = false;
          await connection.commit();
          throw new ForbiddenException(
            this.restrictionErrorPayload(restriction),
          );
        }

        const accessToken = randomBytes(32).toString('base64url');
        const nextRefreshToken = randomBytes(32).toString('base64url');
        const accessExpiresAt = new Date(Date.now() + accessTokenLifetimeMs);
        const refreshExpiresAt = new Date(currentToken.expires_at);

        const [usedResult] = await connection.execute<ResultSetHeader>(
          'UPDATE auth_refresh_tokens SET used_at = UTC_TIMESTAMP() WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL',
          [this.hashToken(refreshToken)],
        );
        if (usedResult.affectedRows !== 1) {
          throw new UnauthorizedException('Invalid or expired refresh token');
        }

        // A rotation is a use: last_used_at, and the latest origin when the
        // request carried one.
        const [sessionResult] = await connection.execute<ResultSetHeader>(
          'UPDATE auth_sessions SET token_hash = ?, expires_at = ?, last_used_at = UTC_TIMESTAMP(), ip_prefix = COALESCE(?, ip_prefix), user_agent = COALESCE(?, user_agent) WHERE session_id = ?',
          [
            this.hashToken(accessToken),
            accessExpiresAt,
            origin.ipPrefix,
            origin.userAgent,
            currentToken.session_id,
          ],
        );
        if (sessionResult.affectedRows !== 1) {
          await connection.execute<ResultSetHeader>(
            'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL',
            [currentToken.session_id],
          );
          missingSession = true;
        } else {
          await connection.execute<ResultSetHeader>(
            'INSERT INTO auth_refresh_tokens (token_hash, session_id, user_id, expires_at) VALUES (?, ?, ?, ?)',
            [
              this.hashToken(nextRefreshToken),
              currentToken.session_id,
              currentToken.user_id,
              refreshExpiresAt,
            ],
          );

          response = this.createAuthResponse(
            user,
            accessToken,
            accessExpiresAt,
            nextRefreshToken,
            refreshExpiresAt,
          );
        }
      }

      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }

    if (reusedToken) {
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (missingSession) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (!response) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return response;
  }

  private async createSession(
    user: UserRow,
    origin: ClientOrigin,
  ): Promise<AuthResponse> {
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const accessExpiresAt = new Date(Date.now() + accessTokenLifetimeMs);
    const refreshExpiresAt = new Date(Date.now() + refreshTokenLifetimeMs);
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await connection.execute<ResultSetHeader>(
        'INSERT INTO auth_sessions (token_hash, user_id, expires_at, session_id, last_used_at, ip_prefix, user_agent) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)',
        [
          this.hashToken(accessToken),
          user.id,
          accessExpiresAt,
          sessionId,
          origin.ipPrefix,
          origin.userAgent,
        ],
      );
      await connection.execute<ResultSetHeader>(
        'INSERT INTO auth_refresh_tokens (token_hash, session_id, user_id, expires_at) VALUES (?, ?, ?, ?)',
        [this.hashToken(refreshToken), sessionId, user.id, refreshExpiresAt],
      );
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }

    return this.createAuthResponse(
      user,
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
    );
  }

  private createAuthResponse(
    user: UserRow,
    accessToken: string,
    accessExpiresAt: Date,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): AuthResponse {
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: accessExpiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
      },
    };
  }

  private async hashPassword(password: string): Promise<string> {
    return argon2Hash(password, passwordHashParameters);
  }

  private async verifyPassword(
    password: string,
    storedHash: string,
  ): Promise<PasswordVerification> {
    if (argon2HashPattern.test(storedHash)) {
      try {
        return {
          valid: await argon2Verify(storedHash, password),
          needsRehash: false,
        };
      } catch {
        return { valid: false, needsRehash: false };
      }
    }

    if (!legacyScryptHashPattern.test(storedHash)) {
      return { valid: false, needsRehash: false };
    }

    const [, , , , saltValue, hashValue] = storedHash.split('$');
    if (!saltValue || !hashValue) {
      return { valid: false, needsRehash: false };
    }

    try {
      const expectedHash = Buffer.from(hashValue, 'base64url');
      const salt = Buffer.from(saltValue, 'base64url');
      if (
        expectedHash.length !== 64 ||
        salt.length !== 16 ||
        expectedHash.toString('base64url') !== hashValue ||
        salt.toString('base64url') !== saltValue
      ) {
        return { valid: false, needsRehash: false };
      }
      const actualHash = await deriveKey(password, salt, expectedHash.length);
      return {
        valid: timingSafeEqual(expectedHash, actualHash),
        needsRehash: true,
      };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }

  private hashToken(token: string): string {
    return hashOpaqueToken(token);
  }

  private isDuplicateEntry(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ER_DUP_ENTRY'
    );
  }
}
