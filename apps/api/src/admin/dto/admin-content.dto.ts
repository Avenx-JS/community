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
import { ELEVATED_ROLES, type ElevatedRole } from '../admin-roles.service';

// What GET /admin/posts and /admin/comments filter on. removed is either
// removal; moderator_removed and admin_removed split it by who removed.
export const ADMIN_CONTENT_STATES = [
  'any',
  'visible',
  'removed',
  'moderator_removed',
  'admin_removed',
] as const;
export type AdminContentState = (typeof ADMIN_CONTENT_STATES)[number];

// The state of the content's community, as GET /admin/communities names it.
export const ADMIN_CONTENT_COMMUNITY_STATES = [
  'any',
  'active',
  'suspended',
  'deleted',
] as const;
export type AdminContentCommunityState =
  (typeof ADMIN_CONTENT_COMMUNITY_STATES)[number];

const ID = /^[A-Za-z0-9_-]{1,36}$/;
const USERNAME = /^[a-zA-Z0-9_]{3,50}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class ListAdminContentDto {
  @ApiPropertyOptional({ pattern: ID.source })
  @IsOptional()
  @IsString()
  @Matches(ID)
  community_id?: string;

  @ApiPropertyOptional({ pattern: USERNAME.source })
  @IsOptional()
  @IsString()
  @Matches(USERNAME)
  author_username?: string;

  @ApiPropertyOptional({
    enum: ADMIN_CONTENT_STATES,
    default: 'any',
    description:
      '`visible` is not removed; `removed` is any removal, split by who ' +
      'removed it into `moderator_removed` and `admin_removed`.',
  })
  @IsOptional()
  @IsIn(ADMIN_CONTENT_STATES)
  state: AdminContentState = 'any';

  @ApiPropertyOptional({
    enum: ADMIN_CONTENT_COMMUNITY_STATES,
    default: 'any',
    description:
      'The state of the community the content is in, as in ' +
      '`GET /admin/communities`: `deleted` wins over `suspended`.',
  })
  @IsOptional()
  @IsIn(ADMIN_CONTENT_COMMUNITY_STATES)
  community_state: AdminContentCommunityState = 'any';

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

export class ListAdminPostsDto extends ListAdminContentDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Case-insensitive substring of the title.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Validate(PlainTextConstraint)
  search?: string;
}

export class ListAdminCommentsDto extends ListAdminContentDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Case-insensitive substring of the content.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Validate(PlainTextConstraint)
  search?: string;

  @ApiPropertyOptional({ pattern: ID.source })
  @IsOptional()
  @IsString()
  @Matches(ID)
  post_id?: string;
}

// Body of every /admin content action and role change. Required, unlike a
// moderator's optional removal reason: it goes into the audit log, and an
// override of the community's own moderators is reviewable only with it.
export class AdminReasonDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  reason!: string;
}

// Body of POST /admin/users/:id/roles. user is the baseline, never assigned.
export class AssignRoleDto extends AdminReasonDto {
  @ApiProperty({ enum: ELEVATED_ROLES })
  @IsIn(ELEVATED_ROLES)
  role!: ElevatedRole;
}
