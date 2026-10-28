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
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

// Proposed ceiling of one year; the real limit is an open policy question.
export const MAX_RESTRICTION_DURATION_HOURS = 8760;

export type RestrictionType = 'suspension' | 'ban';

// Attached to `type` rather than `duration_hours`, because @IsOptional would
// skip this check entirely when the duration is missing.
@ValidatorConstraint({ name: 'restrictionDurationMatchesType', async: false })
export class RestrictionDurationMatchesTypeConstraint implements ValidatorConstraintInterface {
  validate(_type: unknown, args: ValidationArguments): boolean {
    const input = args.object as CreateRestrictionDto;
    if (input.type === 'suspension') {
      return typeof input.duration_hours === 'number';
    }
    if (input.type === 'ban') {
      return input.duration_hours === undefined;
    }
    return true;
  }

  defaultMessage(): string {
    return 'duration_hours is required for suspensions and forbidden for bans';
  }
}

export class CreateRestrictionDto {
  @IsIn(['suspension', 'ban'])
  @Validate(RestrictionDurationMatchesTypeConstraint)
  type!: RestrictionType;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  reason!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RESTRICTION_DURATION_HOURS)
  duration_hours?: number;

  @IsOptional()
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  report_id?: string;
}
