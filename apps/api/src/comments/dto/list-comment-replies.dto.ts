import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const COMMENT_LIST_SORTS = ['oldest', 'new'] as const;
export type CommentListSort = (typeof COMMENT_LIST_SORTS)[number];

// Query of GET /comments/:id/replies and GET /posts/:postId/comments/top-level.
// sort defaults to oldest, unlike every other listing: a discussion reads in
// the order it was written, and the tree route orders the same way.
export class ListCommentRepliesDto {
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

  @ApiPropertyOptional({
    enum: COMMENT_LIST_SORTS,
    default: 'oldest',
    description:
      'oldest: created_at, then id, ascending. new: both descending.',
  })
  @IsOptional()
  @IsIn(COMMENT_LIST_SORTS)
  sort?: CommentListSort;
}
