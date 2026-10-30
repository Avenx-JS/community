import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { AuthService, MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { NotificationsService } from '../notifications/notifications.service';
import type { PlatformRole } from '../users/users.service';
import { AuditLogService } from './audit-log.service';
import {
  CreateRestrictionDto,
  RestrictionType,
} from './dto/create-restriction.dto';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { ListRestrictionsDto } from './dto/list-restrictions.dto';

interface TargetUserRow extends RowDataPacket {
  id: string;
  role: PlatformRole;
}

interface RestrictionStateRow extends RowDataPacket {
  id: string;
  user_id: string;
  lifted_at: Date | string | null;
}

export interface RestrictionRecord extends RowDataPacket {
  id: string;
  type: RestrictionType;
  reason: string;
  created_by_username: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  lifted_at: Date | string | null;
  lifted_by_username: string | null;
  lift_reason: string | null;
  report_id: string | null;
  active: number | string | boolean;
}

export interface AdminRestriction {
  id: string;
  type: RestrictionType;
  reason: string;
  created_by_username: string | null;
  created_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by_username: string | null;
  lift_reason: string | null;
  report_id: string | null;
  active: boolean;
}

export interface AdminRestrictionList {
  items: AdminRestriction[];
  page: number;
  limit: number;
  total: number;
}

// The predicate's columns are unqualified; they exist only on
// user_restrictions, so they stay unambiguous next to the users joins.
const RESTRICTION_SELECT = `SELECT r.id, r.type, r.reason,
     creator.username AS created_by_username, r.created_at, r.expires_at,
     r.lifted_at, lifter.username AS lifted_by_username, r.lift_reason,
     r.report_id, (${ACTIVE_USER_RESTRICTION_PREDICATE}) AS active
   FROM user_restrictions r
   LEFT JOIN users creator ON creator.id = r.created_by
   LEFT JOIN users lifter ON lifter.id = r.lifted_by`;

function toIsoString(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function toAdminRestrictionDto(
  row: RestrictionRecord,
): AdminRestriction {
  return {
    id: row.id,
    type: row.type,
    reason: row.reason,
    created_by_username: row.created_by_username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: toIsoString(row.expires_at),
    lifted_at: toIsoString(row.lifted_at),
    lifted_by_username: row.lifted_by_username ?? null,
    lift_reason: row.lift_reason,
    report_id: row.report_id,
    active: row.active === true || Number(row.active) === 1,
  };
}

@Injectable()
export class AdminRestrictionsService {
  private readonly logger = new Logger(AdminRestrictionsService.name);

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLogService: AuditLogService,
    private readonly authService: AuthService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async apply(
    userId: string,
    input: CreateRestrictionDto,
    actorId: string,
  ): Promise<AdminRestriction> {
    if (userId === actorId) {
      throw new ForbiddenException(
        'Administrators cannot restrict their own account',
      );
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    let restriction: AdminRestriction;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // Locking the target account row serialises concurrent applies for the
      // same user. The restriction re-check below matches no rows in the
      // common case, and gap locks alone would let two inserts deadlock
      // instead of producing a clean 409.
      const [users] = await connection.execute<TargetUserRow[]>(
        'SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
        [userId],
      );
      const user = users[0];
      if (!user) {
        throw new NotFoundException('User not found');
      }
      this.assertRestrictableRole(user.role);

      if (input.report_id !== undefined) {
        const [reports] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM user_reports WHERE id = ? LIMIT 1',
          [input.report_id],
        );
        if (reports.length === 0) {
          throw new NotFoundException('Report not found');
        }
      }

      const [active] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM user_restrictions
         WHERE user_id = ? AND ${ACTIVE_USER_RESTRICTION_PREDICATE}
         LIMIT 1 FOR UPDATE`,
        [userId],
      );
      if (active.length > 0) {
        throw new ConflictException('User already has an active restriction');
      }

      // The deadline comes from the database clock, like every other
      // timestamp; clients only supply a bounded integer duration.
      const id = randomUUID();
      const isSuspension = input.type === 'suspension';
      const durationValues: number[] =
        isSuspension && input.duration_hours !== undefined
          ? [input.duration_hours]
          : [];
      await connection.execute<ResultSetHeader>(
        `INSERT INTO user_restrictions
           (id, user_id, type, reason, created_by, expires_at, report_id)
         VALUES (?, ?, ?, ?, ?, ${
           isSuspension ? 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR)' : 'NULL'
         }, ?)`,
        [
          id,
          userId,
          input.type,
          input.reason,
          actorId,
          ...durationValues,
          input.report_id ?? null,
        ],
      );

      restriction = await this.loadRestriction(connection, userId, id);
      const reportId = input.report_id ?? null;
      await this.auditLogService.record(
        connection,
        isSuspension
          ? {
              actorId,
              action: 'user_suspended',
              targetType: 'user',
              targetId: userId,
              metadata: {
                restriction_id: id,
                expires_at: restriction.expires_at ?? undefined,
                report_id: reportId,
              },
            }
          : {
              actorId,
              action: 'user_banned',
              targetType: 'user',
              targetId: userId,
              metadata: { restriction_id: id, report_id: reportId },
            },
      );
      // Exactly what AuthGuard's 403 already tells this user: the type and,
      // for a suspension, the expiry. Never the reason, the administrator or
      // the linked report. Unlike logoutAll below, this is inside the
      // transaction: a notification has no backstop if it is lost.
      await this.notificationsService.record(connection, {
        recipientId: userId,
        type: 'restriction_applied',
        actorId: null,
        subjectType: 'restriction',
        subjectId: id,
        communityId: null,
        metadata:
          restriction.expires_at === null
            ? { restriction_type: restriction.type }
            : {
                restriction_type: restriction.type,
                expires_at: restriction.expires_at,
              },
      });
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

    // Deliberately after the commit and allowed to fail. Session revocation
    // only shortens how long existing tokens keep working; the restriction
    // row is what denies access, because AuthGuard and refresh check it on
    // every request. Moving this into the transaction would make a revocation
    // failure undo the restriction itself. If it fails, the next request with
    // an old token is still refused by the guard.
    try {
      await this.authService.logoutAll(userId);
    } catch {
      this.logger.warn(
        `Session revocation failed after restriction ${restriction.id}`,
      );
    }

    return restriction;
  }

  async lift(
    userId: string,
    restrictionId: string,
    input: LiftRestrictionDto,
    actorId: string,
  ): Promise<AdminRestriction> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // An expired suspension may still be lifted: it changes nothing for
      // enforcement but records that an administrator closed the case.
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE user_restrictions
         SET lifted_at = UTC_TIMESTAMP(), lifted_by = ?, lift_reason = ?
         WHERE id = ? AND user_id = ? AND lifted_at IS NULL`,
        [actorId, input.lift_reason, restrictionId, userId],
      );

      if (result.affectedRows !== 1) {
        const [rows] = await connection.execute<RestrictionStateRow[]>(
          'SELECT id, user_id, lifted_at FROM user_restrictions WHERE id = ? LIMIT 1',
          [restrictionId],
        );
        const current = rows[0];
        if (!current || current.user_id !== userId) {
          throw new NotFoundException('Restriction not found');
        }
        throw new ConflictException('Restriction has already been lifted');
      }

      const restriction = await this.loadRestriction(
        connection,
        userId,
        restrictionId,
      );
      await this.auditLogService.record(connection, {
        actorId,
        action: 'restriction_lifted',
        targetType: 'restriction',
        targetId: restrictionId,
        metadata: {
          restriction_id: restrictionId,
          restriction_type: restriction.type,
        },
      });
      // The type only; lift_reason and the lifting administrator are
      // admin-only.
      await this.notificationsService.record(connection, {
        recipientId: userId,
        type: 'restriction_lifted',
        actorId: null,
        subjectType: 'restriction',
        subjectId: restrictionId,
        communityId: null,
        metadata: { restriction_type: restriction.type },
      });
      await connection.commit();
      transactionStarted = false;
      return restriction;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async findAll(
    userId: string,
    query: ListRestrictionsDto,
  ): Promise<AdminRestrictionList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const [users] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    if (users.length === 0) {
      throw new NotFoundException('User not found');
    }

    const [rows] = await this.pool.execute<RestrictionRecord[]>(
      `${RESTRICTION_SELECT}
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >('SELECT COUNT(*) AS total FROM user_restrictions WHERE user_id = ?', [
      userId,
    ]);

    return {
      items: rows.map(toAdminRestrictionDto),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  // The single place deciding which roles may be restricted. Restricting
  // administrators stays refused until a documented policy exists.
  private assertRestrictableRole(role: PlatformRole): void {
    if (role === 'admin') {
      throw new ForbiddenException(
        'Administrator accounts cannot be restricted',
      );
    }
  }

  private async loadRestriction(
    connection: PoolConnection,
    userId: string,
    restrictionId: string,
  ): Promise<AdminRestriction> {
    const [rows] = await connection.execute<RestrictionRecord[]>(
      `${RESTRICTION_SELECT}
       WHERE r.id = ? AND r.user_id = ? LIMIT 1`,
      [restrictionId, userId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Restriction not found');
    }
    return toAdminRestrictionDto(row);
  }
}
