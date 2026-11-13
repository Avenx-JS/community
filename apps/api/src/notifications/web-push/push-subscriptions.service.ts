import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../../auth/auth.service';
import type { CreatePushSubscriptionDto } from '../dto/push-subscription.dto';
import {
  isAllowedPushEndpoint,
  PUSH_CONFIG,
  type PushConfig,
} from './push-config';
import { base64url, isP256PublicKey } from './web-push-crypto';

export interface PushSubscriptionDto {
  id: string;
  // Only the push service's origin: the full endpoint is a capability to
  // push to the browser and is never returned.
  endpoint_origin: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  expires_at: string | null;
}

export interface PushSubscriptionListDto {
  // false when the operator has not configured VAPID keys.
  enabled: boolean;
  // The applicationServerKey for PushManager.subscribe(); null if disabled.
  public_key: string | null;
  items: PushSubscriptionDto[];
}

interface SubscriptionRow extends RowDataPacket {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: Date | string;
  last_success_at: Date | string | null;
  expires_at: Date | string | null;
}

const COLUMNS =
  'id, endpoint, user_agent, created_at, last_success_at, expires_at';

export const endpointHash = (endpoint: string) =>
  createHash('sha256').update(endpoint).digest('hex');

// Values: user, the endpoint hash to leave out (a re-registration).
export const COUNT_SUBSCRIPTIONS_SQL =
  'SELECT COUNT(*) AS total FROM push_subscriptions WHERE user_id = ? AND endpoint_hash <> ?';

// One row per endpoint. A browser that registers again, under this account
// or another, takes the row over with its current keys and a clean record.
export const UPSERT_SUBSCRIPTION_SQL = `INSERT INTO push_subscriptions
         (id, user_id, endpoint, endpoint_hash, p256dh, auth, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), endpoint = VALUES(endpoint),
         p256dh = VALUES(p256dh), auth = VALUES(auth), expires_at = VALUES(expires_at),
         user_agent = VALUES(user_agent), failure_count = 0`;

export const SUBSCRIPTION_BY_ENDPOINT_SQL = `SELECT ${COLUMNS} FROM push_subscriptions WHERE endpoint_hash = ? LIMIT 1`;
export const OWN_SUBSCRIPTIONS_SQL = `SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC`;
export const DELETE_SUBSCRIPTION_SQL =
  'DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?';

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function toDto(row: SubscriptionRow): PushSubscriptionDto {
  return {
    id: row.id,
    endpoint_origin: new URL(row.endpoint).origin,
    user_agent: row.user_agent,
    created_at: iso(row.created_at)!,
    last_success_at: iso(row.last_success_at),
    expires_at: iso(row.expires_at),
  };
}

// POST, GET and DELETE /users/me/push-subscriptions. Every statement is bound
// to the caller from the token.
@Injectable()
export class PushSubscriptionsService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    @Inject(PUSH_CONFIG) private readonly config: PushConfig,
  ) {}

  async register(
    userId: string,
    input: CreatePushSubscriptionDto,
    userAgent: string | undefined,
  ): Promise<PushSubscriptionDto> {
    if (!this.config.vapid) {
      throw new ServiceUnavailableException(
        'Web push is not configured on this server',
      );
    }
    if (!isAllowedPushEndpoint(input.endpoint, this.config.allowedHosts)) {
      throw new BadRequestException(
        'endpoint must be an https URL of a supported push service',
      );
    }
    if (!isP256PublicKey(base64url.decode(input.keys.p256dh))) {
      throw new BadRequestException('keys.p256dh is not a P-256 public key');
    }
    if (base64url.decode(input.keys.auth).length !== 16) {
      throw new BadRequestException('keys.auth must be 16 bytes');
    }
    if (
      typeof input.expirationTime === 'number' &&
      input.expirationTime <= Date.now()
    ) {
      throw new BadRequestException('The subscription has already expired');
    }

    const hash = endpointHash(input.endpoint);
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(COUNT_SUBSCRIPTIONS_SQL, [userId, hash]);
    if (Number(counts[0]?.total ?? 0) >= this.config.perAccount) {
      throw new ConflictException(
        `An account has at most ${this.config.perAccount} push subscriptions; remove one first`,
      );
    }
    await this.pool.execute<ResultSetHeader>(UPSERT_SUBSCRIPTION_SQL, [
      randomUUID(),
      userId,
      input.endpoint,
      hash,
      input.keys.p256dh,
      input.keys.auth,
      typeof input.expirationTime === 'number'
        ? new Date(input.expirationTime)
        : null,
      userAgent?.slice(0, 255) ?? null,
    ]);
    const [rows] = await this.pool.execute<SubscriptionRow[]>(
      SUBSCRIPTION_BY_ENDPOINT_SQL,
      [hash],
    );
    return toDto(rows[0]);
  }

  async list(userId: string): Promise<PushSubscriptionListDto> {
    const [rows] = await this.pool.execute<SubscriptionRow[]>(
      OWN_SUBSCRIPTIONS_SQL,
      [userId],
    );
    return {
      enabled: this.config.vapid !== null,
      public_key: this.config.vapid?.publicKey ?? null,
      items: rows.map(toDto),
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      DELETE_SUBSCRIPTION_SQL,
      [id, userId],
    );
    if (result.affectedRows === 0) {
      throw new NotFoundException('Push subscription not found');
    }
  }
}
