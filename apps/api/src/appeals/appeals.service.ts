import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { inTransaction } from '../communities/community-access';
import { readPositiveInteger } from '../common/read-positive-integer';
import {
  existingAppealSql,
  insertAppealSql,
  lockAppealTargetSql,
} from './appeal-targets';
import type {
  AppealStatus,
  AppealTargetType,
  CreateAppealDto,
  ListOwnAppealsDto,
} from './dto/appeals.dto';

// The user's view of an appeal. Never the original decision's reason, nor
// who made or decided it: those stay with the administrators, as in every
// moderation notification. decision_note is the administrators' answer to
// the user and is shown.
export interface AppealDto {
  id: string;
  target_type: AppealTargetType;
  target_id: string;
  reason: string;
  status: AppealStatus;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface AppealListDto {
  items: AppealDto[];
  page: number;
  limit: number;
  total: number;
}

// The 409 body of an appeal against a community moderator's removal: such
// decisions are the community's, appealed to its moderators by modmail
// (POST /communities/:name/modmail), never to platform administrators.
export const COMMUNITY_MODERATION_REASON = 'community_moderation';
export interface CommunityModerationPayload {
  statusCode: 409;
  error: 'Conflict';
  message: string;
  reason: typeof COMMUNITY_MODERATION_REASON;
  community_name: string | null;
}

interface AppealRow extends RowDataPacket {
  id: string;
  target_type: AppealTargetType;
  target_id: string;
  reason: string;
  status: AppealStatus;
  decision_note: string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
}

interface TargetRow extends RowDataPacket {
  owner_id: string | null;
  in_force: number | string | boolean | null;
  by_admin: number | string | boolean | null;
  in_window: number | string | boolean | null;
  community_name: string | null;
}

// NULL (a column of a decision not in force) is false.
export const isTrue = (value: unknown) => value === true || Number(value) === 1;

const toIso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

export function toAppealDto(row: AppealRow): AppealDto {
  return {
    id: row.id,
    target_type: row.target_type,
    target_id: row.target_id,
    reason: row.reason,
    status: row.status,
    decision_note: row.decision_note,
    created_at: new Date(row.created_at).toISOString(),
    decided_at: toIso(row.decided_at),
  };
}

const APPEAL_COLUMNS =
  'id, target_type, target_id, reason, status, decision_note, created_at, decided_at';

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

// Appeals of platform administrators' decisions by the user they affect
// (migration 048). Available to restricted accounts: an appeal of a
// suspension or ban is the main use.
@Injectable()
export class AppealsService {
  readonly windowDays = readPositiveInteger('APPEAL_WINDOW_DAYS', 30);

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // 404 unless the caller is the affected user, so nobody learns of another
  // account's moderation record. 409 when the decision no longer stands, was
  // a community moderator's (with the modmail pointer), is older than the
  // window, or already has its appeal.
  create(userId: string, input: CreateAppealDto): Promise<AppealDto> {
    const type = input.target_type;
    return inTransaction(this.pool, async (connection) => {
      const [targets] = await connection.execute<TargetRow[]>(
        lockAppealTargetSql(type),
        [this.windowDays, input.target_id],
      );
      const target = targets[0];
      if (!target || target.owner_id !== userId) {
        throw new NotFoundException('Decision not found');
      }
      if (!isTrue(target.in_force)) {
        throw new ConflictException('This decision is no longer in force');
      }
      if (!isTrue(target.by_admin)) {
        const payload: CommunityModerationPayload = {
          statusCode: 409,
          error: 'Conflict',
          message:
            "This was a community moderator's decision; appeal it to the " +
            "community's moderators through modmail",
          reason: COMMUNITY_MODERATION_REASON,
          community_name: target.community_name,
        };
        throw new ConflictException(payload);
      }
      if (!isTrue(target.in_window)) {
        throw new ConflictException(
          `Decisions can be appealed for ${this.windowDays} days`,
        );
      }

      // Under the target's lock: a concurrent filing waits above, then sees
      // this one. The unique keys refuse what the check would miss.
      const [existing] = await connection.execute<RowDataPacket[]>(
        existingAppealSql(type),
        [type, input.target_id, input.target_id],
      );
      if (existing.length > 0) {
        throw new ConflictException('This decision has already been appealed');
      }

      const id = randomUUID();
      try {
        await connection.execute(insertAppealSql(type), [
          id,
          userId,
          type,
          input.reason,
          input.target_id,
        ]);
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ConflictException(
            'This decision has already been appealed',
          );
        }
        throw error;
      }

      const [rows] = await connection.execute<AppealRow[]>(
        `SELECT ${APPEAL_COLUMNS} FROM appeals WHERE id = ? LIMIT 1`,
        [id],
      );
      return toAppealDto(rows[0]);
    });
  }

  // Newest first, by idx_appeals_user.
  async listOwn(
    userId: string,
    query: ListOwnAppealsDto,
  ): Promise<AppealListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [rows] = await this.pool.execute<AppealRow[]>(
      `SELECT ${APPEAL_COLUMNS} FROM appeals WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [userId, limit, (page - 1) * limit],
    );
    const [count] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >('SELECT COUNT(*) AS total FROM appeals WHERE user_id = ?', [userId]);
    return {
      items: rows.map(toAppealDto),
      page,
      limit,
      total: Number(count[0]?.total ?? 0),
    };
  }
}
