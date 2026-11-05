import { ApiProperty } from '@nestjs/swagger';
import { COMMENT_LIST_SORTS } from './dto/list-comment-replies.dto';
import type { CommentListSort } from './dto/list-comment-replies.dto';
import type {
  CommentDto,
  CommentReplyDto,
  CommentReplyListDto,
  CommentThreadDto,
} from './comments.service';

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
    type: 'integer',
    description: 'Sum of all vote values on the comment; 0 without votes.',
  })
  score!: number;

  @ApiProperty({ type: () => [CommentResponse] })
  replies!: CommentResponse[];
}

export class CommentThreadResponse implements CommentThreadDto {
  @ApiProperty()
  post_id!: string;

  @ApiProperty({
    type: [CommentResponse],
    description: 'Top-level comments, oldest first, with nested replies.',
  })
  comments!: CommentResponse[];
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
