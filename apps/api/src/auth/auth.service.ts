import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
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
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { readPositiveInteger } from '../common/read-positive-integer';

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

interface SessionUserRow extends RowDataPacket {
  id: string;
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
  | { kind: 'valid'; userId: string }
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
  private readonly activityWriteIntervalSeconds = readPositiveInteger(
    'USER_ACTIVITY_WRITE_INTERVAL_SECONDS',
    300,
  );

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
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

    return this.createSession(user);
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const identifier = input.identifier.trim().toLowerCase();
    const [users] = await this.pool.execute<UserRow[]>(
      'SELECT id, username, email, password_hash, created_at FROM users WHERE email = ? OR username = ? LIMIT 1',
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
      await this.pool.execute<ResultSetHeader>(
        'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?',
        [passwordHash, user.id, user.password_hash],
      );
      user.password_hash = passwordHash;
    }

    const restriction = await this.getActiveRestriction(user.id);
    if (restriction) {
      throw new ForbiddenException(this.restrictionErrorPayload(restriction));
    }

    return this.createSession(user);
  }

  async validateAccessToken(token: string): Promise<string | null> {
    const result = await this.validateAccessTokenState(token);
    return result.kind === 'valid' ? result.userId : null;
  }

  async validateAccessTokenState(token: string): Promise<AccessTokenValidationResult> {
    const tokenHash = this.hashToken(token);
    const [sessions] = await this.pool.execute<SessionUserRow[]>(
      `SELECT auth_sessions.user_id AS id,
         restriction.type AS restriction_type,
         restriction.expires_at AS restriction_expires_at
       FROM auth_sessions
       LEFT JOIN user_restrictions restriction
         ON restriction.user_id = auth_sessions.user_id
        AND ${ACTIVE_USER_RESTRICTION_PREDICATE}
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
            session.restriction_expires_at === null
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
           AND (last_seen_at IS NULL
                OR last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND))`,
        [userId, this.activityWriteIntervalSeconds],
      );
    } catch {
      // Activity is best-effort telemetry; token validation has already succeeded.
    }

    return { kind: 'valid', userId };
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

  private async getActiveRestriction(
    userId: string,
    executor: {
      execute: (
        sql: string,
        values: unknown[],
      ) => Promise<[ActiveRestrictionRow[], unknown]>;
    } = this.pool,
  ): Promise<ActiveRestriction | null> {
    const [rows] = await executor.execute(
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

  async refresh(refreshToken: string): Promise<AuthResponse> {
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
          'SELECT id, username, email, password_hash, created_at FROM users WHERE id = ? LIMIT 1',
          [currentToken.user_id],
        );
        const user = users[0];
        if (!user) {
          throw new UnauthorizedException('Invalid or expired refresh token');
        }

        const restriction = await this.getActiveRestriction(user.id, connection);
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

        const [sessionResult] = await connection.execute<ResultSetHeader>(
          'UPDATE auth_sessions SET token_hash = ?, expires_at = ? WHERE session_id = ?',
          [
            this.hashToken(accessToken),
            accessExpiresAt,
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

  private async createSession(user: UserRow): Promise<AuthResponse> {
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
        'INSERT INTO auth_sessions (token_hash, user_id, expires_at, session_id) VALUES (?, ?, ?, ?)',
        [this.hashToken(accessToken), user.id, accessExpiresAt, sessionId],
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
    return createHash('sha256').update(token).digest('hex');
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
