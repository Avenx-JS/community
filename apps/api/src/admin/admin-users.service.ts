import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { escapeLikeSearch } from '../common/like-search';
import { ListUsersDto } from './dto/list-users.dto';
import type { PlatformRole } from '../users/users.service';

interface AdminUserRow extends RowDataPacket {
  id: string;
  username: string;
  role: PlatformRole;
  created_at: Date | string;
  open_reports_against: number | string;
}

interface ActivityCountsRow extends RowDataPacket {
  posts_count: number | string;
  comments_count: number | string;
  votes_count: number | string;
  communities_created: number | string;
  subscriptions_count: number | string;
  moderated_communities_count: number | string;
}

interface ReportSummaryRow extends RowDataPacket {
  open: number | string;
  under_review: number | string;
  resolved: number | string;
  rejected: number | string;
  reports_filed_count: number | string;
}

export interface AdminUserListItem {
  id: string;
  username: string;
  role: PlatformRole;
  created_at: string;
  status: 'active';
  restriction_expires_at: null;
  open_reports_against: number;
}

export interface AdminUserList {
  items: AdminUserListItem[];
  page: number;
  limit: number;
  total: number;
  filters: {
    search: string | null;
    role: PlatformRole | null;
    from: string | null;
    to: string | null;
    sort: 'new' | 'oldest' | 'username';
  };
}

export interface AdminUserDetail extends AdminUserListItem {
  last_seen_at: null;
  posts_count: number;
  comments_count: number;
  votes_count: number;
  communities_created: number;
  subscriptions_count: number;
  moderated_communities_count: number;
  reports_against: {
    open: number;
    under_review: number;
    resolved: number;
    rejected: number;
  };
  reports_filed_count: number;
}

function toUtcSqlDate(value: string): string {
  const withUtcZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value}Z`;
  return new Date(withUtcZone).toISOString().slice(0, 19).replace('T', ' ');
}

function toListItem(user: AdminUserRow): AdminUserListItem {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    created_at: new Date(user.created_at).toISOString(),
    status: 'active',
    restriction_expires_at: null,
    open_reports_against: Number(user.open_reports_against),
  };
}

@Injectable()
export class AdminUsersService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async findAll(query: ListUsersDto): Promise<AdminUserList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const filters: string[] = [];
    const values: (string | number)[] = [];
    const search = query.search?.trim();

    if (search) {
      filters.push("LOWER(u.username) LIKE LOWER(?) ESCAPE '='");
      values.push(`%${escapeLikeSearch(search)}%`);
    }
    if (query.role) {
      filters.push('u.role = ?');
      values.push(query.role);
    }
    if (query.from) {
      filters.push(
        "u.created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      );
      values.push(toUtcSqlDate(query.from));
    }
    if (query.to) {
      filters.push(
        "u.created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      );
      values.push(toUtcSqlDate(query.to));
    }

    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const order =
      query.sort === 'oldest'
        ? 'u.created_at ASC, u.id ASC'
        : query.sort === 'username'
          ? 'u.username ASC, u.id ASC'
          : 'u.created_at DESC, u.id DESC';

    const [users] = await this.pool.execute<AdminUserRow[]>(
      `SELECT u.id, u.username, u.role, u.created_at,
         COALESCE(report_counts.open_reports_against, 0) AS open_reports_against
       FROM users u
       LEFT JOIN (
         SELECT reported_user_id,
           SUM(status IN ('open', 'under_review')) AS open_reports_against
         FROM user_reports
         GROUP BY reported_user_id
       ) report_counts ON report_counts.reported_user_id = u.id${where}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM users u${where}`, values);

    return {
      items: users.map(toListItem),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      filters: {
        search: query.search ?? null,
        role: query.role ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        sort: query.sort ?? 'new',
      },
    };
  }

  async findOne(id: string): Promise<AdminUserDetail> {
    const [users] = await this.pool.execute<AdminUserRow[]>(
      `SELECT u.id, u.username, u.role, u.created_at,
         COALESCE(report_counts.open_reports_against, 0) AS open_reports_against
       FROM users u
       LEFT JOIN (
         SELECT reported_user_id,
           SUM(status IN ('open', 'under_review')) AS open_reports_against
         FROM user_reports
         GROUP BY reported_user_id
       ) report_counts ON report_counts.reported_user_id = u.id
       WHERE u.id = ? LIMIT 1`,
      [id],
    );
    const user = users[0];
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [activityRows] = await this.pool.execute<ActivityCountsRow[]>(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE author_id = ?) AS posts_count,
         (SELECT COUNT(*) FROM comments WHERE author_id = ?) AS comments_count,
         (SELECT COUNT(*) FROM votes WHERE user_id = ?) AS votes_count,
         (SELECT COUNT(*) FROM communities WHERE creator_id = ?) AS communities_created,
         (SELECT COUNT(*) FROM community_subscriptions WHERE user_id = ?) AS subscriptions_count,
         (SELECT COUNT(*) FROM community_moderators WHERE user_id = ?) AS moderated_communities_count`,
      Array.from({ length: 6 }, () => id),
    );
    const [reportRows] = await this.pool.execute<ReportSummaryRow[]>(
      `SELECT
         COALESCE(SUM(status = 'open'), 0) AS open,
         COALESCE(SUM(status = 'under_review'), 0) AS under_review,
         COALESCE(SUM(status = 'resolved'), 0) AS resolved,
         COALESCE(SUM(status = 'rejected'), 0) AS rejected,
         (SELECT COUNT(*) FROM user_reports WHERE reporter_id = ?) AS reports_filed_count
       FROM user_reports
       WHERE reported_user_id = ?`,
      [id, id],
    );

    const activity = activityRows[0];
    const reports = reportRows[0];
    return {
      ...toListItem(user),
      last_seen_at: null,
      posts_count: Number(activity?.posts_count ?? 0),
      comments_count: Number(activity?.comments_count ?? 0),
      votes_count: Number(activity?.votes_count ?? 0),
      communities_created: Number(activity?.communities_created ?? 0),
      subscriptions_count: Number(activity?.subscriptions_count ?? 0),
      moderated_communities_count: Number(
        activity?.moderated_communities_count ?? 0,
      ),
      reports_against: {
        open: Number(reports?.open ?? 0),
        under_review: Number(reports?.under_review ?? 0),
        resolved: Number(reports?.resolved ?? 0),
        rejected: Number(reports?.rejected ?? 0),
      },
      reports_filed_count: Number(reports?.reports_filed_count ?? 0),
    };
  }
}
