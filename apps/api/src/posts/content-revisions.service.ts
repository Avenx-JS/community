import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { isSqlTrue } from '../common/community-moderation';
import { readableCommunitySql } from '../common/community-visibility';
import { canReviewRemovedContent } from '../common/removed-content';
import type { ListRevisionsDto } from './dto/own-content.dto';

// The text of one version. title is null for comments.
export interface RevisionVersionDto {
  title: string | null;
  content: string | null;
  // When this version was written: the creation, or the edit that made it.
  version_at: string;
}

// An earlier version, and when it was replaced by the next one.
export interface RevisionDto extends RevisionVersionDto {
  replaced_at: string;
}

export interface RevisionListDto {
  // The version shown now; never one of items.
  current: RevisionVersionDto & { edited: boolean };
  // Earlier versions, most recently replaced first.
  items: RevisionDto[];
  page: number;
  limit: number;
  total: number;
  // false when edits made before history was kept (migration 039) left no
  // earlier versions: the oldest stored version is not the original.
  complete: boolean;
}

interface SubjectRow extends RowDataPacket {
  community_id: string;
  title?: string;
  content: string | null;
  created_at: Date | string;
  edited_at: Date | string | null;
  removed: number | string | boolean;
}

interface RevisionRow extends RowDataPacket {
  title?: string;
  content: string | null;
  version_at: Date | string;
  replaced_at: Date | string;
}

// The post or comment whose history is asked for, if the caller may read
// it at all. Values: id, the caller (null when anonymous).
export const POST_REVISION_SUBJECT_SQL = `SELECT posts.community_id, posts.title, posts.content,
         posts.created_at, posts.edited_at, posts.removed_at IS NOT NULL AS removed
       FROM posts
       WHERE posts.id = ? AND ${readableCommunitySql('posts.community_id')}
       LIMIT 1`;

export const COMMENT_REVISION_SUBJECT_SQL = `SELECT posts.community_id, comments.content,
         comments.created_at, comments.edited_at,
         (comments.removed_at IS NOT NULL OR posts.removed_at IS NOT NULL) AS removed
       FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND ${readableCommunitySql('posts.community_id')}
       LIMIT 1`;

// Values: id, limit, offset.
export const POST_REVISIONS_SQL = `SELECT title, content, version_at, replaced_at
       FROM post_revisions WHERE post_id = ?
       ORDER BY replaced_at DESC, version_at DESC, id DESC LIMIT ? OFFSET ?`;
export const COMMENT_REVISIONS_SQL = `SELECT content, version_at, replaced_at
       FROM comment_revisions WHERE comment_id = ?
       ORDER BY replaced_at DESC, version_at DESC, id DESC LIMIT ? OFFSET ?`;

// The count and the oldest stored version, which tells whether the history
// reaches back to the creation. Values: id.
export const POST_REVISIONS_SUMMARY_SQL =
  'SELECT COUNT(*) AS total, MIN(version_at) AS first_version_at FROM post_revisions WHERE post_id = ?';
export const COMMENT_REVISIONS_SUMMARY_SQL =
  'SELECT COUNT(*) AS total, MIN(version_at) AS first_version_at FROM comment_revisions WHERE comment_id = ?';

const iso = (value: Date | string) => new Date(value).toISOString();
const sameInstant = (a: Date | string, b: Date | string) =>
  new Date(a).getTime() === new Date(b).getTime();

// GET /posts/:id/revisions and /comments/:id/revisions. Exactly as readable
// as the content itself: 404 for unknown and deleted content (its history is
// deleted with it), for a deleted, suspended or (to a non-member) private
// community, and for removed content and content under a removed post except
// for those who may review it (canReviewRemovedContent).
@Injectable()
export class ContentRevisionsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  forPost(id: string, viewerId: string | undefined, query: ListRevisionsDto) {
    return this.list(
      'Post',
      id,
      viewerId,
      query,
      POST_REVISION_SUBJECT_SQL,
      POST_REVISIONS_SQL,
      POST_REVISIONS_SUMMARY_SQL,
    );
  }

  forComment(
    id: string,
    viewerId: string | undefined,
    query: ListRevisionsDto,
  ) {
    return this.list(
      'Comment',
      id,
      viewerId,
      query,
      COMMENT_REVISION_SUBJECT_SQL,
      COMMENT_REVISIONS_SQL,
      COMMENT_REVISIONS_SUMMARY_SQL,
    );
  }

  private async list(
    kind: 'Post' | 'Comment',
    id: string,
    viewerId: string | undefined,
    query: ListRevisionsDto,
    subjectSql: string,
    revisionsSql: string,
    summarySql: string,
  ): Promise<RevisionListDto> {
    const [subjects] = await this.pool.execute<SubjectRow[]>(subjectSql, [
      id,
      viewerId ?? null,
    ]);
    const subject = subjects[0];
    if (
      !subject ||
      (isSqlTrue(subject.removed) &&
        !(await canReviewRemovedContent(
          this.pool,
          subject.community_id,
          viewerId,
        )))
    ) {
      throw new NotFoundException(`${kind} not found`);
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [rows] = await this.pool.execute<RevisionRow[]>(revisionsSql, [
      id,
      limit,
      (page - 1) * limit,
    ]);
    const [summaries] = await this.pool.execute<
      (RowDataPacket & {
        total: number | string;
        first_version_at: Date | string | null;
      })[]
    >(summarySql, [id]);
    const summary = summaries[0];
    const firstVersionAt = summary?.first_version_at ?? null;

    return {
      current: {
        title: subject.title ?? null,
        content: subject.content,
        version_at: iso(subject.edited_at ?? subject.created_at),
        edited: subject.edited_at !== null,
      },
      items: rows.map((row) => ({
        title: row.title ?? null,
        content: row.content,
        version_at: iso(row.version_at),
        replaced_at: iso(row.replaced_at),
      })),
      page,
      limit,
      total: Number(summary?.total ?? 0),
      complete:
        subject.edited_at === null ||
        (firstVersionAt !== null &&
          sameInstant(firstVersionAt, subject.created_at)),
    };
  }
}
