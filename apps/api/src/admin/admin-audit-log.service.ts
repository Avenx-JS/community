import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import type { AdminAction, AdminActionTarget } from './audit-log.service';
import { ListAdminActionsDto } from './dto/list-admin-actions.dto';

export interface AdminActionRow extends RowDataPacket {
  id: string;
  actor_id: string | null;
  actor_username: string;
  action: AdminAction;
  target_type: AdminActionTarget;
  target_id: string;
  metadata: Record<string, unknown> | string | null;
  created_at: Date | string;
}

export interface AdminActionItem {
  id: string;
  actor_username: string;
  actor_id: string | null;
  action: AdminAction;
  target_type: AdminActionTarget;
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AdminActionList {
  items: AdminActionItem[];
  page: number;
  limit: number;
  total: number;
  filters: {
    actor_username: string | null;
    action: AdminAction | null;
    target_type: AdminActionTarget | null;
    target_id: string | null;
    from: string | null;
    to: string | null;
    sort: 'new' | 'oldest';
  };
}

function toUtcSqlDate(value: string): string {
  const withUtcZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value}Z`;
  return new Date(withUtcZone).toISOString().slice(0, 19).replace('T', ' ');
}

// Metadata is returned as stored. That is safe only because AuditLogService
// builds it from a per-action allowlist; loosening that allowlist makes this
// endpoint the disclosure path.
export function toAdminActionItem(row: AdminActionRow): AdminActionItem {
  return {
    id: row.id,
    actor_username: row.actor_username,
    actor_id: row.actor_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    metadata:
      typeof row.metadata === 'string'
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : row.metadata,
    created_at: new Date(row.created_at).toISOString(),
  };
}

@Injectable()
export class AdminAuditLogService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async findAll(query: ListAdminActionsDto): Promise<AdminActionList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const filters: string[] = [];
    const values: string[] = [];

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
    if (query.target_id) {
      filters.push('target_id = ?');
      values.push(query.target_id);
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
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    // The id tiebreaker gives a total order: one transaction can write
    // several entries within the same second.
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';

    const [rows] = await this.pool.execute<AdminActionRow[]>(
      `SELECT id, actor_id, actor_username, action, target_type, target_id,
         metadata, created_at
       FROM admin_actions${where}
       ORDER BY created_at ${order}, id ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM admin_actions${where}`, values);

    return {
      items: rows.map(toAdminActionItem),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      filters: {
        actor_username: query.actor_username ?? null,
        action: query.action ?? null,
        target_type: query.target_type ?? null,
        target_id: query.target_id ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        sort: query.sort ?? 'new',
      },
    };
  }
}
