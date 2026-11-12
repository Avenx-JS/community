import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { escapeLikeSearch } from '../common/like-search';
import { ADMIN_EDITABLE_COMMUNITY_FIELDS } from './dto/admin-communities.dto';
import { AuditLogService } from './audit-log.service';
import type {
  AdminCommunityState,
  AdminUpdateCommunityDto,
  ListAdminCommunitiesDto,
  RestoreCommunityDto,
  SuspendCommunityDto,
} from './dto/admin-communities.dto';

// The platform administrators' view of communities. Unlike the public
// listing it hides nothing: suspended and soft-deleted communities are the
// ones most likely to need attention. Addressed by id, as every /admin route
// is, with the name in every response for cross-reference. Read and correct
// and correct, suspend and restore. A suspended community is hidden from
// everyone else by COMMUNITY_VISIBLE_PREDICATE (common/community-visibility.ts),
// which every public read and write applies.

export interface AdminCommunityListItem {
  id: string;
  name: string;
  description: string | null;
  // Null once the creator's account is gone or anonymised.
  creator_username: string | null;
  created_at: string;
  suspended_at: string | null;
  deleted_at: string | null;
  // Rows in community_subscriptions.
  member_count: number;
  // Every post, removed ones included.
  post_count: number;
}

export interface AdminCommunityList {
  items: AdminCommunityListItem[];
  page: number;
  limit: number;
  total: number;
  filters: {
    search: string | null;
    creator_username: string | null;
    state: AdminCommunityState;
    sort: 'new' | 'oldest';
  };
}

export interface AdminCommunityDetail extends AdminCommunityListItem {
  suspended_by_username: string | null;
  suspension_reason: string | null;
  deleted_by_username: string | null;
  // Appointed moderators; the creator is not counted.
  moderator_count: number;
  // Every comment on the community's posts, removed ones included.
  comment_count: number;
  // The current published rules version; null if none was ever published.
  rule_version: number | null;
  // Community-targeted reports open or under review, not withdrawn: what the
  // report queue shows for this community.
  open_report_count: number;
}

interface CommunityRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  creator_username: string | null;
  created_at: Date | string;
  suspended_at: Date | string | null;
  deleted_at: Date | string | null;
}

interface CommunityDetailRow extends CommunityRow {
  suspended_by_username: string | null;
  suspension_reason: string | null;
  deleted_by_username: string | null;
  member_count: number | string;
  post_count: number | string;
  moderator_count: number | string;
  comment_count: number | string;
  rule_version: number | string | null;
  open_report_count: number | string;
}

interface GroupCountRow extends RowDataPacket {
  community_id: string;
  total: number | string;
}

// An anonymised account is null, never its deleted_<id> placeholder; a
// missing one (SET NULL, or the left join finding nothing) is null too.
const visibleUsername = (alias: string) =>
  `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.username END`;

// deleted wins over suspended, so the three states partition every row.
const STATE_SQL: Record<Exclude<AdminCommunityState, 'any'>, string> = {
  active: 'c.deleted_at IS NULL AND c.suspended_at IS NULL',
  suspended: 'c.suspended_at IS NOT NULL AND c.deleted_at IS NULL',
  deleted: 'c.deleted_at IS NOT NULL',
};

const DIRECTORY_FROM = `FROM communities c
       LEFT JOIN users creator ON creator.id = c.creator_id`;

const LIST_COLUMNS = `c.id, c.name, c.description,
         ${visibleUsername('creator')} AS creator_username,
         c.created_at, c.suspended_at, c.deleted_at`;

// One row, so correlated subqueries are fine here, as in GET /admin/users/:id.
export const ADMIN_COMMUNITY_DETAIL_SQL = `SELECT ${LIST_COLUMNS},
         ${visibleUsername('suspender')} AS suspended_by_username,
         c.suspension_reason,
         ${visibleUsername('deleter')} AS deleted_by_username,
         (SELECT COUNT(*) FROM community_subscriptions s WHERE s.community_id = c.id) AS member_count,
         (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) AS post_count,
         (SELECT COUNT(*) FROM community_moderators m WHERE m.community_id = c.id) AS moderator_count,
         (SELECT COUNT(*) FROM comments cm JOIN posts p ON p.id = cm.post_id
          WHERE p.community_id = c.id) AS comment_count,
         (SELECT MAX(d.version) FROM community_rule_documents d
          WHERE d.community_id = c.id) AS rule_version,
         (SELECT COUNT(*) FROM user_reports ur
          WHERE ur.target_type = 'community' AND ur.target_id = c.id
            AND ur.status IN ('open', 'under_review') AND ur.withdrawn_at IS NULL
         ) AS open_report_count
       ${DIRECTORY_FROM}
       LEFT JOIN users suspender ON suspender.id = c.suspended_by
       LEFT JOIN users deleter ON deleter.id = c.deleted_by
       WHERE c.id = ? LIMIT 1`;

const toIso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function toListItem(
  row: CommunityRow,
  counts: { members: number; posts: number },
): AdminCommunityListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    creator_username: row.creator_username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    suspended_at: toIso(row.suspended_at),
    deleted_at: toIso(row.deleted_at),
    member_count: counts.members,
    post_count: counts.posts,
  };
}

@Injectable()
export class AdminCommunitiesService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLogService: AuditLogService,
  ) {}

  async findAll(query: ListAdminCommunitiesDto): Promise<AdminCommunityList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const state = query.state ?? 'any';
    const filters: string[] = [];
    const values: string[] = [];

    const search = query.search?.trim();
    if (search) {
      const term = `%${escapeLikeSearch(search)}%`;
      filters.push(
        "(LOWER(c.name) LIKE LOWER(?) ESCAPE '=' OR LOWER(c.description) LIKE LOWER(?) ESCAPE '=')",
      );
      values.push(term, term);
    }
    if (query.creator_username) {
      filters.push('creator.username = ?');
      values.push(query.creator_username);
    }
    if (state !== 'any') {
      filters.push(STATE_SQL[state]);
    }
    const where = filters.length
      ? `\n       WHERE ${filters.join(' AND ')}`
      : '';
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';

    // idx_communities_created serves the order (migration 033).
    const [rows] = await this.pool.execute<CommunityRow[]>(
      `SELECT ${LIST_COLUMNS}
       ${DIRECTORY_FROM}${where}
       ORDER BY c.created_at ${direction}, c.id ${direction} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total ${DIRECTORY_FROM}${where}`, values);

    const ids = rows.map((row) => row.id);
    const [members, posts] = await Promise.all([
      this.countsByCommunity('community_subscriptions', ids),
      this.countsByCommunity('posts', ids),
    ]);

    return {
      items: rows.map((row) =>
        toListItem(row, {
          members: members.get(row.id) ?? 0,
          posts: posts.get(row.id) ?? 0,
        }),
      ),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      filters: {
        search: query.search ?? null,
        creator_username: query.creator_username ?? null,
        state,
        sort: query.sort ?? 'new',
      },
    };
  }

  // Suspended and soft-deleted communities are returned: this is the view an
  // administrator decides from.
  async findOne(
    id: string,
    executor: Pick<Pool | PoolConnection, 'execute'> = this.pool,
  ): Promise<AdminCommunityDetail> {
    const [rows] = await executor.execute<CommunityDetailRow[]>(
      ADMIN_COMMUNITY_DETAIL_SQL,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Community not found');
    }
    return {
      ...toListItem(row, {
        members: Number(row.member_count),
        posts: Number(row.post_count),
      }),
      suspended_by_username: row.suspended_by_username ?? null,
      suspension_reason: row.suspension_reason,
      deleted_by_username: row.deleted_by_username ?? null,
      moderator_count: Number(row.moderator_count),
      comment_count: Number(row.comment_count),
      rule_version: row.rule_version === null ? null : Number(row.rule_version),
      open_report_count: Number(row.open_report_count),
    };
  }

  // A deliberate override of the creator's control, for content a creator
  // will not or cannot fix: so it is narrow (the description only, never the
  // name or rules) and always audited. It works whatever the community's
  // state, since a hidden community's description may be why it is hidden.
  async update(
    id: string,
    changes: AdminUpdateCommunityDto,
    actorId: string,
  ): Promise<AdminCommunityDetail> {
    const assignments: string[] = [];
    const values: (string | null)[] = [];
    const fields: string[] = [];
    for (const field of ADMIN_EDITABLE_COMMUNITY_FIELDS) {
      const value = changes[field];
      if (value !== undefined) {
        assignments.push(`${field} = ?`);
        // Already trimmed: whitespace only is stored as NULL.
        values.push(value === '' ? null : value);
        fields.push(field);
      }
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [communities] = await connection.execute<
        (RowDataPacket & { id: string; name: string })[]
      >('SELECT id, name FROM communities WHERE id = ? LIMIT 1 FOR UPDATE', [
        id,
      ]);
      const community = communities[0];
      if (!community) {
        throw new NotFoundException('Community not found');
      }

      await connection.execute<ResultSetHeader>(
        `UPDATE communities SET ${assignments.join(', ')} WHERE id = ?`,
        [...values, id],
      );
      // That a change happened and to which fields, never the old or new text.
      await this.auditLogService.record(connection, {
        actorId,
        action: 'community_updated',
        targetType: 'community',
        targetId: id,
        metadata: { community_name: community.name, fields: fields.join(',') },
      });
      const detail = await this.findOne(id, connection);
      await connection.commit();
      transactionStarted = false;
      return detail;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // Takes a community offline for everyone but platform administrators,
  // indefinitely, until restored. Nothing is deleted and no membership is
  // removed: it is reversible. suspended_by comes only from the token.
  async suspend(
    id: string,
    input: SuspendCommunityDto,
    actorId: string,
  ): Promise<AdminCommunityDetail> {
    return this.inTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          id: string;
          name: string;
          suspended_at: Date | string | null;
          deleted_at: Date | string | null;
        })[]
      >(
        'SELECT id, name, suspended_at, deleted_at FROM communities WHERE id = ? LIMIT 1 FOR UPDATE',
        [id],
      );
      const community = rows[0];
      if (!community) {
        throw new NotFoundException('Community not found');
      }
      // Re-suspending would silently rewrite the record of the first decision.
      if (community.suspended_at !== null) {
        throw new ConflictException('Community is already suspended');
      }
      // Already hidden: suspending would add nothing but a double state.
      if (community.deleted_at !== null) {
        throw new ConflictException('A deleted community cannot be suspended');
      }

      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE communities
         SET suspended_at = UTC_TIMESTAMP(), suspended_by = ?, suspension_reason = ?
         WHERE id = ? AND suspended_at IS NULL AND deleted_at IS NULL`,
        [actorId, input.reason, id],
      );
      if (result.affectedRows !== 1) {
        throw new ConflictException('Community changed concurrently');
      }
      await this.auditLogService.record(connection, {
        actorId,
        action: 'community_suspended',
        targetType: 'community',
        targetId: id,
        metadata: { community_name: community.name, reason: input.reason },
      });
      return this.findOne(id, connection);
    });
  }

  // Clears the suspension and nothing else: content removed and members who
  // left while it was suspended stay as they are.
  async restore(
    id: string,
    input: RestoreCommunityDto,
    actorId: string,
  ): Promise<AdminCommunityDetail> {
    return this.inTransaction(async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE communities
         SET suspended_at = NULL, suspended_by = NULL, suspension_reason = NULL
         WHERE id = ? AND suspended_at IS NOT NULL`,
        [id],
      );
      const [rows] = await connection.execute<
        (RowDataPacket & { name: string })[]
      >('SELECT name FROM communities WHERE id = ? LIMIT 1', [id]);
      if (!rows[0]) {
        throw new NotFoundException('Community not found');
      }
      if (result.affectedRows !== 1) {
        throw new ConflictException('Community is not suspended');
      }
      await this.auditLogService.record(connection, {
        actorId,
        action: 'community_restored',
        targetType: 'community',
        targetId: id,
        metadata: {
          community_name: rows[0].name,
          restore_reason: input.restore_reason,
        },
      });
      return this.findOne(id, connection);
    });
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      await connection.commit();
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // One grouped query per aggregate, bounded to the page's ids: the round
  // trips stay constant however large the page, unlike a correlated subquery
  // per row. Both tables have an index leading on community_id.
  private async countsByCommunity(
    table: 'community_subscriptions' | 'posts',
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const [rows] = await this.pool.execute<GroupCountRow[]>(
      `SELECT community_id, COUNT(*) AS total FROM ${table}
       WHERE community_id IN (${ids.map(() => '?').join(', ')})
       GROUP BY community_id`,
      ids,
    );
    return new Map(rows.map((row) => [row.community_id, Number(row.total)]));
  }
}
