import { ApiProperty } from '@nestjs/swagger';
import {
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
} from './report.constants';
import type {
  CreatedReportDto,
  OwnReportDto,
  OwnReportList,
} from './reports.service';

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

// A report as its reporter sees it. Distinct from the admin report classes on
// purpose: those carry the moderator-only fields (resolution, resolution_note,
// reviewer, reviewed_at, the reported account), and none of them may appear
// here.
export class OwnReportResponse implements OwnReportDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: REPORT_TARGET_TYPES })
  target_type!: ReportTargetType;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The username, community name, post title or the first 100 characters ' +
      'of the comment. Null when the target no longer exists or is no longer ' +
      'publicly readable: a deleted account or community, removed content.',
  })
  target_label!: string | null;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: ReportReason;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Your own description, as submitted.',
  })
  description!: string | null;

  @ApiProperty({
    enum: REPORT_STATUSES,
    description:
      'Where the report is in the moderation queue. The outcome is never ' +
      'disclosed beyond this.',
  })
  status!: ReportStatus;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When you withdrew the report; null while it stands.',
  })
  withdrawn_at!: string | null;
}

export class OwnReportListResponse implements OwnReportList {
  @ApiProperty({ type: [OwnReportResponse] })
  items!: OwnReportResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}
