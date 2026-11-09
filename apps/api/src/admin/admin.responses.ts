import { ApiProperty } from '@nestjs/swagger';
import { countsByKey } from '../common/openapi';
import {
  REPORT_REASONS,
  REPORT_RESOLUTIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type ReportContextType,
  type ReportReason,
  type ReportResolution,
  type ReportStatus,
  type ReportTargetType,
} from '../reports/report.constants';
import type { PlatformRole } from '../users/users.service';
import type {
  MetricScope,
  ModerationAnalytics,
  UserAnalytics,
} from './admin-analytics.service';
import type {
  AdminActionItem,
  AdminActionList,
} from './admin-audit-log.service';
import {
  REPORT_QUEUE_STATS_SCOPES,
  type AdminReportDetail,
  type AdminReportList,
  type AdminReportListItem,
  type ReportQueueStats,
} from './admin-reports.service';
import type {
  AdminRestriction,
  AdminRestrictionList,
} from './admin-restrictions.service';
import type {
  AdminUserDetail,
  AdminUserList,
  AdminUserListItem,
} from './admin-users.service';
import type { AnalyticsGranularity, SeriesPoint } from './analytics-range';
import {
  REPORT_ASSIGNED_FILTERS,
  REPORT_WITHDRAWN_FILTERS,
  type ReportAssignedFilter,
  type ReportWithdrawnFilter,
} from './dto/list-reports.dto';
import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_TARGETS,
  type AdminAction,
  type AdminActionTarget,
} from './audit-log.service';
import type { RestrictionType } from './dto/create-restriction.dto';

const PLATFORM_ROLES = ['user', 'moderator', 'admin'] as const;
const RESTRICTION_TYPES = ['suspension', 'ban'] as const;
const USER_STATUSES = ['active', 'suspended', 'banned'] as const;
const LIST_SORTS = ['new', 'oldest'] as const;
type UserStatus = (typeof USER_STATUSES)[number];

// Users

export class AdminUserListItemResponse implements AdminUserListItem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty({ enum: PLATFORM_ROLES })
  role!: PlatformRole;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ enum: USER_STATUSES })
  status!: UserStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  restriction_expires_at!: string | null;

  @ApiProperty({ type: 'integer' })
  open_reports_against!: number;
}

export class AdminUserFiltersResponse {
  @ApiProperty({ type: String, nullable: true })
  search!: string | null;

  @ApiProperty({ enum: PLATFORM_ROLES, nullable: true })
  role!: PlatformRole | null;

  @ApiProperty({ enum: USER_STATUSES, nullable: true })
  status!: UserStatus | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  from!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  to!: string | null;

  @ApiProperty({ enum: [...LIST_SORTS, 'username'] })
  sort!: 'new' | 'oldest' | 'username';
}

export class AdminUserListResponse implements AdminUserList {
  @ApiProperty({ type: [AdminUserListItemResponse] })
  items!: AdminUserListItemResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ type: AdminUserFiltersResponse })
  filters!: AdminUserFiltersResponse;
}

export class AdminUserRestrictionSummaryResponse {
  @ApiProperty({ type: 'integer' })
  active!: number;

  @ApiProperty({ type: 'integer' })
  history_count!: number;
}

export class AdminUserDetailResponse
  extends AdminUserListItemResponse
  implements AdminUserDetail
{
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  last_seen_at!: string | null;

  @ApiProperty({ type: 'integer' })
  posts_count!: number;

  @ApiProperty({ type: 'integer' })
  comments_count!: number;

  @ApiProperty({ type: 'integer' })
  votes_count!: number;

  @ApiProperty({ type: 'integer' })
  communities_created!: number;

  @ApiProperty({ type: 'integer' })
  subscriptions_count!: number;

  @ApiProperty({ type: 'integer' })
  moderated_communities_count!: number;

  @ApiProperty(countsByKey(REPORT_STATUSES))
  reports_against!: Record<ReportStatus, number>;

  @ApiProperty({ type: 'integer' })
  reports_filed_count!: number;

  @ApiProperty({ type: AdminUserRestrictionSummaryResponse })
  restrictions!: AdminUserRestrictionSummaryResponse;
}

// Restrictions

export class AdminRestrictionResponse implements AdminRestriction {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: RESTRICTION_TYPES })
  type!: RestrictionType;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  created_by_username!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null for bans.',
  })
  expires_at!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lifted_at!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lifted_by_username!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lift_reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  report_id!: string | null;

  @ApiProperty({ description: 'Not lifted and not expired.' })
  active!: boolean;
}

export class AdminRestrictionListResponse implements AdminRestrictionList {
  @ApiProperty({ type: [AdminRestrictionResponse] })
  items!: AdminRestrictionResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

// Reports

export class AdminReportListItemResponse implements AdminReportListItem {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when the reporter account was deleted.',
  })
  reporter_username!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The account the report concerns: the account itself, or the author of ' +
      'the content. Null for a community report, or when the account was ' +
      'hard-deleted.',
  })
  reported_username!: string | null;

  @ApiProperty({ enum: REPORT_TARGET_TYPES })
  target_type!: ReportTargetType;

  @ApiProperty()
  target_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The username, community name, post title or comment excerpt. Null when ' +
      'the target no longer exists.',
  })
  target_label!: string | null;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: ReportReason;

  @ApiProperty({ enum: REPORT_STATUSES })
  status!: ReportStatus;

  @ApiProperty({ enum: REPORT_RESOLUTIONS, nullable: true })
  resolution!: string | null;

  @ApiProperty()
  has_context!: boolean;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewed_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the reporter withdrew the report; null while it stands. A ' +
      'withdrawn report cannot be transitioned.',
  })
  withdrawn_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The administrator who owns the work on this report, not necessarily ' +
      'who decides it (that is the reviewer). Null when unassigned, ' +
      'including after the assignee account was deleted.',
  })
  assigned_to_username!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the current assignee took the report. Null when unassigned.',
  })
  assigned_at!: string | null;
}

export class AdminReportFiltersResponse {
  @ApiProperty({ enum: REPORT_STATUSES, nullable: true })
  status!: ReportStatus | null;

  @ApiProperty({ enum: REPORT_REASONS, nullable: true })
  reason!: ReportReason | null;

  @ApiProperty({ enum: REPORT_TARGET_TYPES, nullable: true })
  target_type!: ReportTargetType | null;

  @ApiProperty({ type: String, nullable: true })
  reported_username!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reporter_username!: string | null;

  @ApiProperty({ enum: REPORT_WITHDRAWN_FILTERS })
  withdrawn!: ReportWithdrawnFilter;

  @ApiProperty({ enum: REPORT_ASSIGNED_FILTERS })
  assigned!: ReportAssignedFilter;

  @ApiProperty({ type: String, nullable: true })
  assigned_to!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  from!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  to!: string | null;

  @ApiProperty({ enum: LIST_SORTS })
  sort!: 'new' | 'oldest';
}

export class AdminReportListResponse implements AdminReportList {
  @ApiProperty({ type: [AdminReportListItemResponse] })
  items!: AdminReportListItemResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ type: AdminReportFiltersResponse })
  filters!: AdminReportFiltersResponse;
}

export class AdminReportContextResponse {
  @ApiProperty({ enum: ['post', 'comment'] })
  type!: ReportContextType;

  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'False when the content has been deleted.' })
  exists!: boolean;

  @ApiProperty({ type: String, nullable: true })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true })
  content_excerpt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  author_username!: string | null;
}

// The content a post or comment report is about, in full.
export class AdminReportTargetContentResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The post title; null for a comment.',
  })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true })
  content!: string | null;

  @ApiProperty({ description: 'Whether a moderator has removed the content.' })
  removed!: boolean;
}

export class AdminPriorResolutionResponse {
  @ApiProperty({ enum: REPORT_RESOLUTIONS, nullable: true })
  resolution!: string | null;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class AdminReportDetailResponse
  extends AdminReportListItemResponse
  implements AdminReportDetail
{
  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resolution_note!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reviewed_by_username!: string | null;

  @ApiProperty({ type: AdminReportContextResponse, nullable: true })
  context!: AdminReportContextResponse | null;

  @ApiProperty({
    type: AdminReportTargetContentResponse,
    nullable: true,
    description:
      'Null for a user or community report, or when the content no longer exists.',
  })
  target_content!: AdminReportTargetContentResponse | null;

  @ApiProperty({ type: 'integer' })
  open_reports_against_user!: number;

  @ApiProperty({ type: 'integer' })
  total_reports_against_user!: number;

  @ApiProperty({ type: [AdminPriorResolutionResponse] })
  prior_resolutions_against_user!: AdminPriorResolutionResponse[];
}

// The live queue. Counts and one timestamp only: no report id, username or
// other per-row datum.
export class ReportQueueStatsMetaResponse {
  @ApiProperty({
    type: 'object',
    description: 'Every figure is point_in_time: the queue as it stands.',
    properties: Object.fromEntries(
      Object.keys(REPORT_QUEUE_STATS_SCOPES).map((key) => [
        key,
        { type: 'string', enum: ['point_in_time'] },
      ]),
    ),
    required: Object.keys(REPORT_QUEUE_STATS_SCOPES),
  })
  scopes!: Record<string, MetricScope>;
}

export class ReportQueueStatsResponse implements ReportQueueStats {
  @ApiProperty({
    type: 'integer',
    description: 'Open reports, as the queue shows them (not withdrawn).',
  })
  open!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Reports under review, as the queue shows them.',
  })
  under_review!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Open reports with no assignee: the triage number.',
  })
  unassigned_open!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Open reports assigned to you.',
  })
  assigned_to_me_open!: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Open reports their reporter withdrew. Not in any other figure, and ' +
      'not work: a withdrawn report cannot be transitioned.',
  })
  withdrawn_open!: number;

  @ApiProperty({
    ...countsByKey(REPORT_REASONS),
    description:
      'Open reports per reason; every reason present, summing to open.',
  })
  by_reason!: Record<ReportReason, number>;

  @ApiProperty({
    ...countsByKey(REPORT_TARGET_TYPES),
    description:
      'Open reports per target type; every type present, summing to open.',
  })
  by_target_type!: Record<ReportTargetType, number>;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the oldest open report was filed; null when none is open.',
  })
  oldest_open_at!: string | null;

  @ApiProperty({ type: ReportQueueStatsMetaResponse })
  meta!: ReportQueueStatsMetaResponse;
}

// Audit log

export class AdminActionItemResponse implements AdminActionItem {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    description: 'Snapshot kept after the actor account is deleted.',
  })
  actor_username!: string;

  @ApiProperty({ type: String, nullable: true })
  actor_id!: string | null;

  @ApiProperty({ enum: ADMIN_ACTIONS })
  action!: AdminAction;

  @ApiProperty({ enum: ADMIN_ACTION_TARGETS })
  target_type!: AdminActionTarget;

  @ApiProperty()
  target_id!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Allowlisted, action-specific details.',
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class AdminActionFiltersResponse {
  @ApiProperty({ type: String, nullable: true })
  actor_username!: string | null;

  @ApiProperty({ enum: ADMIN_ACTIONS, nullable: true })
  action!: AdminAction | null;

  @ApiProperty({ enum: ADMIN_ACTION_TARGETS, nullable: true })
  target_type!: AdminActionTarget | null;

  @ApiProperty({ type: String, nullable: true })
  target_id!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  from!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  to!: string | null;

  @ApiProperty({ enum: LIST_SORTS })
  sort!: 'new' | 'oldest';
}

export class AdminActionListResponse implements AdminActionList {
  @ApiProperty({ type: [AdminActionItemResponse] })
  items!: AdminActionItemResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ type: AdminActionFiltersResponse })
  filters!: AdminActionFiltersResponse;
}

// Analytics

export class SeriesPointResponse implements SeriesPoint {
  @ApiProperty({
    description: 'UTC day (YYYY-MM-DD) or ISO week (YYYY-Www).',
  })
  bucket!: string;

  @ApiProperty({ type: 'integer' })
  count!: number;
}

export class UserAnalyticsTotalsResponse {
  @ApiProperty({ type: 'integer' })
  total_users!: number;

  @ApiProperty({ type: 'integer' })
  new_users!: number;

  @ApiProperty({ type: 'integer' })
  active_users!: number;

  @ApiProperty({ type: 'integer' })
  suspended_users!: number;

  @ApiProperty({ type: 'integer' })
  banned_users!: number;
}

export class UserAnalyticsSeriesResponse {
  @ApiProperty({ type: [SeriesPointResponse] })
  new_users!: SeriesPointResponse[];
}

export class UserAnalyticsMetaResponse {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  active_users_since!: string | null;

  @ApiProperty({ type: 'integer' })
  active_users_resolution_seconds!: number;

  @ApiProperty()
  active_users_is_floor!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', enum: ['point_in_time', 'range'] },
  })
  scopes!: Record<string, MetricScope>;
}

export class UserAnalyticsResponse implements UserAnalytics {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ enum: ['day', 'week'] })
  granularity!: AnalyticsGranularity;

  @ApiProperty({ format: 'date-time' })
  generated_at!: string;

  @ApiProperty({ type: UserAnalyticsTotalsResponse })
  totals!: UserAnalyticsTotalsResponse;

  @ApiProperty(countsByKey(PLATFORM_ROLES))
  users_by_role!: Record<PlatformRole, number>;

  @ApiProperty(countsByKey(RESTRICTION_TYPES))
  restrictions_applied!: Record<RestrictionType, number>;

  @ApiProperty({ type: UserAnalyticsSeriesResponse })
  series!: UserAnalyticsSeriesResponse;

  @ApiProperty({ type: UserAnalyticsMetaResponse })
  meta!: UserAnalyticsMetaResponse;
}

export class ModerationAnalyticsTotalsResponse {
  @ApiProperty({ type: 'integer' })
  reports_submitted!: number;

  @ApiProperty({ type: 'integer' })
  reports_reviewed!: number;

  @ApiProperty({ type: 'integer' })
  restrictions_lifted!: number;
}

export class ModerationPointInTimeResponse {
  @ApiProperty(countsByKey(REPORT_STATUSES))
  backlog_by_status!: Record<ReportStatus, number>;

  @ApiProperty({ type: 'integer', nullable: true })
  oldest_open_report_age_seconds!: number | null;
}

export class TimeToReviewResponse {
  @ApiProperty({ type: Number, nullable: true })
  average!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  maximum!: number | null;

  @ApiProperty({ type: 'integer' })
  count!: number;
}

export class ModerationAnalyticsSeriesResponse {
  @ApiProperty({ type: [SeriesPointResponse] })
  reports_submitted!: SeriesPointResponse[];
}

export class ModerationAnalyticsMetaResponse {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  time_basis!: Record<string, string>;
}

export class ModerationAnalyticsResponse implements ModerationAnalytics {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ enum: ['day', 'week'] })
  granularity!: AnalyticsGranularity;

  @ApiProperty({ format: 'date-time' })
  generated_at!: string;

  @ApiProperty({ type: ModerationAnalyticsTotalsResponse })
  totals!: ModerationAnalyticsTotalsResponse;

  @ApiProperty({ type: ModerationPointInTimeResponse })
  point_in_time!: ModerationPointInTimeResponse;

  @ApiProperty(countsByKey(REPORT_REASONS))
  reports_by_reason!: Record<ReportReason, number>;

  @ApiProperty(countsByKey([...REPORT_RESOLUTIONS, 'rejected']))
  resolutions_by_type!: Record<ReportResolution | 'rejected', number>;

  @ApiProperty({ type: TimeToReviewResponse })
  time_to_review_seconds!: TimeToReviewResponse;

  @ApiProperty(countsByKey(RESTRICTION_TYPES))
  restrictions_applied!: Record<RestrictionType, number>;

  @ApiProperty({ type: ModerationAnalyticsSeriesResponse })
  series!: ModerationAnalyticsSeriesResponse;

  @ApiProperty({ type: ModerationAnalyticsMetaResponse })
  meta!: ModerationAnalyticsMetaResponse;
}
