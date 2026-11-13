import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { inTransaction } from '../communities/community-access';
import { ACTIVE_ADMINS_SQL, type PlatformRole } from '../users/users.service';
import { AuditLogService } from './audit-log.service';

// users.role holds exactly one platform role per account (migration 001's
// ENUM); RequiresRole(...roles) lists the roles a route accepts, any of
// them, not roles an account holds together. So no migration: "assigning" a
// role sets it, "revoking" one returns the account to user. user is the
// baseline every account has and is neither assigned nor revoked.
export const ELEVATED_ROLES = ['moderator', 'admin'] as const;
export type ElevatedRole = (typeof ELEVATED_ROLES)[number];

export const isElevatedRole = (value: string): value is ElevatedRole =>
  (ELEVATED_ROLES as readonly string[]).includes(value);

export interface AdminUserRoles {
  user_id: string;
  // Null once the account is deleted.
  username: string | null;
  role: PlatformRole;
  // The elevated roles held: empty, or the one role.
  roles: ElevatedRole[];
}

interface TargetRow extends RowDataPacket {
  id: string;
  username: string;
  role: PlatformRole;
  deleted_at: Date | string | null;
}

export const ROLE_TARGET_SQL =
  'SELECT id, username, role, deleted_at FROM users WHERE id = ? LIMIT 1';
export const LOCK_ROLE_TARGET_SQL = `${ROLE_TARGET_SQL} FOR UPDATE`;
export const SET_ROLE_SQL = 'UPDATE users SET role = ? WHERE id = ?';
export const ACTIVE_RESTRICTION_SQL = `SELECT id FROM user_restrictions WHERE user_id = ? AND ${ACTIVE_USER_RESTRICTION_PREDICATE} LIMIT 1`;

function toRoles(row: TargetRow): AdminUserRoles {
  return {
    user_id: row.id,
    username: row.deleted_at === null ? row.username : null,
    role: row.role,
    roles: isElevatedRole(row.role) ? [row.role] : [],
  };
}

// Guarded by AdminGuard with RequiresRole('admin'). Against privilege
// escalation: only administrators reach it; nobody changes their own role;
// the caller's own administrator role is re-read under lock, so an
// administrator demoted a moment ago cannot still promote anyone; a
// restricted or deleted account cannot be given a role; the last
// administrator cannot be removed. Every change writes a user_role_changed
// audit entry with from_role, to_role and the reason, in its transaction.
@Injectable()
export class AdminRolesService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLog: AuditLogService,
  ) {}

  async find(userId: string): Promise<AdminUserRoles> {
    const [rows] = await this.pool.execute<TargetRow[]>(ROLE_TARGET_SQL, [
      userId,
    ]);
    if (!rows[0]) {
      throw new NotFoundException('User not found');
    }
    return toRoles(rows[0]);
  }

  // Sets the role, replacing the other elevated role if the account holds
  // it (moderator to admin, or admin to moderator).
  async assign(
    userId: string,
    role: ElevatedRole,
    reason: string,
    actorId: string,
  ): Promise<AdminUserRoles> {
    return this.change(userId, actorId, reason, (target) => {
      if (target.role === role) {
        throw new ConflictException(`The account already holds ${role}`);
      }
      return role;
    });
  }

  async revoke(
    userId: string,
    role: string,
    reason: string,
    actorId: string,
  ): Promise<AdminUserRoles> {
    if (!isElevatedRole(role)) {
      throw new BadRequestException(
        `role must be one of: ${ELEVATED_ROLES.join(', ')}`,
      );
    }
    return this.change(userId, actorId, reason, (target) => {
      if (target.role !== role) {
        throw new NotFoundException(`The account does not hold ${role}`);
      }
      return 'user';
    });
  }

  private async change(
    userId: string,
    actorId: string,
    reason: string,
    decide: (target: TargetRow) => PlatformRole,
  ): Promise<AdminUserRoles> {
    // Before any lock: no administrator grants or revokes their own role, so
    // none can demote themselves out of the last administrator seat either.
    if (userId === actorId) {
      throw new ForbiddenException(
        'Administrators cannot change their own role',
      );
    }
    return inTransaction(this.pool, async (connection) => {
      // Locks every administrator first, in id order, then the target: the
      // same order for every change, so concurrent changes serialise.
      const [admins] =
        await connection.execute<(RowDataPacket & { id: string })[]>(
          ACTIVE_ADMINS_SQL,
        );
      if (!admins.some((admin) => admin.id === actorId)) {
        throw new ForbiddenException();
      }
      const target = await this.lockTarget(connection, userId);
      const to = decide(target);
      const from = target.role;
      if (to === 'admin') {
        await this.assertUnrestricted(connection, userId);
      }
      if (from === 'admin' && admins.length <= 1) {
        throw new ConflictException(
          'The last platform administrator cannot be removed',
        );
      }
      await connection.execute(SET_ROLE_SQL, [to, userId]);
      await this.auditLog.record(connection, {
        actorId,
        action: 'user_role_changed',
        targetType: 'user',
        targetId: userId,
        metadata: { from_role: from, to_role: to, reason },
      });
      return toRoles({ ...target, role: to });
    });
  }

  private async lockTarget(
    connection: PoolConnection,
    userId: string,
  ): Promise<TargetRow> {
    const [rows] = await connection.execute<TargetRow[]>(LOCK_ROLE_TARGET_SQL, [
      userId,
    ]);
    const target = rows[0];
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.deleted_at !== null) {
      throw new ConflictException('A deleted account cannot hold a role');
    }
    return target;
  }

  // Administrators cannot be restricted (AdminRestrictionsService), so a
  // restricted account must not become one and escape its restriction's
  // review: lift the restriction first.
  private async assertUnrestricted(
    connection: PoolConnection,
    userId: string,
  ): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      ACTIVE_RESTRICTION_SQL,
      [userId],
    );
    if (rows.length > 0) {
      throw new ConflictException(
        'A suspended or banned account cannot become an administrator',
      );
    }
  }
}
