import { ApiProperty } from '@nestjs/swagger';
import {
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  type ReportReason,
  type ReportTargetType,
} from './report.constants';
import type { CreatedReportDto } from './reports.service';

export class CreatedReportResponse implements CreatedReportDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: REPORT_TARGET_TYPES })
  target_type!: ReportTargetType;

  @ApiProperty({ description: 'The target as submitted.' })
  target!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The reported account, for a user target only.',
  })
  reported_username!: string | null;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: ReportReason;

  @ApiProperty({ enum: ['open'] })
  status!: 'open';

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}
