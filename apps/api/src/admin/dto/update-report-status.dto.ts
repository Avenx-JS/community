import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import { REPORT_RESOLUTIONS as reportResolutions } from '../../reports/report.constants';
import type {
  ReportResolution,
  ReportStatus,
} from '../../reports/report.constants';

export type { ReportResolution };

@ValidatorConstraint({ name: 'reportResolutionMatchesStatus', async: false })
export class ReportResolutionMatchesStatusConstraint implements ValidatorConstraintInterface {
  validate(_status: unknown, args: ValidationArguments): boolean {
    const input = args.object as UpdateReportStatusDto;
    const resolution = input.resolution;
    if (input.status === 'resolved') {
      return (
        typeof resolution === 'string' &&
        reportResolutions.some((allowed) => allowed === resolution)
      );
    }
    return resolution === undefined;
  }

  defaultMessage(): string {
    return 'resolution is required only when status is resolved';
  }
}

export class UpdateReportStatusDto {
  @IsIn(['under_review', 'resolved', 'rejected'])
  @Validate(ReportResolutionMatchesStatusConstraint)
  status!: Exclude<ReportStatus, 'open'>;

  @IsOptional()
  @IsIn(reportResolutions)
  resolution?: ReportResolution;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(2000)
  @Validate(PlainTextConstraint)
  resolution_note?: string;
}
