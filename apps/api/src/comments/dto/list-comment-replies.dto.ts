import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const COMMENT_LIST_SORTS = [
  'oldest',
  'new',
  'top',
  'controversial',
] as const;
export type CommentListSort = (typeof COMMENT_LIST_SORTS)[number];

export const COMMENT_SORT_DESCRIPTION =
  'oldest (default): created_at, then id, ascending. new: both descending. ' +
  'top: highest score first. controversial: most votes split most evenly ' +
  'first ((up + down) ^ (minority / majority); 0 without both an up- and a ' +
  'downvote). top and controversial break ties oldest first. Scores are ' +
  'stored with the comment and recomputed on each vote.';

// The sort of a comment listing, shared by the tree route and the two
// paginated routes. Defaults to oldest, unlike the post listings: a
// discussion reads in the order it was written.
export class CommentSortQueryDto {
  @ApiPropertyOptional({
    enum: COMMENT_LIST_SORTS,
    default: 'oldest',
    description: COMMENT_SORT_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(COMMENT_LIST_SORTS)
  sort?: CommentListSort;
}

// Query of GET /posts/:postId/comments: the tree orders the siblings at
// every level by sort. No paging: the tree is bounded instead
// (MAX_COMMENTS_PER_THREAD).
export class ListCommentThreadDto extends CommentSortQueryDto {}

// Query of GET /comments/:id/replies and GET /posts/:postId/comments/top-level.
export class ListCommentRepliesDto extends CommentSortQueryDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
