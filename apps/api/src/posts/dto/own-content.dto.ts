import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

class PageQuery {
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

export const OWN_LIST_SORTS = ['new', 'oldest'] as const;
export type OwnListSort = (typeof OWN_LIST_SORTS)[number];

// GET /users/me/hidden-posts and /saved-comments: always the caller's own.
export class ListOwnContentDto extends PageQuery {
  @ApiPropertyOptional({
    enum: OWN_LIST_SORTS,
    default: 'new',
    description:
      'By when the caller hid or saved it: new is most recent first, ' +
      'oldest reverses it.',
  })
  @IsOptional()
  @IsIn(OWN_LIST_SORTS)
  sort?: OwnListSort;
}

export const VOTED_TYPES = ['posts', 'comments'] as const;
export type VotedType = (typeof VOTED_TYPES)[number];

// GET /users/me/upvoted and /downvoted.
export class ListVotedDto extends PageQuery {
  @ApiPropertyOptional({ enum: VOTED_TYPES, default: 'posts' })
  @IsOptional()
  @IsIn(VOTED_TYPES)
  type?: VotedType;
}

// GET /posts/:id/revisions and /comments/:id/revisions.
export class ListRevisionsDto extends PageQuery {}
