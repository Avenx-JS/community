import { ApiProperty } from '@nestjs/swagger';
import { REPORT_REASONS, type ReportReason } from './report.constants';
import type { CreatedReportDto } from './reports.service';

export class CreatedReportResponse implements CreatedReportDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  reported_username!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: ReportReason;

  @ApiProperty({ enum: ['open'] })
  status!: 'open';

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}
