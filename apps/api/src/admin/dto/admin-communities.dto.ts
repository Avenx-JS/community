import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

export const ADMIN_COMMUNITY_STATES = [
  'any',
  'active',
  'suspended',
  'deleted',
] as const;
export type AdminCommunityState = (typeof ADMIN_COMMUNITY_STATES)[number];

export class ListAdminCommunitiesDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Case-insensitive substring of the name or description.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Validate(PlainTextConstraint)
  search?: string;

  @ApiPropertyOptional({ pattern: '^[a-zA-Z0-9_]{3,50}$' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  creator_username?: string;

  @ApiPropertyOptional({
    enum: ADMIN_COMMUNITY_STATES,
    default: 'any',
    description:
      '`any` (default) is every community, including the suspended and ' +
      'soft-deleted ones the public listing hides. `deleted` is soft-deleted ' +
      '(suspended or not), `suspended` is suspended and not deleted, ' +
      '`active` is neither; the three partition `any`.',
  })
  @IsOptional()
  @IsIn(ADMIN_COMMUNITY_STATES)
  state: AdminCommunityState = 'any';

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

  @ApiPropertyOptional({ enum: ['new', 'oldest'], default: 'new' })
  @IsOptional()
  @IsIn(['new', 'oldest'])
  sort: 'new' | 'oldest' = 'new';
}

// The description only, validated as the creator's PATCH /communities/:name
// validates it: trimmed, at most 16383 characters, "" clears it. Narrower
// than the creator's body on purpose: an administrator corrects content, and
// never changes who may see or post in a community (visibility, nsfw,
// allowed_post_types are the creator's). name, rules and every other
// property are rejected by the global pipe's forbidNonWhitelisted.
export class AdminUpdateCommunityDto {
  /**
   * Plain-text description, at most 16383 characters after trimming. An
   * empty string clears it.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  description!: string;
}

// What an administrator may edit: AdminUpdateCommunityDto's fields.
export const ADMIN_EDITABLE_COMMUNITY_FIELDS = ['description'] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Indefinite by design: a community suspension has no duration, unlike a
// user suspension. duration_hours, expires_at and anything else are rejected
// by forbidNonWhitelisted. Required, because taking a community offline
// affects every member and the justification is what makes it reviewable.
export class SuspendCommunityDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  reason!: string;
}

// A reversal is a decision too, as lifting a restriction is.
export class RestoreCommunityDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  restore_reason!: string;
}
