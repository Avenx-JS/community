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
  ValidateIf,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

// One year, the ceiling platform suspensions use.
export const MAX_COMMUNITY_BAN_DURATION_HOURS = 8760;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateCommunityBanDto {
  @ApiProperty({ minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_]+$' })
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;

  // Excluding a person must carry a justification.
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  reason!: string;

  // A duration, never a timestamp: the deadline comes from the database clock,
  // so a client clock cannot set a ban in the past or decades ahead.
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_COMMUNITY_BAN_DURATION_HOURS,
    description: 'Hours until the ban expires. Omit for a permanent ban.',
  })
  // Absent means permanent; an explicit null is refused, not read as either.
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COMMUNITY_BAN_DURATION_HOURS)
  duration_hours?: number;
}

export class LiftCommunityBanDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  lift_reason?: string;
}

export const COMMUNITY_BAN_STATES = ['any', 'active', 'lifted'] as const;
export type CommunityBanState = (typeof COMMUNITY_BAN_STATES)[number];

export class ListCommunityBansDto {
  @ApiPropertyOptional({
    enum: COMMUNITY_BAN_STATES,
    default: 'active',
    description:
      '`active`: in force now. `lifted`: no longer in force, lifted or ' +
      'expired. `any`: both. active and lifted partition any.',
  })
  @IsOptional()
  @IsIn(COMMUNITY_BAN_STATES)
  active: CommunityBanState = 'active';

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
}
