import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  COMMUNITY_ACCESS_SQL,
  PRIVATE_COMMUNITY_MESSAGE,
  PRIVATE_COMMUNITY_REASON,
  communityMemberSql,
  visibleCommunityColumnsSql,
  type CommunityVisibility,
} from '../common/community-visibility';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';

export interface PrivateCommunityPayload {
  reason: typeof PRIVATE_COMMUNITY_REASON;
  message: string;
}

export interface CommunityAccess {
  visibility: CommunityVisibility;
  member: boolean;
}

type AccessRow = RowDataPacket & {
  visibility: CommunityVisibility;
  member: number | string | boolean;
};

// The viewer's standing in one visible community, or null when it is not
// there (deleted, suspended or unknown).
export async function readCommunityAccess(
  executor: Pool | PoolConnection,
  communityId: string,
  viewerId: string | undefined,
): Promise<CommunityAccess | null> {
  const [rows] = await executor.execute<AccessRow[]>(COMMUNITY_ACCESS_SQL, [
    viewerId ?? null,
    communityId,
  ]);
  const row = rows[0];
  return row
    ? { visibility: row.visibility, member: isSqlTrue(row.member) }
    : null;
}

export function privateCommunityError(): ForbiddenException {
  const payload: PrivateCommunityPayload = {
    reason: PRIVATE_COMMUNITY_REASON,
    message: PRIVATE_COMMUNITY_MESSAGE,
  };
  return new ForbiddenException(payload);
}

// For the routes of one community whose answer is that community's content
// or people (its posts, moderators, stats): 404 when it is not there, 403
// with reason private_community for a non-member of a private one. Its name,
// description and rules stay public, so that someone can ask to join.
export async function assertCommunityReadable(
  executor: Pool | PoolConnection,
  communityId: string,
  viewerId: string | undefined,
): Promise<CommunityAccess> {
  const access = await readCommunityAccess(executor, communityId, viewerId);
  if (!access) {
    throw new NotFoundException('Community not found');
  }
  if (access.visibility === 'private' && !access.member) {
    throw privateCommunityError();
  }
  return access;
}

// A community by name with the caller's standing in it, for the routes that
// manage a community's people (join requests, invitations, flairs). Values:
// the caller twice, then the name. 404 before any role is consulted.
export const COMMUNITY_ROLE_BY_NAME_SQL = `SELECT c.id, c.name, c.creator_id, c.visibility,
         ${canModerateCommunitySql('c.id')} AS can_moderate
       FROM communities c
       WHERE c.name = ? AND ${visibleCommunityColumnsSql('c')}
       LIMIT 1`;

export interface CommunityRole {
  id: string;
  name: string;
  creator_id: string;
  visibility: CommunityVisibility;
  can_moderate: boolean;
}

type CommunityRoleRow = RowDataPacket & {
  id: string;
  name: string;
  creator_id: string;
  visibility: CommunityVisibility;
  can_moderate: number | string | boolean;
};

export async function readCommunityRole(
  executor: Pool | PoolConnection,
  name: string,
  actorId: string | undefined,
  forUpdate = false,
): Promise<CommunityRole> {
  const [rows] = await executor.execute<CommunityRoleRow[]>(
    forUpdate
      ? `${COMMUNITY_ROLE_BY_NAME_SQL} FOR UPDATE`
      : COMMUNITY_ROLE_BY_NAME_SQL,
    [actorId ?? null, actorId ?? null, name],
  );
  const row = rows[0];
  if (!row) {
    throw new NotFoundException('Community not found');
  }
  return { ...row, can_moderate: isSqlTrue(row.can_moderate) };
}

// Runs work in one transaction on its own connection.
export async function inTransaction<T>(
  pool: Pool,
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const result = await work(connection);
    await connection.commit();
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

// The same check folded into a lookup that already reads the community, so
// it costs no statement of its own: add VIEWER_JOIN_SQL to its FROM (one
// placeholder, the viewer or null, before the WHERE's) and
// accessColumnsSql(alias) to its columns, then assertReadableRow(row).
export const VIEWER_JOIN_SQL =
  'CROSS JOIN (SELECT CAST(? AS CHAR(36)) AS id) viewer';

export function accessColumnsSql(alias: string): string {
  return `${alias}.visibility AS access_visibility, ${communityMemberSql(alias, 'viewer.id')} AS access_member`;
}

export interface AccessColumns {
  access_visibility: CommunityVisibility;
  access_member: number | string | boolean;
}

export function assertReadableRow(row: AccessColumns): void {
  if (row.access_visibility === 'private' && !isSqlTrue(row.access_member)) {
    throw privateCommunityError();
  }
}
