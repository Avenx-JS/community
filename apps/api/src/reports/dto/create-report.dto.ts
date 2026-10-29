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
import { REPORT_REASONS } from '../report.constants';
import type { ReportReason } from '../report.constants';

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

export class CreateReportDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  @Validate(ReportContextPairConstraint)
  username!: string;

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

  /** Provide together with context_id. */
  @IsOptional()
  @IsIn(['post', 'comment'])
  context_type?: 'post' | 'comment';

  /** Post or comment by the reported user; provide with context_type. */
  @IsOptional()
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  context_id?: string;
}
