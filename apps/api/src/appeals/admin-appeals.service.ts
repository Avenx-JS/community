import {
  ConflictException,
  ForbiddenException,
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
import {
  AdminCommunitiesService,
  type AdminCommunityDetail,
} from '../admin/admin-communities.service';
import {
  AdminContentService,
  type AdminCommentDetail,
  type AdminPostDetail,
} from '../admin/admin-content.service';
import {
  AdminRestrictionsService,
  RESTRICTION_SELECT,
  toAdminRestrictionDto,
  type AdminRestriction,
  type RestrictionRecord,
} from '../admin/admin-restrictions.service';
import { AuditLogService } from '../admin/audit-log.service';
import { MYSQL_POOL } from '../auth/auth.service';
import { inTransaction } from '../communities/community-access';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ADMIN_APPEAL_COLUMNS,
  ADMIN_APPEAL_FROM,
  APPEAL_IN_FORCE_SQL,
  lockTargetSql,
} from './appeal-targets';
import { isTrue } from './appeals.service';
import type {
  AppealStatus,
  AppealTargetType,
  DecideAppealDto,
  ListAdminAppealsDto,
} from './dto/appeals.dto';

export interface AdminAppealUser {
  id: string;
  // Null once the account is anonymised.
  username: string | null;
}

// The decision appealed, as it was when the appeal was filed.
export interface AdminAppealOriginalDecision {
  reason: string | null;
  // Null once the administrator's account is gone.
  actor_id: string | null;
  actor_username: string | null;
  decided_at: string;
}

// What the decision was about, for the queue.
export interface AdminAppealTarget {
  restriction_type: 'suspension' | 'ban' | null;
  restriction_expires_at: string | null;
  // The removed post, or the removed comment's post.
  post_id: string | null;
  post_title: string | null;
  // The first 200 characters of a removed comment.
  excerpt: string | null;
  community_id: string | null;
  community_name: string | null;
  // The appealed decision still stands: not reversed, and not replaced by a
  // later decision on the same target.
  in_force: boolean;
}

export interface AdminAppealListItem {
  id: string;
  status: AppealStatus;
  target_type: AppealTargetType;
  target_id: string;
  reason: string;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_username: string | null;
  user: AdminAppealUser;
  original_decision: AdminAppealOriginalDecision;
  target: AdminAppealTarget;
}

export interface AdminAppealList {
  items: AdminAppealListItem[];
  page: number;
  limit: number;
  total: number;
  filters: {
    status: AppealStatus | 'any';
    target_type: AppealTargetType | null;
  };
}

export interface AdminPriorAppeal {
  id: string;
  target_type: AppealTargetType;
  target_id: string;
  status: AppealStatus;
  created_at: string;
  decided_at: string | null;
}

// The detail adds the affected content or restriction as the administrator
// routes show it (one of the four, by target_type; null if it is gone) and
// the user's other appeals.
export interface AdminAppealDetail extends AdminAppealListItem {
  restriction: AdminRestriction | null;
  post: AdminPostDetail | null;
  comment: AdminCommentDetail | null;
  community: AdminCommunityDetail | null;
  // Newest first, at most PRIOR_APPEALS_LIMIT.
  prior_appeals: AdminPriorAppeal[];
  prior_appeal_count: number;
}

interface AdminAppealRow extends RowDataPacket {
  id: string;
  status: AppealStatus;
  target_type: AppealTargetType;
  target_id: string;
  reason: string;
  decision_note: string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  user_id: string;
  username: string | null;
  decided_by: string | null;
  decided_by_username: string | null;
  original_actor_id: string | null;
  original_actor_username: string | null;
  original_reason: string | null;
  original_decided_at: Date | string;
  restriction_type: 'suspension' | 'ban' | null;
  restriction_expires_at: Date | string | null;
  post_id: string | null;
  post_title: string | null;
  excerpt: string | null;
  community_id: string | null;
  community_name: string | null;
  in_force: number | string | boolean;
}

interface LockedAppealRow extends RowDataPacket {
  id: string;
  user_id: string;
  target_type: AppealTargetType;
  target_id: string;
  status: AppealStatus;
  original_actor_id: string | null;
  appellant_deleted: number | string | boolean;
}

export const PRIOR_APPEALS_LIMIT = 20;

// The audit log and the notification name the decision; the note is the
// administrator's message to the user.
export const DECIDE_APPEAL_SQL = `UPDATE appeals
       SET status = ?, decision_note = ?, decided_by = ?, decided_at = UTC_TIMESTAMP()
       WHERE id = ? AND status = 'open'`;

// Platform administrators other than the caller. Values: caller.
export const OTHER_ADMINS_SQL =
  "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND deleted_at IS NULL AND id <> ?";

const toIso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function toListItem(row: AdminAppealRow): AdminAppealListItem {
  return {
    id: row.id,
    status: row.status,
    target_type: row.target_type,
    target_id: row.target_id,
    reason: row.reason,
    decision_note: row.decision_note,
    created_at: new Date(row.created_at).toISOString(),
    decided_at: toIso(row.decided_at),
    decided_by_username: row.decided_by_username ?? null,
    user: { id: row.user_id, username: row.username ?? null },
    original_decision: {
      reason: row.original_reason,
      actor_id: row.original_actor_id,
      actor_username: row.original_actor_username ?? null,
      decided_at: new Date(row.original_decided_at).toISOString(),
    },
    target: {
      restriction_type: row.restriction_type ?? null,
      restriction_expires_at: toIso(row.restriction_expires_at ?? null),
      post_id: row.post_id ?? null,
      post_title: row.post_title ?? null,
      excerpt: row.excerpt ?? null,
      community_id: row.community_id ?? null,
      community_name: row.community_name ?? null,
      in_force: isTrue(row.in_force),
    },
  };
}

// 404 of the detail routes, mapped to null: the target may since be gone.
async function orNull<T>(lookup: Promise<T>): Promise<T | null> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof NotFoundException) {
      return null;
    }
    throw error;
  }
}

// The administrators' side of appeals (migration 048): the queue, the
// detail and the decision. Approving reverses the decision in the same
// transaction through the services the administrator routes use, so the
// reversal writes its own audit entry and notification as it would there.
@Injectable()
export class AdminAppealsService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly restrictions: AdminRestrictionsService,
    private readonly content: AdminContentService,
    private readonly communities: AdminCommunitiesService,
  ) {}

  // Open appeals oldest first, the queue's order; any other status newest
  // first. idx_appeals_queue serves both for one status.
  async findAll(query: ListAdminAppealsDto): Promise<AdminAppealList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const status = query.status ?? 'open';
    const where: string[] = [];
    const values: string[] = [];
    if (status !== 'any') {
      where.push('a.status = ?');
      values.push(status);
    }
    if (query.target_type) {
      where.push('a.target_type = ?');
      values.push(query.target_type);
    }
    const clause = where.length ? `\n       WHERE ${where.join(' AND ')}` : '';
    const direction = status === 'open' ? 'ASC' : 'DESC';
    const [rows] = await this.pool.execute<AdminAppealRow[]>(
      `SELECT ${ADMIN_APPEAL_COLUMNS}
       ${ADMIN_APPEAL_FROM}${clause}
       ORDER BY a.created_at ${direction}, a.id ${direction}
       LIMIT ? OFFSET ?`,
      [...values, limit, (page - 1) * limit],
    );
    const [count] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM appeals a${clause}`, values);
    return {
      items: rows.map(toListItem),
      page,
      limit,
      total: Number(count[0]?.total ?? 0),
      filters: { status, target_type: query.target_type ?? null },
    };
  }

  async findOne(id: string): Promise<AdminAppealDetail> {
    const [rows] = await this.pool.execute<AdminAppealRow[]>(
      `SELECT ${ADMIN_APPEAL_COLUMNS}
       ${ADMIN_APPEAL_FROM}
       WHERE a.id = ? LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Appeal not found');
    }
    const item = toListItem(row);
    const [prior] = await this.pool.execute<
      (RowDataPacket & AdminPriorAppeal)[]
    >(
      `SELECT id, target_type, target_id, status, created_at, decided_at
       FROM appeals WHERE user_id = ? AND id <> ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [row.user_id, id, PRIOR_APPEALS_LIMIT],
    );
    const [priorCount] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >('SELECT COUNT(*) AS total FROM appeals WHERE user_id = ? AND id <> ?', [
      row.user_id,
      id,
    ]);

    return {
      ...item,
      restriction:
        row.target_type === 'restriction'
          ? await this.findRestriction(row.target_id)
          : null,
      post:
        row.target_type === 'post_removal'
          ? await orNull(this.content.findPost(row.target_id))
          : null,
      comment:
        row.target_type === 'comment_removal'
          ? await orNull(this.content.findComment(row.target_id))
          : null,
      community:
        row.target_type === 'community_suspension'
          ? await orNull(this.communities.findOne(row.target_id))
          : null,
      prior_appeals: prior.map((appeal) => ({
        id: appeal.id,
        target_type: appeal.target_type,
        target_id: appeal.target_id,
        status: appeal.status,
        created_at: new Date(appeal.created_at).toISOString(),
        decided_at: toIso(appeal.decided_at),
      })),
      prior_appeal_count: Number(priorCount[0]?.total ?? 0),
    };
  }

  // Only an open appeal (409 otherwise). An administrator who made the
  // original decision, or who is the appellant, may not decide it while
  // another administrator exists (403): enforced, not a warning, since the
  // point of an appeal is a second pair of eyes. A sole administrator still
  // can, or the appeal could never be decided.
  async decide(
    id: string,
    input: DecideAppealDto,
    actorId: string,
  ): Promise<AdminAppealDetail> {
    // Only to learn the target, which never changes, so that it is locked
    // before the appeal, in the order POST /appeals takes. Read outside the
    // transaction: a read inside it would fix its snapshot before the locks,
    // and the in-force check below must see the target as locked.
    const [peek] = await this.pool.execute<
      (RowDataPacket & { target_type: AppealTargetType; target_id: string })[]
    >('SELECT target_type, target_id FROM appeals WHERE id = ? LIMIT 1', [id]);
    const known = peek[0];
    if (!known) {
      throw new NotFoundException('Appeal not found');
    }
    await inTransaction(this.pool, async (connection) => {
      await connection.execute(lockTargetSql(known.target_type), [
        known.target_id,
      ]);
      const appeal = await this.lockAppeal(connection, id);
      if (appeal.status !== 'open') {
        throw new ConflictException('This appeal has already been decided');
      }
      await this.assertImpartial(connection, appeal, actorId);

      // The lock makes this certain; the condition keeps it so under any
      // future path that skips the lock.
      const [result] = await connection.execute<ResultSetHeader>(
        DECIDE_APPEAL_SQL,
        [input.status, input.decision_note, actorId, id],
      );
      if (result.affectedRows !== 1) {
        throw new ConflictException('This appeal has already been decided');
      }

      let reversed: boolean | undefined;
      if (input.status === 'approved') {
        reversed = await this.reverse(
          connection,
          appeal,
          input.decision_note,
          actorId,
        );
      }

      await this.auditLog.record(connection, {
        actorId,
        action:
          input.status === 'approved' ? 'appeal_approved' : 'appeal_rejected',
        targetType: 'appeal',
        targetId: id,
        metadata: {
          appeal_target_type: appeal.target_type,
          appeal_target_id: appeal.target_id,
          decision_note: input.decision_note,
          ...(reversed === undefined
            ? {}
            : { reversed: reversed ? 'true' : 'false' }),
        },
      });
      // A deleted account has no inbox to tell.
      if (!isTrue(appeal.appellant_deleted)) {
        await this.notifications.record(connection, {
          recipientId: appeal.user_id,
          type: 'appeal_decided',
          actorId: null,
          subjectType: 'appeal',
          subjectId: id,
          communityId: null,
          metadata: {
            status: input.status,
            appeal_target_type: appeal.target_type,
            decision_note: input.decision_note,
          },
        });
      }
    });
    return this.findOne(id);
  }

  private async lockAppeal(
    connection: PoolConnection,
    id: string,
  ): Promise<LockedAppealRow> {
    const [rows] = await connection.execute<LockedAppealRow[]>(
      `SELECT a.id, a.user_id, a.target_type, a.target_id, a.status,
              a.original_actor_id, u.deleted_at IS NOT NULL AS appellant_deleted
       FROM appeals a INNER JOIN users u ON u.id = a.user_id
       WHERE a.id = ? LIMIT 1 FOR UPDATE OF a`,
      [id],
    );
    if (!rows[0]) {
      throw new NotFoundException('Appeal not found');
    }
    return rows[0];
  }

  private async assertImpartial(
    connection: PoolConnection,
    appeal: LockedAppealRow,
    actorId: string,
  ): Promise<void> {
    if (appeal.original_actor_id !== actorId && appeal.user_id !== actorId) {
      return;
    }
    const [others] = await connection.execute<
      (RowDataPacket & { total: number | string })[]
    >(OTHER_ADMINS_SQL, [actorId]);
    if (Number(others[0]?.total ?? 0) > 0) {
      throw new ForbiddenException(
        appeal.user_id === actorId
          ? 'Another administrator must decide your own appeal'
          : 'Another administrator must decide an appeal of your own decision',
      );
    }
  }

  // Reverses the appealed decision if it still stands; true if it did. A
  // decision reversed meanwhile, or replaced by a later one (whose appeal is
  // a separate one), is left alone and the approval still succeeds. The
  // target row is locked by decide.
  private async reverse(
    connection: PoolConnection,
    appeal: LockedAppealRow,
    note: string,
    actorId: string,
  ): Promise<boolean> {
    const [rows] = await connection.execute<
      (RowDataPacket & { in_force: number | string | boolean })[]
    >(
      `SELECT ${APPEAL_IN_FORCE_SQL} AS in_force
       ${ADMIN_APPEAL_FROM}
       WHERE a.id = ? LIMIT 1`,
      [appeal.id],
    );
    if (!isTrue(rows[0]?.in_force)) {
      return false;
    }
    switch (appeal.target_type) {
      case 'restriction':
        await this.restrictions.liftWithin(
          connection,
          appeal.user_id,
          appeal.target_id,
          note,
          actorId,
        );
        break;
      case 'post_removal':
        await this.content.restorePostWithin(
          connection,
          appeal.target_id,
          note,
          actorId,
        );
        break;
      case 'comment_removal':
        // 409 while the comment's post is removed, as on the admin route.
        await this.content.restoreCommentWithin(
          connection,
          appeal.target_id,
          note,
          actorId,
        );
        break;
      case 'community_suspension':
        await this.communities.restoreWithin(
          connection,
          appeal.target_id,
          note,
          actorId,
        );
        break;
    }
    return true;
  }

  private async findRestriction(id: string): Promise<AdminRestriction | null> {
    const [rows] = await this.pool.execute<RestrictionRecord[]>(
      `${RESTRICTION_SELECT}
       WHERE r.id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? toAdminRestrictionDto(rows[0]) : null;
  }
}
