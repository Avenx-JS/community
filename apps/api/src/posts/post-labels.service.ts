import {
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
import { MYSQL_POOL } from '../auth/auth.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { readableCommunitySql } from '../common/community-visibility';
import { inTransaction } from '../communities/community-access';

export const POST_LABELS = ['nsfw', 'spoiler'] as const;
export type PostLabel = (typeof POST_LABELS)[number];
type SetBy = 'author' | 'moderator';

// The post with what a label change decides: its author, the labels and who
// set them, whether the caller moderates its community, in a community the
// caller may read. Locked for the change. Values: actor, actor, post, actor.
export const LABEL_POST_SQL = `SELECT posts.id, posts.author_id, posts.removed_at,
         posts.nsfw_set_by, posts.spoiler_set_by,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM posts
       WHERE posts.id = ? AND ${readableCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE`;

// One statement per label: the column is never interpolated from input.
export const SET_LABEL_SQL: Record<PostLabel, string> = {
  nsfw: 'UPDATE posts SET nsfw_set_by = ? WHERE id = ?',
  spoiler: 'UPDATE posts SET spoiler_set_by = ? WHERE id = ?',
};

interface LabelPostRow extends RowDataPacket {
  id: string;
  author_id: string;
  removed_at: Date | string | null;
  nsfw_set_by: SetBy | null;
  spoiler_set_by: SetBy | null;
  can_moderate: number | string | boolean;
}

// NSFW and spoiler labels on posts. The author and the community's creator
// and moderators set them; a label a moderator set only a moderator removes,
// so an author cannot undo a moderator's warning. Both routes are idempotent.
@Injectable()
export class PostLabelsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // A moderator's label is recorded as theirs, and stays theirs if the author
  // sets it again; an author's becomes a moderator's when one sets it.
  async set(postId: string, label: PostLabel, actorId: string): Promise<void> {
    await inTransaction(this.pool, async (connection) => {
      const post = await this.lock(connection, postId, actorId);
      const current = post[`${label}_set_by`];
      const next: SetBy =
        post.moderator || current === 'moderator' ? 'moderator' : 'author';
      if (current !== next) {
        await connection.execute<ResultSetHeader>(SET_LABEL_SQL[label], [
          next,
          postId,
        ]);
      }
    });
  }

  async clear(postId: string, label: PostLabel, actorId: string) {
    await inTransaction(this.pool, async (connection) => {
      const post = await this.lock(connection, postId, actorId);
      const current = post[`${label}_set_by`];
      if (current === null) {
        return;
      }
      if (current === 'moderator' && !post.moderator) {
        throw new ForbiddenException(
          'A moderator set this label; only moderators can remove it',
        );
      }
      await connection.execute<ResultSetHeader>(SET_LABEL_SQL[label], [
        null,
        postId,
      ]);
    });
  }

  // 404 for a post the caller cannot read, and for a removed post unless the
  // caller moderates it; 403 for anyone but its author and moderators.
  private async lock(
    connection: PoolConnection,
    postId: string,
    actorId: string,
  ): Promise<{
    nsfw_set_by: SetBy | null;
    spoiler_set_by: SetBy | null;
    moderator: boolean;
  }> {
    const [rows] = await connection.execute<LabelPostRow[]>(LABEL_POST_SQL, [
      actorId,
      actorId,
      postId,
      actorId,
    ]);
    const post = rows[0];
    const moderator = post ? isSqlTrue(post.can_moderate) : false;
    if (!post || (post.removed_at !== null && !moderator)) {
      throw new NotFoundException('Post not found');
    }
    if (!moderator && post.author_id !== actorId) {
      throw new ForbiddenException(
        'Only the author and the community moderators can label this post',
      );
    }
    return {
      nsfw_set_by: post.nsfw_set_by,
      spoiler_set_by: post.spoiler_set_by,
      moderator,
    };
  }
}
