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
  Min,
  Validate,
} from 'class-validator';
import {
  APPEAL_TARGET_TYPES,
  type AppealTargetType,
} from '../../admin/audit-log.service';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

export { APPEAL_TARGET_TYPES, type AppealTargetType };

export const APPEAL_STATUSES = ['open', 'approved', 'rejected'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

export const APPEAL_DECISIONS = ['approved', 'rejected'] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];

export const APPEAL_REASON_MIN = 10;
export const APPEAL_TEXT_MAX = 2000;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Body of POST /appeals.
export class CreateAppealDto {
  @ApiProperty({
    enum: APPEAL_TARGET_TYPES,
    description:
      'restriction: your suspension or ban; post_removal, comment_removal: ' +
      'an administrator’s removal of your post or comment; ' +
      'community_suspension: the suspension of a community you created.',
  })
  @IsIn(APPEAL_TARGET_TYPES)
  target_type!: AppealTargetType;

  @ApiProperty({
    pattern: '^[A-Za-z0-9_-]{1,36}$',
    description:
      'The restriction, post, comment or community ID: the subject of the ' +
      'notification, or, for a restriction, restriction.id of the login ' +
      'response.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,36}$/)
  target_id!: string;

  @ApiProperty({ minLength: APPEAL_REASON_MIN, maxLength: APPEAL_TEXT_MAX })
  @Transform(trim)
  @IsString()
  @Length(APPEAL_REASON_MIN, APPEAL_TEXT_MAX)
  @Validate(PlainTextConstraint)
  reason!: string;
}

// Query of GET /users/me/appeals.
export class ListOwnAppealsDto {
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

// Query of GET /admin/appeals.
export class ListAdminAppealsDto extends ListOwnAppealsDto {
  @ApiPropertyOptional({
    enum: [...APPEAL_STATUSES, 'any'],
    default: 'open',
    description:
      'open (default): the queue, oldest first. Any other value: newest first.',
  })
  @IsOptional()
  @IsIn([...APPEAL_STATUSES, 'any'])
  status?: AppealStatus | 'any';

  @ApiPropertyOptional({ enum: APPEAL_TARGET_TYPES })
  @IsOptional()
  @IsIn(APPEAL_TARGET_TYPES)
  target_type?: AppealTargetType;
}

// Body of PATCH /admin/appeals/:id.
export class DecideAppealDto {
  @ApiProperty({
    enum: APPEAL_DECISIONS,
    description: 'approved reverses the decision; rejected keeps it.',
  })
  @IsIn(APPEAL_DECISIONS)
  status!: AppealDecision;

  @ApiProperty({
    minLength: 1,
    maxLength: APPEAL_TEXT_MAX,
    description:
      'Shown to the user, in GET /users/me/appeals and the notification.',
  })
  @Transform(trim)
  @IsString()
  @Length(1, APPEAL_TEXT_MAX)
  @Validate(PlainTextConstraint)
  decision_note!: string;
}
