import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { isSqlTrue } from '../common/community-moderation';
import { readPositiveInteger } from '../common/read-positive-integer';
import { EmailTransport } from '../email/email-transport';
import { EmailDeliveryError } from '../email/smtp-email.transport';
import {
  AuthService,
  hashOpaqueToken,
  INVALIDATE_RESET_TOKENS_SQL,
  MYSQL_POOL,
} from './auth.service';

// Email verification and email change (migration 037). Codes are random,
// single use, expire, and are stored only as SHA-256 hashes, exactly like
// password reset codes.

export const LOCK_EMAIL_ACCOUNT_SQL =
  'SELECT id, email, email_verified_at, password_hash FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE';
export const INVALIDATE_VERIFICATION_TOKENS_SQL =
  'UPDATE email_verification_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL';
export const INSERT_VERIFICATION_TOKEN_SQL =
  'INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND))';
export const VERIFICATION_TOKEN_OWNER_SQL =
  'SELECT user_id FROM email_verification_tokens WHERE token_hash = ? LIMIT 1';
export const LOCK_VERIFICATION_TOKEN_SQL =
  'SELECT user_id, email, used_at, expires_at <= UTC_TIMESTAMP() AS expired FROM email_verification_tokens WHERE token_hash = ? FOR UPDATE';
export const CONSUME_VERIFICATION_TOKEN_SQL =
  'UPDATE email_verification_tokens SET used_at = UTC_TIMESTAMP() WHERE token_hash = ? AND used_at IS NULL';
export const MARK_VERIFIED_SQL =
  'UPDATE users SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()) WHERE id = ? AND email = ?';

export const EMAIL_IN_USE_SQL = 'SELECT id FROM users WHERE email = ? LIMIT 1';
// One pending change per account: a new request replaces the old one, whose
// code stops working.
export const UPSERT_EMAIL_CHANGE_SQL =
  'INSERT INTO email_changes (user_id, new_email, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)) ON DUPLICATE KEY UPDATE new_email = VALUES(new_email), token_hash = VALUES(token_hash), expires_at = VALUES(expires_at), created_at = UTC_TIMESTAMP()';
export const EMAIL_CHANGE_OWNER_SQL =
  'SELECT user_id FROM email_changes WHERE token_hash = ? LIMIT 1';
export const LOCK_EMAIL_CHANGE_SQL =
  'SELECT user_id, new_email, expires_at <= UTC_TIMESTAMP() AS expired FROM email_changes WHERE token_hash = ? FOR UPDATE';
export const APPLY_EMAIL_CHANGE_SQL =
  'UPDATE users SET email = ?, email_verified_at = UTC_TIMESTAMP() WHERE id = ?';
export const DELETE_EMAIL_CHANGE_SQL =
  'DELETE FROM email_changes WHERE user_id = ?';

// One message for unknown, used, expired and superseded codes alike.
export const INVALID_EMAIL_TOKEN_MESSAGE = 'Invalid or expired code';

export const EMAIL_CHANGE_REQUESTED_MESSAGE =
  'If the new address can be used, a confirmation code has been sent to it. The address changes once that code is confirmed.';

interface EmailAccountRow extends RowDataPacket {
  id: string;
  email: string;
  email_verified_at: Date | string | null;
  password_hash: string;
}

export type EmailVerificationResult =
  | { status: 'verified'; email: string }
  | { status: 'email_changed'; email: string };

// a***@example.com: enough to recognise one's own address in a notice to
// the old one, without spelling out the new address to whoever reads it.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) {
    return '***';
  }
  return `${email[0]}***${email.slice(at)}`;
}

@Injectable()
export class EmailVerificationService implements OnModuleInit {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly verificationTtlSeconds = readPositiveInteger(
    'EMAIL_VERIFICATION_TTL_SECONDS',
    86400,
  );
  private readonly changeTtlSeconds = readPositiveInteger(
    'EMAIL_CHANGE_TTL_SECONDS',
    86400,
  );

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly email: EmailTransport,
    private readonly auth: AuthService,
  ) {}

  // A new account is sent its code at once, without delaying the response.
  onModuleInit(): void {
    this.auth.onRegistered = (userId) => {
      void this.issue(userId).catch(() => {
        this.logger.warn(
          'Verification code could not be issued at registration',
        );
      });
    };
  }

  // POST /auth/email/verify-request. 409 for an address already confirmed.
  // The code is stored before the response; the email goes out detached, so
  // a slow or failing mail server never turns into an error the client
  // would retry.
  async requestVerification(userId: string): Promise<void> {
    const issued = await this.issue(userId);
    if (!issued) {
      throw new ConflictException('Your email address is already confirmed');
    }
  }

  // PATCH /users/me/email. The address only changes once the code sent to
  // the new one is confirmed. The answer is the same whether or not another
  // account uses the new address, so the route cannot test which addresses
  // are registered: such an address gets a notice instead of a code.
  async requestEmailChange(
    userId: string,
    currentPassword: string,
    rawNewEmail: string,
  ): Promise<void> {
    const newEmail = rawNewEmail.trim().toLowerCase();
    const token = randomBytes(32).toString('base64url');
    let oldEmail = '';
    let available = false;
    await this.inTransaction(async (connection) => {
      const account = await this.lockAccount(connection, userId);
      if (
        !(await this.auth.passwordMatches(
          currentPassword,
          account.password_hash,
        ))
      ) {
        throw new UnauthorizedException('Invalid credentials');
      }
      if (account.email.toLowerCase() === newEmail) {
        throw new BadRequestException('new_email is already your address');
      }
      oldEmail = account.email;
      const [taken] = await connection.execute<RowDataPacket[]>(
        EMAIL_IN_USE_SQL,
        [newEmail],
      );
      available = taken.length === 0;
      if (available) {
        await connection.execute<ResultSetHeader>(UPSERT_EMAIL_CHANGE_SQL, [
          userId,
          newEmail,
          hashOpaqueToken(token),
          this.changeTtlSeconds,
        ]);
      }
    });

    this.sendDetached(
      available
        ? {
            to: newEmail,
            subject: 'Confirm your new email address',
            text: this.codeText(
              'Someone asked to use this address for their account.',
              token,
              this.changeTtlSeconds,
              'If this was not you, ignore this message: nothing changes.',
            ),
          }
        : {
            to: newEmail,
            subject: 'Your email address was entered',
            text: [
              'Someone asked to use this address for their account, but an account already uses it.',
              '',
              'If this was you, sign in with this address instead. If not, ignore this message.',
            ].join('\n'),
          },
    );
    this.sendDetached({
      to: oldEmail,
      subject: 'A change of your email address was requested',
      text: [
        `Someone signed in to your account asked to change its email address to ${maskEmail(newEmail)}.`,
        '',
        'Nothing changes until the new address is confirmed. If this was not you, change your password and end your other sessions now.',
      ].join('\n'),
    });
  }

  // POST /auth/email/verify: a code from either email. It confirms the
  // current address, or applies a pending change.
  async verify(token: string): Promise<EmailVerificationResult> {
    const tokenHash = hashOpaqueToken(token);
    const [owners] = await this.pool.execute<
      (RowDataPacket & { user_id: string })[]
    >(VERIFICATION_TOKEN_OWNER_SQL, [tokenHash]);
    if (owners[0]) {
      return this.confirmAddress(owners[0].user_id, tokenHash);
    }
    const [changes] = await this.pool.execute<
      (RowDataPacket & { user_id: string })[]
    >(EMAIL_CHANGE_OWNER_SQL, [tokenHash]);
    if (changes[0]) {
      return this.applyChange(changes[0].user_id, tokenHash);
    }
    throw new BadRequestException(INVALID_EMAIL_TOKEN_MESSAGE);
  }

  // Stores a fresh code for the account's current address, voiding earlier
  // ones, and sends it detached. false when the address is already
  // confirmed. The users row is locked first, then the token rows, as in
  // every other flow over these tables.
  private async issue(userId: string): Promise<boolean> {
    const token = randomBytes(32).toString('base64url');
    const address = await this.inTransaction(async (connection) => {
      const account = await this.lockAccount(connection, userId);
      if (account.email_verified_at !== null) {
        return null;
      }
      await connection.execute<ResultSetHeader>(
        INVALIDATE_VERIFICATION_TOKENS_SQL,
        [userId],
      );
      await connection.execute<ResultSetHeader>(INSERT_VERIFICATION_TOKEN_SQL, [
        hashOpaqueToken(token),
        userId,
        account.email,
        this.verificationTtlSeconds,
      ]);
      return account.email;
    });
    if (address === null) {
      return false;
    }
    this.sendDetached({
      to: address,
      subject: 'Confirm your email address',
      text: this.codeText(
        'Confirm the email address of your account.',
        token,
        this.verificationTtlSeconds,
        'If you did not create an account, ignore this message.',
      ),
    });
    return true;
  }

  private async confirmAddress(
    userId: string,
    tokenHash: string,
  ): Promise<EmailVerificationResult> {
    return this.inTransaction(async (connection) => {
      const account = await this.lockAccount(connection, userId, true);
      const [tokens] = await connection.execute<
        (RowDataPacket & {
          email: string;
          used_at: Date | string | null;
          expired: number | string | boolean;
        })[]
      >(LOCK_VERIFICATION_TOKEN_SQL, [tokenHash]);
      const current = tokens[0];
      // A code sent to an address the account no longer has is void too.
      if (
        !current ||
        current.used_at !== null ||
        isSqlTrue(current.expired) ||
        current.email !== account.email
      ) {
        throw new BadRequestException(INVALID_EMAIL_TOKEN_MESSAGE);
      }
      const [consumed] = await connection.execute<ResultSetHeader>(
        CONSUME_VERIFICATION_TOKEN_SQL,
        [tokenHash],
      );
      if (consumed.affectedRows !== 1) {
        throw new BadRequestException(INVALID_EMAIL_TOKEN_MESSAGE);
      }
      await connection.execute<ResultSetHeader>(MARK_VERIFIED_SQL, [
        userId,
        account.email,
      ]);
      await connection.execute<ResultSetHeader>(
        INVALIDATE_VERIFICATION_TOKENS_SQL,
        [userId],
      );
      return { status: 'verified', email: account.email };
    });
  }

  private async applyChange(
    userId: string,
    tokenHash: string,
  ): Promise<EmailVerificationResult> {
    let oldEmail = '';
    const result = await this.inTransaction(async (connection) => {
      const account = await this.lockAccount(connection, userId, true);
      // Read before the update: the notice goes to the address being left.
      oldEmail = account.email;
      const [changes] = await connection.execute<
        (RowDataPacket & {
          new_email: string;
          expired: number | string | boolean;
        })[]
      >(LOCK_EMAIL_CHANGE_SQL, [tokenHash]);
      const change = changes[0];
      if (!change || isSqlTrue(change.expired)) {
        throw new BadRequestException(INVALID_EMAIL_TOKEN_MESSAGE);
      }
      try {
        await connection.execute<ResultSetHeader>(APPLY_EMAIL_CHANGE_SQL, [
          change.new_email,
          userId,
        ]);
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
          throw new ConflictException(
            'Another account has taken that address in the meantime',
          );
        }
        throw error;
      }
      await connection.execute<ResultSetHeader>(DELETE_EMAIL_CHANGE_SQL, [
        userId,
      ]);
      // Codes mailed to the old address must not outlive it: verification
      // codes for it, and password reset codes in its inbox.
      await connection.execute<ResultSetHeader>(
        INVALIDATE_VERIFICATION_TOKENS_SQL,
        [userId],
      );
      await connection.execute<ResultSetHeader>(INVALIDATE_RESET_TOKENS_SQL, [
        userId,
      ]);
      return { status: 'email_changed' as const, email: change.new_email };
    });
    this.sendDetached({
      to: oldEmail,
      subject: 'Your email address was changed',
      text: [
        `The email address of your account is now ${maskEmail(result.email)}.`,
        '',
        'If this was not you, reset your password with the new address or contact support.',
      ].join('\n'),
    });
    return result;
  }

  private async lockAccount(
    connection: PoolConnection,
    userId: string,
    asInvalidToken = false,
  ): Promise<EmailAccountRow> {
    const [rows] = await connection.execute<EmailAccountRow[]>(
      LOCK_EMAIL_ACCOUNT_SQL,
      [userId],
    );
    if (!rows[0]) {
      throw asInvalidToken
        ? new BadRequestException(INVALID_EMAIL_TOKEN_MESSAGE)
        : new NotFoundException('User not found');
    }
    return rows[0];
  }

  private codeText(
    intro: string,
    token: string,
    ttlSeconds: number,
    outro: string,
  ): string {
    const hours = Math.max(1, Math.round(ttlSeconds / 3600));
    return [
      intro,
      '',
      `Your code, valid for ${hours} hour${hours === 1 ? '' : 's'} and usable once (POST /auth/email/verify):`,
      '',
      token,
      '',
      outro,
    ].join('\n');
  }

  // Never rejects. Logs carry no code, address or body.
  private sendDetached(message: {
    to: string;
    subject: string;
    text: string;
  }): void {
    void this.email.send(message).catch((error: unknown) => {
      const code = error instanceof EmailDeliveryError ? error.code : undefined;
      this.logger.warn(
        `Account email could not be sent${code ? ` (${code})` : ''}`,
      );
    });
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let started = false;
    try {
      await connection.beginTransaction();
      started = true;
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (started) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
