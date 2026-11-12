import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  COMMUNITY_REPORT_STATUSES,
  type CommunityReportStatus,
  type CommunityReportTarget,
} from './community-report-review';
import type {
  CommunityReportDetailDto,
  CommunityReportDto,
  CommunityReportItemDto,
  ModQueueEntryDto,
  Page,
  ReportedContentDto,
} from './community-reports.service';
import { REPORT_REASONS, type ReportReason } from './report.constants';

export class ReportedContentResponse implements ReportedContentDto {
  @ApiProperty({ enum: ['post', 'comment'] })
  type!: CommunityReportTarget;

  @ApiProperty()
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "A comment's post.",
  })
  post_id!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "A post's title." })
  title!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The first 300 characters of the body, link or caption.',
  })
  excerpt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "null once the author's account is deleted.",
  })
  author_username!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ description: 'Whether a moderator has removed it.' })
  removed!: boolean;
}

export class CommunityReportItemResponse implements CommunityReportItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: ReportReason;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

const REASON_COUNTS = {
  type: 'object',
  additionalProperties: { type: 'integer' },
  description: 'Open reports per reason; reasons without one are absent.',
  example: { spam: 3, harassment: 1 },
} as const;

export class ModQueueEntryResponse implements ModQueueEntryDto {
  @ApiProperty({ enum: ['post', 'comment'] })
  target_type!: CommunityReportTarget;

  @ApiProperty()
  target_id!: string;

  @ApiProperty({
    type: ReportedContentResponse,
    nullable: true,
    description: 'null when its author has deleted it.',
  })
  target!: ReportedContentResponse | null;

  @ApiProperty({ type: 'integer', description: 'Open reports of it.' })
  report_count!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Distinct reporters, without deleted accounts.',
  })
  reporter_count!: number;

  @ApiProperty(REASON_COUNTS)
  reasons!: Partial<Record<ReportReason, number>>;

  @ApiProperty({ format: 'date-time' })
  first_reported_at!: string;

  @ApiProperty({ format: 'date-time' })
  last_reported_at!: string;

  @ApiProperty({
    type: [CommunityReportItemResponse],
    description:
      'The newest 25 open reports, each listed singly. Never the reporter.',
  })
  reports!: CommunityReportItemResponse[];
}

export class ModQueueResponse implements Page<ModQueueEntryDto> {
  @ApiProperty({ type: [ModQueueEntryResponse] })
  items!: ModQueueEntryResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer', description: 'Queue entries, not reports.' })
  total!: number;
}

export class CommunityReportResponse
  extends CommunityReportItemResponse
  implements CommunityReportDto
{
  @ApiProperty({ enum: ['post', 'comment'] })
  target_type!: CommunityReportTarget;

  @ApiProperty()
  target_id!: string;

  @ApiProperty({ type: ReportedContentResponse, nullable: true })
  target!: ReportedContentResponse | null;

  @ApiProperty({ enum: COMMUNITY_REPORT_STATUSES })
  community_status!: CommunityReportStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  community_reviewed_at!: string | null;

  @ApiProperty({
    type: 'integer',
    description: 'Open reports of the same content, this one included.',
  })
  open_reports_on_target!: number;

  @ApiProperty({ type: 'integer' })
  open_reporters_on_target!: number;
}

export class CommunityReportListResponse implements Page<CommunityReportDto> {
  @ApiProperty({ type: [CommunityReportResponse] })
  items!: CommunityReportResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class CommunityReportDetailResponse
  extends CommunityReportResponse
  implements CommunityReportDetailDto
{
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The moderator who closed it, for the moderators; never shown to the ' +
      'reporter. null while open or once that account is deleted.',
  })
  community_reviewed_by_username!: string | null;

  @ApiProperty({
    type: [CommunityReportItemResponse],
    description: 'The other open reports of the same content, newest 25.',
  })
  other_open_reports!: CommunityReportItemResponse[];
}
