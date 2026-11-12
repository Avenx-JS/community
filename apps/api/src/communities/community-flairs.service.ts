import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import {
  communityMemberSql,
  readableCommunitySql,
} from '../common/community-visibility';
import { readPositiveInteger } from '../common/read-positive-integer';
import {
  assertCommunityReadable,
  inTransaction,
  readCommunityRole,
  type CommunityRole,
} from './community-access';
import type {
  CreateFlairDto,
  FlairKind,
  ListFlairsDto,
  UpdateFlairDto,
} from './dto/community-flairs.dto';

export interface FlairDto {
  id: string;
  kind: FlairKind;
  text: string;
  background_color: string | null;
  mod_only: boolean;
}

// What a post or a member carries: the flair without its settings.
export interface AssignedFlairDto {
  id: string;
  text: string;
  background_color: string | null;
}

export interface FlairListDto {
  items: FlairDto[];
}

// A member's user flair in one community; null when none.
export interface UserFlairDto {
  flair: AssignedFlairDto | null;
}

interface FlairRow extends RowDataPacket {
  id: string;
  community_id: string;
  kind: FlairKind;
  text: string;
  background_color: string | null;
  mod_only: number | boolean;
}

export const FLAIR_COLUMNS =
  'id, community_id, kind, text, background_color, mod_only';

// Values: community id.
export const FLAIRS_SQL = `SELECT ${FLAIR_COLUMNS} FROM community_flairs WHERE community_id = ?`;

// Values: flair id, community id.
export const FLAIR_SQL = `SELECT ${FLAIR_COLUMNS} FROM community_flairs WHERE id = ? AND community_id = ? LIMIT 1`;

export const COUNT_FLAIRS_SQL =
  'SELECT COUNT(*) AS total FROM community_flairs WHERE community_id = ?';

export const INSERT_FLAIR_SQL =
  'INSERT INTO community_flairs (id, community_id, kind, text, background_color, mod_only) VALUES (?, ?, ?, ?, ?, ?)';

// A post with what assigning its flair decides: the author, and whether the
// caller (the first two placeholders) moderates its community, in a community
// the caller may read (the third). Values: actor, actor, post id, actor.
export const FLAIR_POST_SQL = `SELECT posts.id, posts.author_id, posts.community_id, posts.removed_at, posts.flair_id,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM posts
       WHERE posts.id = ? AND ${readableCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE`;

export const SET_POST_FLAIR_SQL = 'UPDATE posts SET flair_id = ? WHERE id = ?';

// Values: the member, community id.
export const MEMBER_SQL = `SELECT u.id, ${communityMemberSql('communities', 'u.id')} AS member
       FROM users u
       JOIN communities ON communities.id = ?
       WHERE u.username = ? AND u.deleted_at IS NULL
       LIMIT 1`;

export const SET_USER_FLAIR_SQL = `INSERT INTO community_user_flairs (community_id, user_id, flair_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE flair_id = VALUES(flair_id)`;
// Values: community id, username.
export const USER_FLAIR_SQL = `SELECT f.id, f.text, f.background_color
       FROM community_user_flairs uf
       JOIN users u ON u.id = uf.user_id
       JOIN community_flairs f ON f.id = uf.flair_id
       WHERE uf.community_id = ? AND u.username = ? AND u.deleted_at IS NULL
       LIMIT 1`;

export const CLEAR_USER_FLAIR_SQL =
  'DELETE FROM community_user_flairs WHERE community_id = ? AND user_id = ?';

function toFlairDto(row: FlairRow): FlairDto {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    background_color: row.background_color,
    mod_only: Boolean(row.mod_only),
  };
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  );
}

// A community's flairs. Its creator and moderators manage them and may
// assign any; an author picks a post flair for their own post, and a member
// a user flair for themselves, from those not marked mod_only.
@Injectable()
export class CommunityFlairsService {
  private readonly flairsMax = readPositiveInteger('COMMUNITY_FLAIRS_MAX', 100);

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Readable like the community's posts: 403 for a non-member of a private
  // community.
  async list(
    name: string,
    viewerId: string | undefined,
    query: ListFlairsDto,
  ): Promise<FlairListDto> {
    const community = await readCommunityRole(this.pool, name, viewerId);
    await assertCommunityReadable(this.pool, community.id, viewerId);
    const [rows] = await this.pool.execute<FlairRow[]>(
      `${FLAIRS_SQL}${query.kind ? ' AND kind = ?' : ''} ORDER BY kind ASC, text ASC`,
      query.kind ? [community.id, query.kind] : [community.id],
    );
    return { items: rows.map(toFlairDto) };
  }

  // At most COMMUNITY_FLAIRS_MAX per community (409), text unique per kind
  // (409).
  async create(
    name: string,
    actorId: string,
    input: CreateFlairDto,
  ): Promise<FlairDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await this.moderated(connection, name, actorId);
      const [counts] = await connection.execute<
        (RowDataPacket & { total: number | string })[]
      >(COUNT_FLAIRS_SQL, [community.id]);
      if (Number(counts[0]?.total ?? 0) >= this.flairsMax) {
        throw new ConflictException(
          `A community has at most ${this.flairsMax} flairs`,
        );
      }
      const id = randomUUID();
      try {
        await connection.execute<ResultSetHeader>(INSERT_FLAIR_SQL, [
          id,
          community.id,
          input.kind,
          input.text,
          input.background_color ?? null,
          input.mod_only ?? false,
        ]);
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ConflictException('A flair with this text already exists');
        }
        throw error;
      }
      return this.read(connection, id, community.id);
    });
  }

  async update(
    name: string,
    flairId: string,
    actorId: string,
    input: UpdateFlairDto,
  ): Promise<FlairDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await this.moderated(connection, name, actorId);
      await this.read(connection, flairId, community.id);
      const assignments: string[] = [];
      const values: (string | boolean | null)[] = [];
      if (input.text !== undefined) {
        assignments.push('text = ?');
        values.push(input.text);
      }
      if (input.background_color !== undefined) {
        assignments.push('background_color = ?');
        values.push(input.background_color);
      }
      if (input.mod_only !== undefined) {
        assignments.push('mod_only = ?');
        values.push(input.mod_only);
      }
      try {
        await connection.execute<ResultSetHeader>(
          `UPDATE community_flairs SET ${assignments.join(', ')} WHERE id = ? AND community_id = ?`,
          [...values, flairId, community.id],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ConflictException('A flair with this text already exists');
        }
        throw error;
      }
      return this.read(connection, flairId, community.id);
    });
  }

  // Posts keep their flair column, cleared by the foreign key (SET NULL);
  // members lose it (CASCADE).
  async remove(name: string, flairId: string, actorId: string) {
    await inTransaction(this.pool, async (connection) => {
      const community = await this.moderated(connection, name, actorId);
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM community_flairs WHERE id = ? AND community_id = ?',
        [flairId, community.id],
      );
      if (result.affectedRows === 0) {
        throw new NotFoundException('Flair not found');
      }
    });
  }

  // PUT /posts/:id/flair. The author picks a post flair not marked
  // mod_only, for a post that is not removed; a moderator sets any post flair
  // of the community. 404 for a post the caller cannot read.
  async setPostFlair(
    postId: string,
    flairId: string,
    actorId: string,
  ): Promise<AssignedFlairDto> {
    return inTransaction(this.pool, async (connection) => {
      const post = await this.lockPost(connection, postId, actorId);
      const [flairs] = await connection.execute<FlairRow[]>(FLAIR_SQL, [
        flairId,
        post.community_id,
      ]);
      const flair = flairs[0];
      if (!flair || flair.kind !== 'post') {
        throw new BadRequestException(
          "flair_id must be one of the community's post flairs",
        );
      }
      if (!post.moderator && Boolean(flair.mod_only)) {
        throw new ForbiddenException('Only moderators can assign this flair');
      }
      await connection.execute<ResultSetHeader>(SET_POST_FLAIR_SQL, [
        flair.id,
        post.id,
      ]);
      return {
        id: flair.id,
        text: flair.text,
        background_color: flair.background_color,
      };
    });
  }

  // DELETE /posts/:id/flair. The author may clear only a flair they could
  // have chosen: a mod_only flair stays until a moderator clears it.
  async clearPostFlair(postId: string, actorId: string): Promise<void> {
    await inTransaction(this.pool, async (connection) => {
      const post = await this.lockPost(connection, postId, actorId);
      if (!post.moderator && post.flair_id) {
        const [flairs] = await connection.execute<FlairRow[]>(FLAIR_SQL, [
          post.flair_id,
          post.community_id,
        ]);
        if (flairs[0] && Boolean(flairs[0].mod_only)) {
          throw new ForbiddenException('Only moderators can remove this flair');
        }
      }
      await connection.execute<ResultSetHeader>(SET_POST_FLAIR_SQL, [
        null,
        post.id,
      ]);
    });
  }

  // PUT /communities/:name/members/:username/flair. A member sets their own
  // from the user flairs not marked mod_only; a moderator sets any member's,
  // any user flair. null clears it.
  async setUserFlair(
    name: string,
    username: string,
    flairId: string | null,
    actorId: string,
  ): Promise<UserFlairDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await readCommunityRole(connection, name, actorId);
      const [members] = await connection.execute<
        (RowDataPacket & { id: string; member: number | string | boolean })[]
      >(MEMBER_SQL, [community.id, username]);
      const member = members[0];
      if (!member) {
        throw new NotFoundException('User not found');
      }
      const self = member.id === actorId;
      if (!self && !community.can_moderate) {
        throw new ForbiddenException(
          "Only moderators can set another member's flair",
        );
      }
      if (!isSqlTrue(member.member)) {
        throw new ConflictException('This user is not a member');
      }
      if (flairId === null) {
        await connection.execute<ResultSetHeader>(CLEAR_USER_FLAIR_SQL, [
          community.id,
          member.id,
        ]);
        return { flair: null };
      }
      const [flairs] = await connection.execute<FlairRow[]>(FLAIR_SQL, [
        flairId,
        community.id,
      ]);
      const flair = flairs[0];
      if (!flair || flair.kind !== 'user') {
        throw new BadRequestException(
          "flair_id must be one of the community's user flairs",
        );
      }
      if (!community.can_moderate && Boolean(flair.mod_only)) {
        throw new ForbiddenException('Only moderators can assign this flair');
      }
      await connection.execute<ResultSetHeader>(SET_USER_FLAIR_SQL, [
        community.id,
        member.id,
        flair.id,
      ]);
      return {
        flair: {
          id: flair.id,
          text: flair.text,
          background_color: flair.background_color,
        },
      };
    });
  }

  // GET /communities/:name/members/:username/flair: readable like the
  // community; null when the member has none (or is no member).
  async getUserFlair(
    name: string,
    username: string,
    viewerId: string | undefined,
  ): Promise<UserFlairDto> {
    const community = await readCommunityRole(this.pool, name, viewerId);
    await assertCommunityReadable(this.pool, community.id, viewerId);
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        id: string;
        text: string;
        background_color: string | null;
      })[]
    >(USER_FLAIR_SQL, [community.id, username]);
    const row = rows[0];
    return {
      flair: row
        ? { id: row.id, text: row.text, background_color: row.background_color }
        : null,
    };
  }

  private async moderated(
    connection: PoolConnection,
    name: string,
    actorId: string,
  ): Promise<CommunityRole> {
    const community = await readCommunityRole(connection, name, actorId, true);
    if (!community.can_moderate) {
      throw new ForbiddenException(
        'Only the community creator and moderators can manage flairs',
      );
    }
    return community;
  }

  private async read(
    connection: PoolConnection,
    flairId: string,
    communityId: string,
  ): Promise<FlairDto> {
    const [rows] = await connection.execute<FlairRow[]>(FLAIR_SQL, [
      flairId,
      communityId,
    ]);
    if (!rows[0]) {
      throw new NotFoundException('Flair not found');
    }
    return toFlairDto(rows[0]);
  }

  private async lockPost(
    connection: PoolConnection,
    postId: string,
    actorId: string,
  ): Promise<{
    id: string;
    community_id: string;
    flair_id: string | null;
    moderator: boolean;
  }> {
    const [posts] = await connection.execute<
      (RowDataPacket & {
        id: string;
        author_id: string;
        community_id: string;
        flair_id: string | null;
        removed_at: Date | string | null;
        can_moderate: number | string | boolean;
      })[]
    >(FLAIR_POST_SQL, [actorId, actorId, postId, actorId]);
    const post = posts[0];
    const moderator = post ? isSqlTrue(post.can_moderate) : false;
    if (!post || (!moderator && post.removed_at !== null)) {
      throw new NotFoundException('Post not found');
    }
    if (!moderator && post.author_id !== actorId) {
      throw new ForbiddenException(
        "Only the author and moderators can set a post's flair",
      );
    }
    return {
      id: post.id,
      community_id: post.community_id,
      flair_id: post.flair_id,
      moderator,
    };
  }
}

// The post flairs of a page of posts, in one statement, and none for a page
// without flairs. A flair deleted meanwhile is simply absent.
export async function loadPostFlairs(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  flairIds: (string | null | undefined)[],
): Promise<Map<string, AssignedFlairDto>> {
  const ids = [...new Set(flairIds.filter(Boolean))] as string[];
  const flairs = new Map<string, AssignedFlairDto>();
  if (ids.length === 0) {
    return flairs;
  }
  const [rows] = await executor.execute<
    (RowDataPacket & {
      id: string;
      text: string;
      background_color: string | null;
    })[]
  >(
    `SELECT id, text, background_color FROM community_flairs WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  for (const row of rows) {
    flairs.set(row.id, {
      id: row.id,
      text: row.text,
      background_color: row.background_color,
    });
  }
  return flairs;
}
