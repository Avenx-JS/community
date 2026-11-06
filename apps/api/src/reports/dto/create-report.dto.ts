import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import { REPORT_REASONS, REPORT_TARGET_TYPES } from '../report.constants';
import type { ReportReason, ReportTargetType } from '../report.constants';

@ValidatorConstraint({ name: 'reportContextPair', async: false })
class ReportContextPairConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const input = args.object as CreateReportDto;
    return (
      (input.context_type === undefined && input.context_id === undefined) ||
      (typeof input.context_type === 'string' &&
        typeof input.context_id === 'string')
    );
  }

  defaultMessage(): string {
    return 'context_type and context_id must be provided together';
  }
}

// For a content or community target the target is itself the evidence.
@ValidatorConstraint({ name: 'reportContextTarget', async: false })
class ReportContextTargetConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const input = args.object as CreateReportDto;
    return (
      input.target_type === 'user' ||
      (input.context_type === undefined && input.context_id === undefined)
    );
  }

  defaultMessage(): string {
    return 'context_type and context_id are only allowed when target_type is user';
  }
}

export class CreateReportDto {
  /** What is being reported; decides how target is read. */
  @IsIn(REPORT_TARGET_TYPES)
  target_type!: ReportTargetType;

  /**
   * A username for user, a community name for community, an ID for post and
   * comment. The format for the given target_type is checked after this
   * combined pattern: username 3-50 letters, digits or underscores; community
   * name 1-50, also allowing hyphens; ID 1-36, also allowing hyphens.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 50)
  @Matches(/^[A-Za-z0-9_-]+$/)
  // On a required field, so they run even when both context fields are absent.
  @Validate(ReportContextPairConstraint)
  @Validate(ReportContextTargetConstraint)
  target!: string;

  @IsIn(REPORT_REASONS)
  reason!: ReportReason;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(2000)
  @Validate(PlainTextConstraint)
  description?: string;

  /** Only for a user target. Provide together with context_id. */
  @IsOptional()
  @IsIn(['post', 'comment'])
  context_type?: 'post' | 'comment';

  /**
   * Only for a user target: a post or comment by the reported user. Provide
   * together with context_type.
   */
  @IsOptional()
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  context_id?: string;
}
