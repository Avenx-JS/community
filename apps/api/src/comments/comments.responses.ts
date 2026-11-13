import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { COMMENT_LIST_SORTS } from './dto/list-comment-replies.dto';
import type { CommentListSort } from './dto/list-comment-replies.dto';
import type {
  CommentDto,
  CommentPermalinkDto,
  CommentPermalinkTombstoneDto,
  CommentReplyDto,
  CommentReplyListDto,
  CommentTombstoneDto,
  CommentThreadDto,
} from './comments.service';

// A thread node: a full comment or a tombstone. The models are registered
// with @ApiExtraModels on GET /posts/:postId/comments.
const COMMENT_NODES_SCHEMA = {
  type: 'array' as const,
  items: {
    oneOf: [
      { $ref: getSchemaPath('CommentResponse') },
      { $ref: getSchemaPath('CommentTombstoneResponse') },
    ],
  },
};

export class CommentResponse implements CommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  post_id!: string;

  @ApiProperty()
  author_id!: string;

  @ApiProperty({ type: String, nullable: true })
  parent_id!: string | null;

  @ApiProperty()
  content!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the author last changed the content; null if never edited.',
  })
  edited_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When a moderator locked the comment, closing its whole subtree to ' +
      'new replies; null if open.',
  })
  locked_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Who locked the comment. Also null on a locked comment once that ' +
      "moderator's account is deleted.",
  })
  locked_by!: string | null;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the comment; 0 without votes.',
  })
  score!: number;

  @ApiProperty({
    ...COMMENT_NODES_SCHEMA,
    description:
      'Direct replies, each a CommentResponse or, if removed by a ' +
      'moderator, a CommentTombstoneResponse (for everyone but reviewers).',
  })
  replies!: (CommentResponse | CommentTombstoneResponse)[];

  @ApiPropertyOptional({
    enum: [true],
    description:
      'Present only on a removed comment, and only for its reviewers ' +
      '(community creator, community moderators, platform admins).',
  })
  removed?: true;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Reviewers only: when the comment was removed.',
  })
  removed_at?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "Reviewers only: who removed it; null once that moderator's account " +
      'is deleted.',
  })
  removed_by?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Reviewers only: the optional removal reason.',
  })
  removal_reason?: string | null;

  @ApiPropertyOptional({
    description:
      'Reviewers only: true when a platform administrator removed it. ' +
      'Community moderators cannot restore such a removal (403).',
  })
  removed_by_admin?: boolean;
}

// A removed comment in the thread, for everyone but its reviewers: its place
// and its replies survive, its content and author do not.
export class CommentTombstoneResponse implements CommentTombstoneDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  post_id!: string;

  @ApiProperty({ type: String, nullable: true })
  parent_id!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ enum: [true] })
  removed!: true;

  @ApiProperty({ ...COMMENT_NODES_SCHEMA, description: 'Direct replies.' })
  replies!: (CommentResponse | CommentTombstoneResponse)[];
}

export class CommentThreadResponse implements CommentThreadDto {
  @ApiProperty()
  post_id!: string;

  @ApiProperty({
    ...COMMENT_NODES_SCHEMA,
    description:
      'Top-level comments, oldest first, with nested replies; removed ' +
      'comments appear as tombstones to everyone but reviewers.',
  })
  comments!: (CommentResponse | CommentTombstoneResponse)[];
}

// A flat comment of a paginated listing, distinct from the recursive
// CommentResponse: it has no replies, only their count. Nesting subtrees in a
// page's items would make the paginated routes unbounded again.
export class CommentReplyResponse implements CommentReplyDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  post_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null for a top-level comment.',
  })
  parent_id!: string | null;

  @ApiProperty()
  author_id!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  edited_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When a moderator locked the comment, closing its whole subtree to ' +
      'new replies; null if open.',
  })
  locked_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Who locked the comment. Also null on a locked comment once that ' +
      "moderator's account is deleted.",
  })
  locked_by!: string | null;

  @ApiProperty({
    type: 'integer',
    description:
      'Visible direct replies; when above 0, page them through ' +
      'GET /comments/{id}/replies.',
  })
  reply_count!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the comment; 0 without votes.',
  })
  score!: number;
}

export class CommentReplyListResponse implements CommentReplyListDto {
  @ApiProperty({
    type: [CommentReplyResponse],
    description: 'Flat: never contains nested replies.',
  })
  items!: CommentReplyResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ enum: COMMENT_LIST_SORTS })
  sort!: CommentListSort;
}

// The response of POST /comments/:id/remove: the flat comment with its
// removal state, which only reviewers ever see.
export class RemovedCommentResponse extends CommentReplyResponse {
  @ApiProperty({ enum: [true] })
  removed!: true;

  @ApiProperty({ format: 'date-time' })
  removed_at!: string;

  @ApiProperty({ type: String, nullable: true })
  removed_by!: string | null;

  @ApiProperty({ type: String, nullable: true })
  removal_reason!: string | null;

  @ApiProperty({
    description: 'True when a platform administrator removed it.',
  })
  removed_by_admin!: boolean;
}

// A comment on a permalink's chain as a reviewer sees it: the flat comment,
// with its removal state when it was removed.
export class CommentPermalinkCommentResponse extends CommentReplyResponse {
  @ApiPropertyOptional({
    enum: [true],
    description: 'Present on a removed comment, which only reviewers see.',
  })
  removed?: true;

  @ApiPropertyOptional({ format: 'date-time' })
  removed_at?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  removed_by?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  removal_reason?: string | null;

  @ApiPropertyOptional({
    description: 'True when a platform administrator removed it.',
  })
  removed_by_admin?: boolean;
}

// A removed ancestor as everyone but its reviewers sees it.
export class CommentPermalinkTombstoneResponse implements CommentPermalinkTombstoneDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  post_id!: string;

  @ApiProperty({ type: String, nullable: true })
  parent_id!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ enum: [true] })
  removed!: true;
}

export class CommentPermalinkResponse implements CommentPermalinkDto {
  @ApiProperty()
  post_id!: string;

  @ApiProperty({ type: CommentPermalinkCommentResponse })
  comment!: CommentPermalinkCommentResponse;

  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath('CommentPermalinkCommentResponse') },
        { $ref: getSchemaPath('CommentPermalinkTombstoneResponse') },
      ],
    },
    description:
      'The chain above the comment, root first and the direct parent last; ' +
      'empty for a top-level comment. A removed ancestor is a tombstone to ' +
      'everyone but reviewers.',
  })
  ancestors!: (
    CommentPermalinkCommentResponse | CommentPermalinkTombstoneResponse
  )[];
}
