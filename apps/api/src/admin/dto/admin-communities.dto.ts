import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import { UpdateCommunityDto } from '../../communities/dto/update-community.dto';

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

// Exactly the creator's PATCH /communities/:name body, so the two cannot drift:
// description only, trimmed, at most 16383 characters, "" clears it, at least
// one field required. name, rules and every other property are rejected by
// the global pipe's forbidNonWhitelisted.
export class AdminUpdateCommunityDto extends UpdateCommunityDto {}
