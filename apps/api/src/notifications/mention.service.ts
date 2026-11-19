import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_COMMUNITY_BAN_PREDICATE } from '../common/active-community-ban';
import { communityMemberSql } from '../common/community-visibility';
import { readPositiveInteger } from '../common/read-positive-integer';
import { eitherBlockedSql } from '../users/user-block-policy.service';
import { addedMentions, extractMentions } from './mentions';
import { NotificationsService } from './notifications.service';

// The accounts a mention may notify, among the usernames written, for
// content by the author in the community. Not: deleted accounts, the author,
// an account blocked by or blocking the author, one with notify_mentions
// off, one banned from the community, and, in a private community, one that
// is not a member (who cannot read the content). The ban predicate's
// columns are unqualified; only community_bans has them. Each row carries
// the snapshots the notification keeps: the community's name and the
// author's username.
// Values: community, author, the usernames, author, author, author.
export const mentionRecipientsSql = (count: number) => `SELECT u.id, u.username,
         c.name AS community_name, author.username AS author_username
       FROM users u
       INNER JOIN communities c ON c.id = ?
       INNER JOIN users author ON author.id = ?
       LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.username IN (${new Array(count).fill('?').join(', ')})
         AND u.deleted_at IS NULL
         AND u.id <> ?
         AND COALESCE(p.notify_mentions, TRUE)
         AND NOT ${eitherBlockedSql('u.id', '?')}
         AND NOT EXISTS (
           SELECT 1 FROM community_bans b
           WHERE b.community_id = c.id AND b.user_id = u.id
             AND ${ACTIVE_COMMUNITY_BAN_PREDICATE}
         )
         AND (c.visibility <> 'private' OR ${communityMemberSql('c', 'u.id')})`;

export interface MentionContext {
  authorId: string;
  communityId: string;
  subjectType: 'post' | 'comment';
  subjectId: string;
  // The post a comment belongs to.
  postId?: string;
  postTitle?: string;
  // The new text (a post's title and content together), and on an edit the
  // version it replaces: only mentions it adds notify.
  text: string;
  previousText?: string | null;
  // Accounts this content already notifies otherwise: the post author a
  // top-level comment notifies (post_comment), the parent comment's author a
  // reply notifies (comment_reply).
  alreadyNotified?: readonly (string | null | undefined)[];
  excerpt?: string;
}

// Mention notifications, written on the caller's connection, so they commit
// with the post or comment that carries them. At most MENTIONS_PER_ITEM
// (10) usernames per post or comment are considered: the first ones written;
// the rest stay plain text. The notifications table's unique key (recipient,
// type, subject) means one account is notified once per post or comment,
// however often an edit re-adds it.
@Injectable()
export class MentionService {
  readonly limit = readPositiveInteger('MENTIONS_PER_ITEM', 10);
  private readonly notifications: NotificationsService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    @Optional() notifications?: NotificationsService,
  ) {
    this.notifications = notifications ?? new NotificationsService(pool);
  }

  // Returns how many accounts were notified.
  async record(
    connection: PoolConnection,
    context: MentionContext,
  ): Promise<number> {
    const names =
      context.previousText === undefined
        ? extractMentions(context.text, this.limit)
        : addedMentions(context.previousText, context.text, this.limit);
    if (names.length === 0) {
      return 0;
    }
    const [rows] = await connection.execute<
      (RowDataPacket & {
        id: string;
        username: string;
        community_name: string;
        author_username: string;
      })[]
    >(mentionRecipientsSql(names.length), [
      context.communityId,
      context.authorId,
      ...names,
      context.authorId,
      context.authorId,
      context.authorId,
    ]);
    const skip = new Set(context.alreadyNotified ?? []);
    const recipients = rows.filter((row) => !skip.has(row.id));
    if (recipients.length === 0) {
      return 0;
    }
    await this.notifications.recordMany(
      connection,
      recipients.map((row) => ({
        recipientId: row.id,
        type: 'mention',
        actorId: context.authorId,
        subjectType: context.subjectType,
        subjectId: context.subjectId,
        communityId: context.communityId,
        metadata: {
          actor_username: row.author_username,
          community_name: row.community_name,
          ...(context.postId ? { post_id: context.postId } : {}),
          ...(context.postTitle ? { post_title: context.postTitle } : {}),
          ...(context.excerpt ? { excerpt: context.excerpt } : {}),
        },
      })),
    );
    return recipients.length;
  }
}
