import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { hasControlCharacters } from '../common/safe-text.constraint';
import type { ListCommunityModerationActionsDto } from './dto/list-community-moderation-actions.dto';
import { visibleCommunityColumnsSql } from '../common/community-visibility';

// Mirrors the community_moderation_actions.action and target_type enums; read
// filters validate against these lists so they cannot drift from what is
// written. Actions whose endpoints are not built yet are declared up front.
export const COMMUNITY_MODERATION_ACTIONS = [
  'post_locked',
  'post_unlocked',
  'post_removed',
  'post_restored',
  'post_pinned',
  'post_unpinned',
  'comment_locked',
  'comment_unlocked',
  'comment_removed',
  'comment_restored',
  'member_banned',
  'member_unbanned',
  'member_removed',
  'moderator_added',
  'moderator_removed',
  'rules_published',
  'community_updated',
  'community_deleted',
] as const;

export type CommunityModerationAction =
  (typeof COMMUNITY_MODERATION_ACTIONS)[number];

export const COMMUNITY_MODERATION_TARGETS = [
  'post',
  'comment',
  'user',
  'rule_document',
  'community',
] as const;

export type CommunityModerationTarget =
  (typeof COMMUNITY_MODERATION_TARGETS)[number];

interface EntryBase {
  actorId: string;
  communityId: string;
  targetId: string;
}

export type CommunityModerationEntry =
  | (EntryBase & {
      action:
        | 'post_locked'
        | 'post_unlocked'
        | 'post_restored'
        | 'post_pinned'
        | 'post_unpinned';
      targetType: 'post';
      metadata?: Record<string, never>;
    })
  | (EntryBase & {
      action: 'post_removed';
      targetType: 'post';
      metadata?: { reason?: string };
    })
  | (EntryBase & {
      action: 'comment_locked' | 'comment_unlocked' | 'comment_restored';
      targetType: 'comment';
      metadata?: Record<string, never>;
    })
  | (EntryBase & {
      action: 'comment_removed';
      targetType: 'comment';
      metadata?: { reason?: string };
    })
  | (EntryBase & {
      action: 'member_banned';
      targetType: 'user';
      metadata?: { username?: string; reason?: string; expires_at?: string };
    })
  | (EntryBase & {
      action: 'member_removed';
      targetType: 'user';
      metadata?: { username?: string; reason?: string };
    })
  | (EntryBase & {
      action: 'member_unbanned' | 'moderator_added' | 'moderator_removed';
      targetType: 'user';
      metadata?: { username?: string };
    })
  | (EntryBase & {
      action: 'rules_published';
      targetType: 'rule_document';
      metadata?: { version?: number };
    })
  | (EntryBase & {
      action: 'community_updated';
      targetType: 'community';
      metadata?: { fields?: string };
    })
  | (EntryBase & {
      action: 'community_deleted';
      targetType: 'community';
      metadata?: Record<string, never>;
    });

// The community fields PATCH /communities/:name may change; a
// community_updated entry names which of them changed, never their values.
export const EDITABLE_COMMUNITY_FIELDS = ['description'] as const;

export type CommunityModerationMetadata = Record<string, string | number>;

interface ActorRow extends RowDataPacket {
  username: string;
}

interface CommunityAccessRow extends RowDataPacket {
  id: string;
  can_moderate: number | string | boolean;
}

export interface CommunityModerationActionRow extends RowDataPacket {
  id: string;
  action: CommunityModerationAction;
  actor_username: string;
  target_type: CommunityModerationTarget;
  target_id: string;
  metadata: Record<string, unknown> | string | null;
  created_at: Date | string;
}

export interface CommunityModerationActionItem {
  id: string;
  action: CommunityModerationAction;
  actor_username: string;
  target_type: CommunityModerationTarget;
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface CommunityModerationActionList {
  items: CommunityModerationActionItem[];
  page: number;
  limit: number;
  total: number;
}

// Moderator-written free text; bounded like a restriction reason.
const MAX_REASON_LENGTH = 2000;
// community_rule_documents.version is INT UNSIGNED.
const MAX_RULE_VERSION = 4294967295;

function metadataObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Community moderation metadata must be an object');
  }
  return Object.fromEntries(Object.entries(value));
}

function isEntry(
  value: PoolConnection | CommunityModerationEntry,
): value is CommunityModerationEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'actorId' in value &&
    'action' in value
  );
}

function invalid(key: string): TypeError {
  return new TypeError(`Invalid community moderation metadata field: ${key}`);
}

function stringValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalid(key);
  }
  return value;
}

function reasonValue(metadata: Record<string, unknown>): string | undefined {
  const value = stringValue(metadata, 'reason');
  if (
    value !== undefined &&
    (value.trim().length === 0 ||
      value.length > MAX_REASON_LENGTH ||
      hasControlCharacters(value, true))
  ) {
    throw invalid('reason');
  }
  return value;
}

function usernameValue(metadata: Record<string, unknown>): string | undefined {
  const value = stringValue(metadata, 'username');
  if (value !== undefined && !/^[A-Za-z0-9_]{3,50}$/.test(value)) {
    throw invalid('username');
  }
  return value;
}

function isoDateValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringValue(metadata, key);
  if (
    value !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
      !Number.isFinite(Date.parse(value)))
  ) {
    throw invalid(key);
  }
  return value;
}

function versionValue(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.version;
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_RULE_VERSION
  ) {
    throw invalid('version');
  }
  return value;
}

// A comma-separated list of distinct editable field names, e.g. "description".
function fieldsValue(metadata: Record<string, unknown>): string | undefined {
  const value = stringValue(metadata, 'fields');
  if (value === undefined) {
    return undefined;
  }
  const fields = value.split(',');
  const editable: readonly string[] = EDITABLE_COMMUNITY_FIELDS;
  if (
    new Set(fields).size !== fields.length ||
    !fields.every((field) => editable.includes(field))
  ) {
    throw invalid('fields');
  }
  return value;
}

// No action allows a post or comment body, title or link: the log records
// decisions, not content.
export function buildCommunityModerationMetadata(
  entry: CommunityModerationEntry,
): CommunityModerationMetadata | null {
  const metadata = metadataObject(entry.metadata);
  const result: CommunityModerationMetadata = {};
  const keep = (key: string, value: string | number | undefined) => {
    if (value !== undefined) result[key] = value;
  };

  switch (entry.action) {
    case 'post_removed':
    case 'comment_removed':
      keep('reason', reasonValue(metadata));
      break;
    case 'member_banned':
      keep('username', usernameValue(metadata));
      keep('reason', reasonValue(metadata));
      keep('expires_at', isoDateValue(metadata, 'expires_at'));
      break;
    case 'member_removed':
      keep('username', usernameValue(metadata));
      keep('reason', reasonValue(metadata));
      break;
    case 'member_unbanned':
    case 'moderator_added':
    case 'moderator_removed':
      keep('username', usernameValue(metadata));
      break;
    case 'rules_published':
      keep('version', versionValue(metadata));
      break;
    case 'community_updated':
      keep('fields', fieldsValue(metadata));
      break;
    default:
      // Lock, unlock, restore, pin and unpin carry no metadata.
      break;
  }

  return Object.keys(result).length === 0 ? null : result;
}

// Metadata is returned as stored. That is safe only because record() builds
// it from the per-action allowlist; loosening that allowlist makes the
// moderation-log route the disclosure path.
export function toCommunityModerationActionItem(
  row: CommunityModerationActionRow,
): CommunityModerationActionItem {
  return {
    id: row.id,
    action: row.action,
    actor_username: row.actor_username,
    target_type: row.target_type,
    target_id: row.target_id,
    metadata:
      typeof row.metadata === 'string'
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : row.metadata,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toUtcSqlDate(value: string): string {
  const withUtcZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value}Z`;
  return new Date(withUtcZone).toISOString().slice(0, 19).replace('T', ' ');
}

@Injectable()
export class CommunityModerationLogService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  record(
    connection: PoolConnection,
    entry: CommunityModerationEntry,
  ): Promise<void>;
  record(entry: CommunityModerationEntry): Promise<void>;
  async record(
    connectionOrEntry: PoolConnection | CommunityModerationEntry,
    maybeEntry?: CommunityModerationEntry,
  ): Promise<void> {
    if (maybeEntry !== undefined) {
      if (isEntry(connectionOrEntry)) {
        throw new TypeError('Expected a database connection');
      }
      await this.insert(connectionOrEntry, maybeEntry);
      return;
    }

    if (!isEntry(connectionOrEntry)) {
      throw new TypeError('Expected a community moderation entry');
    }
    const connection = await this.pool.getConnection();
    try {
      await this.insert(connection, connectionOrEntry);
    } finally {
      connection.release();
    }
  }

  // Only the community creator and its moderators may read the log. Platform
  // administrators get no access here; /admin is a separate surface.
  async findAll(
    name: string,
    userId: string,
    query: ListCommunityModerationActionsDto,
  ): Promise<CommunityModerationActionList> {
    const [communities] = await this.pool.execute<CommunityAccessRow[]>(
      `SELECT c.id, ${canModerateCommunitySql('c.id')} AS can_moderate
       FROM communities c
       WHERE c.name = ? AND ${visibleCommunityColumnsSql('c')} LIMIT 1`,
      [userId, userId, name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (!isSqlTrue(community.can_moderate)) {
      throw new ForbiddenException(
        'Only the community creator and moderators can read the moderation log',
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const filters = ['community_id = ?'];
    const values: string[] = [community.id];

    if (query.actor_username) {
      filters.push('actor_username = ?');
      values.push(query.actor_username);
    }
    if (query.action) {
      filters.push('action = ?');
      values.push(query.action);
    }
    if (query.target_type) {
      filters.push('target_type = ?');
      values.push(query.target_type);
    }
    if (query.from) {
      filters.push(
        "created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      );
      values.push(toUtcSqlDate(query.from));
    }
    if (query.to) {
      filters.push("created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)");
      values.push(toUtcSqlDate(query.to));
    }
    const where = ` WHERE ${filters.join(' AND ')}`;
    // The id tiebreaker gives a total order: one transaction can write
    // several entries within the same second.
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';

    // Never joins users or the target: actor_username is the snapshot, and
    // the target may have been deleted.
    const [rows] = await this.pool.execute<CommunityModerationActionRow[]>(
      `SELECT id, action, actor_username, target_type, target_id, metadata,
         created_at
       FROM community_moderation_actions${where}
       ORDER BY created_at ${order}, id ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(
      `SELECT COUNT(*) AS total FROM community_moderation_actions${where}`,
      values,
    );

    return {
      items: rows.map(toCommunityModerationActionItem),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  private async insert(
    connection: PoolConnection,
    entry: CommunityModerationEntry,
  ): Promise<void> {
    const [actors] = await connection.execute<ActorRow[]>(
      'SELECT username FROM users WHERE id = ? LIMIT 1',
      [entry.actorId],
    );
    const actorUsername = actors[0]?.username;
    if (!actorUsername) {
      throw new Error('Community moderation actor could not be resolved');
    }

    const metadata = buildCommunityModerationMetadata(entry);
    await connection.execute(
      `INSERT INTO community_moderation_actions
         (id, community_id, actor_id, actor_username, action, target_type,
          target_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        entry.communityId,
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
