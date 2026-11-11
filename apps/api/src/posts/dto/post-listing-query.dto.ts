import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

export const POST_LIST_SORTS = ['new', 'hot', 'top', 'rising'] as const;
export type PostListSort = (typeof POST_LIST_SORTS)[number];

export const POST_TOP_WINDOWS = [
  'hour',
  'day',
  'week',
  'month',
  'year',
  'all',
] as const;
export type PostTopWindow = (typeof POST_TOP_WINDOWS)[number];

// time ranks only top. Sent with another sort it would be silently ignored,
// which looks like a ranking bug; it is refused instead, as search refuses a
// filter its type does not take.
@ValidatorConstraint({ name: 'timeAppliesToTop', async: false })
class TimeOnlyWithTopConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (args.object as PostListingQueryDto).sort === 'top';
  }

  defaultMessage(): string {
    return 'time applies only to sort=top';
  }
}

export const POST_SORT_DESCRIPTION =
  'new (default): newest first. hot: score and age combined, newer posts ' +
  'winning ties (every 12.5 hours of age weigh one order of magnitude of ' +
  'score). top: highest score first, within `time`. rising: posts of the ' +
  'last 24 hours, score and age combined four times more steeply than hot. ' +
  'Every ranking is stored with the post and recomputed on each vote, so ' +
  'it never changes while the votes do not; ties break by id, descending.';

// The paging and ranking query every post listing shares: GET /posts,
// GET /communities/:name/posts and GET /feed.
export class PostListingQueryDto {
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
    enum: POST_LIST_SORTS,
    default: 'new',
    description: POST_SORT_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(POST_LIST_SORTS)
  sort?: PostListSort;

  @ApiPropertyOptional({
    enum: POST_TOP_WINDOWS,
    default: 'all',
    description:
      'Only with sort=top (400 otherwise): ranks posts created within the ' +
      'last hour, day (24 h), week (7 days), month (30 days) or year ' +
      '(365 days), or all posts.',
  })
  @IsOptional()
  @IsIn(POST_TOP_WINDOWS)
  @Validate(TimeOnlyWithTopConstraint)
  time?: PostTopWindow;
}
