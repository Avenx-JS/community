import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import { SEARCH_MIN_WORD_LENGTH, fullTextWords } from '../search-terms';

export const SEARCH_TYPES = [
  'users',
  'communities',
  'posts',
  'comments',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export const SEARCH_SORTS = ['relevance', 'new'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

// OFFSET over a full-text match re-reads every skipped row, so deep pages cost
// more than anywhere else; this route stops at page 100 instead of 10000.
export const SEARCH_MAX_PAGE = 100;

@ValidatorConstraint({ name: 'searchFilterAppliesToType', async: false })
class ContentOnlyFilterConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const { type } = args.object as SearchQueryDto;
    return value === undefined || type === 'posts' || type === 'comments';
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} applies only to type=posts and type=comments`;
  }
}

// Half-open [from, to): an equal or reversed pair can match nothing, which
// would look like a missing-results bug rather than a client mistake.
@ValidatorConstraint({ name: 'searchRangeOrder', async: false })
class RangeOrderConstraint implements ValidatorConstraintInterface {
  validate(to: unknown, args: ValidationArguments): boolean {
    const { from } = args.object as SearchQueryDto;
    if (typeof from !== 'string' || typeof to !== 'string') {
      return true;
    }
    return Date.parse(from) < Date.parse(to);
  }

  defaultMessage(): string {
    return 'to must be later than from';
  }
}

// Full-text search ignores words shorter than the index's minimum token size,
// so "go C" or "+++" could only return an empty list. Usernames are matched
// by prefix instead, where any 3 characters are a valid term.
@ValidatorConstraint({ name: 'searchHasWord', async: false })
class SearchableWordConstraint implements ValidatorConstraintInterface {
  validate(q: unknown, args: ValidationArguments): boolean {
    const { type } = args.object as SearchQueryDto;
    return (
      typeof q !== 'string' || type === 'users' || fullTextWords(q).length > 0
    );
  }

  defaultMessage(): string {
    return `q must contain a word of at least ${SEARCH_MIN_WORD_LENGTH} letters or digits`;
  }
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SearchQueryDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 100,
    description:
      'Plain text. Operator characters (+ - > < ( ) ~ * " @) are ignored. ' +
      'For posts, comments and communities, words shorter than 3 ' +
      'characters match nothing, so q needs at least one longer word.',
  })
  @Transform(trim)
  @IsString()
  @Length(3, 100, {
    message:
      'q must be 3 to 100 characters: shorter terms cannot match in full-text search',
  })
  @Validate(PlainTextConstraint)
  @Validate(SearchableWordConstraint)
  q!: string;

  @ApiProperty({
    enum: SEARCH_TYPES,
    description:
      'Which kind of result to return. Required; there is no default.',
  })
  @IsIn(SEARCH_TYPES)
  type!: SearchType;

  @ApiPropertyOptional({
    description: 'Community name. Only with type=posts or type=comments.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,50}$/)
  @Validate(ContentOnlyFilterConstraint)
  community?: string;

  @ApiPropertyOptional({
    description: 'Author username. Only with type=posts or type=comments.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  @Validate(ContentOnlyFilterConstraint)
  author?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Created at or after. Only with type=posts or type=comments.',
  })
  @IsOptional()
  @IsISO8601()
  @Validate(ContentOnlyFilterConstraint)
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Created before; must be later than from. Only with type=posts or type=comments.',
  })
  @IsOptional()
  @IsISO8601()
  @Validate(ContentOnlyFilterConstraint)
  @Validate(RangeOrderConstraint)
  to?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: SEARCH_MAX_PAGE,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_PAGE)
  page = 1;

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
  limit = 20;

  @ApiPropertyOptional({ enum: SEARCH_SORTS, default: 'relevance' })
  @IsOptional()
  @IsIn(SEARCH_SORTS)
  sort: SearchSort = 'relevance';
}
