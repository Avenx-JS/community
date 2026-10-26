import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import type { ReportStatus } from '../reports/report.constants';
import type { PlatformRole } from '../users/users.service';

export type AdminAction =
  | 'report_status_changed'
  | 'user_suspended'
  | 'user_banned'
  | 'restriction_lifted'
  | 'user_role_changed';

export type AdminActionTarget = 'user' | 'report' | 'restriction';

export type AuditEntry =
  | {
      actorId: string;
      action: 'report_status_changed';
      targetType: 'report';
      targetId: string;
      metadata?: {
        from_status?: ReportStatus;
        to_status?: ReportStatus;
        resolution?:
          | 'no_action'
          | 'content_removed'
          | 'user_warned'
          | 'user_suspended'
          | 'user_banned'
          | null;
      };
    }
  | {
      actorId: string;
      action: 'user_suspended';
      targetType: 'user';
      targetId: string;
      metadata?: {
        restriction_id?: string;
        expires_at?: string;
        report_id?: string | null;
      };
    }
  | {
      actorId: string;
      action: 'user_banned';
      targetType: 'user';
      targetId: string;
      metadata?: {
        restriction_id?: string;
        report_id?: string | null;
      };
    }
  | {
      actorId: string;
      action: 'restriction_lifted';
      targetType: 'restriction';
      targetId: string;
      metadata?: {
        restriction_id?: string;
        restriction_type?: 'suspension' | 'ban';
      };
    }
  | {
      actorId: string;
      action: 'user_role_changed';
      targetType: 'user';
      targetId: string;
      metadata?: {
        from_role?: PlatformRole;
        to_role?: PlatformRole;
      };
    };

interface ActorRow extends RowDataPacket {
  username: string;
}

const reportStatuses: readonly string[] = [
  'open',
  'under_review',
  'resolved',
  'rejected',
];
const reportResolutions: readonly string[] = [
  'no_action',
  'content_removed',
  'user_warned',
  'user_suspended',
  'user_banned',
];
const platformRoles: readonly string[] = ['user', 'moderator', 'admin'];

function metadataObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Audit metadata must be an object');
  }
  return Object.fromEntries(Object.entries(value));
}

function isAuditEntry(value: PoolConnection | AuditEntry): value is AuditEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'actorId' in value &&
    'action' in value
  );
}

function requiredString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid audit metadata field: ${key}`);
  }
  return value;
}

function identifierValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = requiredString(metadata, key);
  if (value !== undefined && !/^[A-Za-z0-9_-]{1,36}$/.test(value)) {
    throw new TypeError(`Invalid audit metadata field: ${key}`);
  }
  return value;
}

function isoDateValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = requiredString(metadata, key);
  if (
    value !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
      !Number.isFinite(Date.parse(value)))
  ) {
    throw new TypeError(`Invalid audit metadata field: ${key}`);
  }
  return value;
}

function nullableString(
  metadata: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = metadata[key];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid audit metadata field: ${key}`);
  }
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(value)) {
    throw new TypeError(`Invalid audit metadata field: ${key}`);
  }
  return value;
}

function enumValue(
  metadata: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const value = requiredString(metadata, key);
  if (value !== undefined && !allowed.includes(value)) {
    throw new TypeError(`Invalid audit metadata field: ${key}`);
  }
  return value;
}

export function buildAuditMetadata(
  entry: AuditEntry,
): Record<string, string | null> | null {
  const metadata = metadataObject(entry.metadata);
  const result: Record<string, string | null> = {};

  switch (entry.action) {
    case 'report_status_changed': {
      const fromStatus = enumValue(metadata, 'from_status', reportStatuses);
      const toStatus = enumValue(metadata, 'to_status', reportStatuses);
      const resolutionValue = metadata.resolution;
      const resolution =
        resolutionValue === null
          ? null
          : enumValue(metadata, 'resolution', reportResolutions);
      if (fromStatus !== undefined) result.from_status = fromStatus;
      if (toStatus !== undefined) result.to_status = toStatus;
      if (resolution !== undefined) result.resolution = resolution;
      break;
    }
    case 'user_suspended': {
      const restrictionId = identifierValue(metadata, 'restriction_id');
      const expiresAt = isoDateValue(metadata, 'expires_at');
      const reportId = nullableString(metadata, 'report_id');
      if (restrictionId !== undefined) result.restriction_id = restrictionId;
      if (expiresAt !== undefined) result.expires_at = expiresAt;
      if (reportId !== undefined) result.report_id = reportId;
      break;
    }
    case 'user_banned': {
      const restrictionId = identifierValue(metadata, 'restriction_id');
      const reportId = nullableString(metadata, 'report_id');
      if (restrictionId !== undefined) result.restriction_id = restrictionId;
      if (reportId !== undefined) result.report_id = reportId;
      break;
    }
    case 'restriction_lifted': {
      const restrictionId = identifierValue(metadata, 'restriction_id');
      const restrictionType = enumValue(metadata, 'restriction_type', [
        'suspension',
        'ban',
      ]);
      if (restrictionId !== undefined) result.restriction_id = restrictionId;
      if (restrictionType !== undefined) {
        result.restriction_type = restrictionType;
      }
      break;
    }
    case 'user_role_changed': {
      const fromRole = enumValue(metadata, 'from_role', platformRoles);
      const toRole = enumValue(metadata, 'to_role', platformRoles);
      if (fromRole !== undefined) result.from_role = fromRole;
      if (toRole !== undefined) result.to_role = toRole;
      break;
    }
  }

  return Object.keys(result).length === 0 ? null : result;
}

@Injectable()
export class AuditLogService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  record(connection: PoolConnection, entry: AuditEntry): Promise<void>;
  record(entry: AuditEntry): Promise<void>;
  async record(
    connectionOrEntry: PoolConnection | AuditEntry,
    maybeEntry?: AuditEntry,
  ): Promise<void> {
    if (maybeEntry !== undefined) {
      if (isAuditEntry(connectionOrEntry)) {
        throw new TypeError('Expected a database connection');
      }
      await this.insert(connectionOrEntry, maybeEntry);
      return;
    }

    if (!isAuditEntry(connectionOrEntry)) {
      throw new TypeError('Expected an audit entry');
    }
    const connection = await this.pool.getConnection();
    try {
      await this.insert(connection, connectionOrEntry);
    } finally {
      connection.release();
    }
  }

  private async insert(
    connection: PoolConnection,
    entry: AuditEntry,
  ): Promise<void> {
    const [actors] = await connection.execute<ActorRow[]>(
      'SELECT username FROM users WHERE id = ? LIMIT 1',
      [entry.actorId],
    );
    const actorUsername = actors[0]?.username;
    if (!actorUsername) {
      throw new Error('Audit actor could not be resolved');
    }

    const metadata = buildAuditMetadata(entry);
    await connection.execute(
      `INSERT INTO admin_actions
         (id, actor_id, actor_username, action, target_type, target_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        entry.actorId,
        actorUsername,
        entry.action,
        entry.targetType,
        entry.targetId,
        metadata === null ? null : JSON.stringify(metadata),
      ],
    );
  }
}
