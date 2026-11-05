import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const USER_ACTIVITY_SORTS = ['new', 'oldest'] as const;
export type UserActivitySort = (typeof USER_ACTIVITY_SORTS)[number];

// Query of GET /users/:username/posts and GET /users/:username/comments.
export class ListUserActivityDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: USER_ACTIVITY_SORTS,
    description: 'new (default): newest first; oldest: oldest first.',
  })
  @IsOptional()
  @IsIn(USER_ACTIVITY_SORTS)
  sort?: UserActivitySort;
}

// Query of GET /users/:username/communities. No sort: the order is always
// by name, so it reveals nothing about when the person was active.
export class ListUserCommunitiesDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
