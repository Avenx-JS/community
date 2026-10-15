import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export const MYSQL_POOL = Symbol('MYSQL_POOL');

const accessTokenLifetimeMs = 12 * 60 * 60 * 1000;
const scryptParameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

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

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  user: {
    id: string;
    username: string;
    email: string;
    createdAt: string;
  };
}

@Injectable()
export class AuthService {
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
        throw new ConflictException('Username or email already exists');
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

    if (
      !user ||
      !(await this.verifyPassword(input.password, user.password_hash))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.createSession(user);
  }

  async validateAccessToken(token: string): Promise<string | null> {
    const tokenHash = this.hashToken(token);
    const [sessions] = await this.pool.execute<SessionUserRow[]>(
      'SELECT user_id AS id FROM auth_sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1',
      [tokenHash],
    );

    return sessions[0]?.id ?? null;
  }

  async logout(token: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      'DELETE FROM auth_sessions WHERE token_hash = ?',
      [this.hashToken(token)],
    );
  }

  private async createSession(user: UserRow): Promise<AuthResponse> {
    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + accessTokenLifetimeMs);

    await this.pool.execute<ResultSetHeader>(
      'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      [this.hashToken(accessToken), user.id, expiresAt],
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        createdAt: new Date(user.created_at).toISOString(),
      },
    };
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await deriveKey(password, salt, 64);
    return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
  }

  private async verifyPassword(
    password: string,
    storedHash: string,
  ): Promise<boolean> {
    const [algorithm, cost, blockSize, parallelization, saltValue, hashValue] =
      storedHash.split('$');
    if (
      algorithm !== 'scrypt' ||
      cost !== '16384' ||
      blockSize !== '8' ||
      parallelization !== '1' ||
      !saltValue ||
      !hashValue
    ) {
      return false;
    }

    const expectedHash = Buffer.from(hashValue, 'base64url');
    const actualHash = await deriveKey(
      password,
      Buffer.from(saltValue, 'base64url'),
      expectedHash.length,
    );

    return (
      expectedHash.length === actualHash.length &&
      timingSafeEqual(expectedHash, actualHash)
    );
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
