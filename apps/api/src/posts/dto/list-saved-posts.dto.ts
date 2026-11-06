import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const SAVED_POST_SORTS = ['new', 'oldest'] as const;
export type SavedPostSort = (typeof SAVED_POST_SORTS)[number];

// Query of GET /users/me/saved-posts. There is no user parameter: the list
// is always the caller's own.
export class ListSavedPostsDto {
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
    enum: SAVED_POST_SORTS,
    default: 'new',
    description:
      'By when the post was saved, not when it was posted: new is most ' +
      'recently saved first, oldest reverses it.',
  })
  @IsOptional()
  @IsIn(SAVED_POST_SORTS)
  sort?: SavedPostSort;
}
