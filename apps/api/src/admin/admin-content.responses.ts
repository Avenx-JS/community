import { ApiProperty } from '@nestjs/swagger';
import { countsByKey } from '../common/openapi';
import type { PlatformRole } from '../users/users.service';
import {
  MEMBER_BUCKETS,
  POST_TYPES,
  type CommunityAnalytics,
  type ContentAnalytics,
  type MemberBucket,
  type MetricScope,
  type PostType,
} from './admin-analytics.service';
import type {
  AdminCommentDetail,
  AdminCommentListItem,
  AdminCommunityStateName,
  AdminPostDetail,
  AdminPostListItem,
  AdminRemoval,
} from './admin-content.service';
import {
  ELEVATED_ROLES,
  type AdminUserRoles,
  type ElevatedRole,
} from './admin-roles.service';
import { SeriesPointResponse } from './admin.responses';
import type { AnalyticsGranularity } from './analytics-range';
import {
  ADMIN_CONTENT_COMMUNITY_STATES,
  ADMIN_CONTENT_STATES,
  type AdminContentCommunityState,
  type AdminContentState,
} from './dto/admin-content.dto';

// Content

export class AdminRemovalResponse implements AdminRemoval {
  @ApiProperty({ format: 'date-time' })
  removed_at!: string;

  @ApiProperty({ type: String, nullable: true })
  removed_by_id!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Null once the remover's account is deleted.",
  })
  removed_by_username!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({
    enum: ['moderator', 'admin'],
    description:
      '`admin`: a platform administrator removed it, and community ' +
      'moderators cannot restore it. `moderator`: a community moderator ' +
      'or creator did.',
  })
  source!: 'moderator' | 'admin';
}

class AdminContentBaseResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  community_id!: string;

  @ApiProperty()
  community_name!: string;

  @ApiProperty({ enum: ['active', 'suspended', 'deleted'] })
  community_state!: AdminCommunityStateName;

  @ApiProperty()
  author_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Null once the author's account is deleted.",
  })
  author_username!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  edited_at!: string | null;

  @ApiProperty({ type: 'integer' })
  score!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  locked_at!: string | null;

  @ApiProperty({
    type: AdminRemovalResponse,
    nullable: true,
    description: 'Null while the content is visible.',
  })
  removal!: AdminRemovalResponse | null;
}

export class AdminPostListItemResponse
  extends AdminContentBaseResponse
  implements AdminPostListItem
{
  @ApiProperty()
  title!: string;

  @ApiProperty({ enum: ['text', 'link', 'media'] })
  type!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pinned_at!: string | null;
}

export class AdminPostDetailResponse
  extends AdminPostListItemResponse
  implements AdminPostDetail
{
  @ApiProperty({ type: String, nullable: true })
  content!: string | null;

  @ApiProperty({ type: 'integer' })
  upvotes!: number;

  @ApiProperty({ type: 'integer' })
  downvotes!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Every comment, removed ones included.',
  })
  comment_count!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Platform reports open or under review, not withdrawn.',
  })
  open_report_count!: number;
}

class AdminCommentFieldsResponse extends AdminContentBaseResponse {
  @ApiProperty()
  post_id!: string;

  @ApiProperty()
  post_title!: string;

  @ApiProperty({ description: "Whether the comment's post is removed." })
  post_removed!: boolean;

  @ApiProperty({ type: String, nullable: true })
  parent_id!: string | null;
}

export class AdminCommentListItemResponse
  extends AdminCommentFieldsResponse
  implements AdminCommentListItem
{
  @ApiProperty({ description: 'The first 200 characters of the content.' })
  excerpt!: string;
}

export class AdminCommentDetailResponse
  extends AdminCommentFieldsResponse
  implements AdminCommentDetail
{
  @ApiProperty()
  content!: string;

  @ApiProperty({ type: 'integer' })
  upvotes!: number;

  @ApiProperty({ type: 'integer' })
  downvotes!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Direct replies, removed ones included.',
  })
  reply_count!: number;

  @ApiProperty({ type: 'integer' })
  open_report_count!: number;
}

export class AdminContentFiltersResponse {
  @ApiProperty({ type: String, nullable: true })
  search!: string | null;

  @ApiProperty({ type: String, nullable: true })
  community_id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  author_username!: string | null;

  @ApiProperty({ enum: ADMIN_CONTENT_STATES })
  state!: AdminContentState;

  @ApiProperty({ enum: ADMIN_CONTENT_COMMUNITY_STATES })
  community_state!: AdminContentCommunityState;

  @ApiProperty({ enum: ['new', 'oldest'] })
  sort!: 'new' | 'oldest';
}

export class AdminCommentFiltersResponse extends AdminContentFiltersResponse {
  @ApiProperty({ type: String, nullable: true })
  post_id!: string | null;
}

export class AdminPostListResponse {
  @ApiProperty({ type: [AdminPostListItemResponse] })
  items!: AdminPostListItemResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ type: AdminContentFiltersResponse })
  filters!: AdminContentFiltersResponse;
}

export class AdminCommentListResponse {
  @ApiProperty({ type: [AdminCommentListItemResponse] })
  items!: AdminCommentListItemResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ type: AdminCommentFiltersResponse })
  filters!: AdminCommentFiltersResponse;
}

// Roles

export class AdminUserRolesResponse implements AdminUserRoles {
  @ApiProperty()
  user_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the account is deleted.',
  })
  username!: string | null;

  @ApiProperty({
    enum: ['user', 'moderator', 'admin'],
    description: 'The one platform role the account holds.',
  })
  role!: PlatformRole;

  @ApiProperty({
    enum: ELEVATED_ROLES,
    isArray: true,
    description:
      'The elevated roles held: empty for `user`, otherwise the one role. ' +
      'An account holds one platform role at a time.',
  })
  roles!: ElevatedRole[];
}

// Analytics

export class ContentAnalyticsTotalsResponse {
  @ApiProperty({ type: 'integer' })
  posts!: number;

  @ApiProperty({ type: 'integer' })
  comments!: number;

  @ApiProperty({ type: 'integer' })
  votes!: number;

  @ApiProperty({ type: 'integer' })
  posts_removed!: number;

  @ApiProperty({ type: 'integer' })
  comments_removed!: number;
}

export class ContentAnalyticsSeriesResponse {
  @ApiProperty({ type: [SeriesPointResponse] })
  posts!: SeriesPointResponse[];

  @ApiProperty({ type: [SeriesPointResponse] })
  comments!: SeriesPointResponse[];

  @ApiProperty({ type: [SeriesPointResponse] })
  votes!: SeriesPointResponse[];
}

export class ContentAnalyticsMetaResponse {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  time_basis!: Record<string, string>;
}

export class ContentAnalyticsResponse implements ContentAnalytics {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ enum: ['day', 'week'] })
  granularity!: AnalyticsGranularity;

  @ApiProperty({ format: 'date-time' })
  generated_at!: string;

  @ApiProperty({ type: ContentAnalyticsTotalsResponse })
  totals!: ContentAnalyticsTotalsResponse;

  @ApiProperty(countsByKey(POST_TYPES))
  posts_by_type!: Record<PostType, number>;

  @ApiProperty(countsByKey(['up', 'down']))
  votes_by_value!: { up: number; down: number };

  @ApiProperty(countsByKey(['moderator', 'admin']))
  removals_by_source!: { moderator: number; admin: number };

  @ApiProperty({ type: ContentAnalyticsSeriesResponse })
  series!: ContentAnalyticsSeriesResponse;

  @ApiProperty({ type: ContentAnalyticsMetaResponse })
  meta!: ContentAnalyticsMetaResponse;
}

export class CommunityAnalyticsTotalsResponse {
  @ApiProperty({ type: 'integer', description: 'Not deleted.' })
  total_communities!: number;

  @ApiProperty({ type: 'integer' })
  new_communities!: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Communities with a post, or a comment on their posts, created in ' +
      'the range.',
  })
  active_communities!: number;

  @ApiProperty({ type: 'integer' })
  suspended_communities!: number;

  @ApiProperty({ type: 'integer' })
  deleted_communities!: number;
}

export class CommunityAnalyticsSeriesResponse {
  @ApiProperty({ type: [SeriesPointResponse] })
  new_communities!: SeriesPointResponse[];
}

export class CommunityAnalyticsMetaResponse {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', enum: ['point_in_time', 'range'] },
  })
  scopes!: Record<string, MetricScope>;
}

export class CommunityAnalyticsResponse implements CommunityAnalytics {
  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ enum: ['day', 'week'] })
  granularity!: AnalyticsGranularity;

  @ApiProperty({ format: 'date-time' })
  generated_at!: string;

  @ApiProperty({ type: CommunityAnalyticsTotalsResponse })
  totals!: CommunityAnalyticsTotalsResponse;

  @ApiProperty({
    ...countsByKey(MEMBER_BUCKETS),
    description:
      'Communities not deleted, by member count. A distribution only: no ' +
      'community is named.',
  })
  members_distribution!: Record<MemberBucket, number>;

  @ApiProperty({ type: CommunityAnalyticsSeriesResponse })
  series!: CommunityAnalyticsSeriesResponse;

  @ApiProperty({ type: CommunityAnalyticsMetaResponse })
  meta!: CommunityAnalyticsMetaResponse;
}
