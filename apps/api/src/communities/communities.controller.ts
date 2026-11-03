import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import {
  CommunityListResponse,
  CommunityMemberListResponse,
  CommunityModeratorListResponse,
  CommunityResponse,
  CommunityStatsResponse,
  NotificationPreferencesResponse,
  SubscriptionStatusResponse,
} from './communities.responses';
import { CommunitiesService } from './communities.service';
import { CommunityStatsService } from './community-stats.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { DeleteCommunityDto } from './dto/delete-community.dto';
import { ListCommunitiesDto } from './dto/list-communities.dto';
import { ListCommunityMembersDto } from './dto/list-community-members.dto';
import { ListCommunityModeratorsDto } from './dto/list-community-moderators.dto';
import { ManageModeratorDto } from './dto/manage-moderator.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NoQueryParamsGuard } from '../common/no-query-params.guard';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('communities')
@Controller('communities')
export class CommunitiesController {
  constructor(
    private readonly communitiesService: CommunitiesService,
    private readonly notificationPreferencesService: NotificationPreferencesService,
    private readonly communityStatsService: CommunityStatsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List communities',
    description: 'Newest first, then by ID descending.',
  })
  @ApiOkResponse({ type: CommunityListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListCommunitiesDto) {
    return this.communitiesService.findAll(query);
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Create a community',
    description: 'The authenticated user becomes its creator.',
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: CommunityResponse })
  @ApiErrorResponses({
    400: 'Invalid community data.',
    409: 'Community name already exists.',
  })
  create(
    @Body() body: CreateCommunityDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.create(body, request.user.id);
  }

  @Get(':name')
  @ApiOperation({ summary: 'Get a community by name' })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityResponse })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  findOne(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
  ) {
    return this.communitiesService.findOne(name);
  }

  @Patch(':name')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Edit a community',
    description:
      'Only the description is editable; an empty string clears it. name ' +
      'is the route key and published identity and cannot be changed; ' +
      'rules are published through PUT /communities/:name/rules. Records a ' +
      'community_updated moderation-log entry.',
  })
  @ApiAuthenticated({
    forbidden: 'Only the community creator may edit the community.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityResponse })
  @ApiErrorResponses({
    400: 'Invalid community name, empty body, unknown property (including name and rules), or an invalid description.',
    404: 'Community not found.',
  })
  update(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: UpdateCommunityDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.update(name, body, request.user.id);
  }

  // DELETE with a confirmation body, as DELETE /users/me takes: a client or
  // proxy that drops DELETE bodies gets a 400 and deletes nothing.
  @Delete(':name')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a community',
    description:
      'Requires the community name in the body as confirmation. A soft ' +
      'delete: the community disappears from every read, but no post, ' +
      'comment, subscription, moderator or rule is destroyed. There is no ' +
      'restore route. Records a community_deleted moderation-log entry.',
  })
  @ApiAuthenticated({
    forbidden: 'Only the community creator may delete the community.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The community is deleted.' })
  @ApiErrorResponses({
    400: 'Invalid community name, a missing or mismatched confirmation name, or an unknown property.',
    404: 'Community not found or already deleted.',
  })
  remove(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: DeleteCommunityDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.remove(name, body.name, request.user.id);
  }

  // Public: the figures a community advertises about itself. No time range:
  // an open range would make a public route an arbitrary aggregation service
  // over the whole content history; /admin/analytics is where ranges live.
  @Get(':name/stats')
  @UseGuards(NoQueryParamsGuard)
  @ApiOperation({
    summary: 'Get community statistics',
    description:
      'Public. Point-in-time counts plus fixed 7-day activity windows on ' +
      'the database clock; takes no query parameters. Counts only.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityStatsResponse })
  @ApiErrorResponses({
    400: 'Invalid community name, or any query parameter.',
    404: 'Community not found.',
  })
  getStats(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
  ) {
    return this.communityStatsService.get(name);
  }

  @Post(':name/subscribe')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Subscribe to a community',
    description: 'Idempotent.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The user is subscribed.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  subscribe(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.subscribe(name, request.user.id);
  }

  @Get(':name/subscription')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get your subscription to a community',
    description:
      'Answers 200 with subscribed: false when not subscribed; 404 is ' +
      'reserved for an unknown community.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: SubscriptionStatusResponse })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  findSubscription(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.getSubscription(name, request.user.id);
  }

  @Get(':name/notification-preferences')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get your notification preferences for a community',
    description:
      'Returns the effective settings; a community you never configured ' +
      'reports the defaults. Notifications are delivered only while ' +
      'subscribed.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: NotificationPreferencesResponse })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  getNotificationPreferences(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.notificationPreferencesService.get(name, request.user.id);
  }

  @Put(':name/notification-preferences')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Replace your notification preferences for a community',
    description:
      'Idempotent. Allowed without membership: the setting is stored but ' +
      'has no effect until you subscribe.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: NotificationPreferencesResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or preference data.',
    404: 'Community not found.',
  })
  updateNotificationPreferences(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: UpdateNotificationPreferencesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.notificationPreferencesService.update(
      name,
      request.user.id,
      body,
    );
  }

  @Delete(':name/subscribe')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unsubscribe from a community',
    description: 'Idempotent.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The user is not subscribed.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  unsubscribe(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.unsubscribe(name, request.user.id);
  }

  // Public governance information: who removed a post, whom to ask. A public
  // list is also a target list, but an unnameable moderator is worse, and
  // their actions are attributable through the moderation log.
  @Get(':name/moderators')
  @ApiOperation({
    summary: 'List the people who run a community',
    description:
      'Public. The creator is a separate top-level object on every page; ' +
      'items, total and paging cover appointed moderators only, oldest ' +
      'appointment first. Deleted accounts are omitted.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityModeratorListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found.',
  })
  listModerators(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListCommunityModeratorsDto,
  ) {
    return this.communitiesService.listModerators(name, query);
  }

  // A roster is a bulk extract of who belongs where, so only the people who
  // moderate the community may read it. The global read rate limits apply;
  // with limit capped at 100 no dedicated bucket is needed.
  @Get(':name/members')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List the members of a community',
    description:
      'Only the community creator and its moderators; platform ' +
      'administrators are not granted access. Lists subscriptions, newest ' +
      'first by default. An unknown community answers 404 before any 403.',
  })
  @ApiAuthenticated({
    forbidden:
      'Only the community creator or a moderator may list its members.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityMemberListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found.',
  })
  listMembers(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListCommunityMembersDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.listMembers(name, request.user.id, query);
  }

  @Post(':name/moderators')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Appoint a moderator',
    description:
      'Only the community creator may appoint, and only subscribed members ' +
      'can be appointed. Idempotent.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not the community creator, or the user is not a ' +
      'subscribed member.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The user is a moderator.' })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    404: 'Community or user not found.',
  })
  addModerator(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: ManageModeratorDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.addModerator(
      name,
      body.username,
      request.user.id,
    );
  }

  @Delete(':name/moderators')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a moderator',
    description: 'Only the community creator may remove. Idempotent.',
  })
  @ApiAuthenticated({ forbidden: 'The caller is not the community creator.' })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The user is not a moderator.' })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    404: 'Community not found.',
  })
  removeModerator(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: ManageModeratorDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.removeModerator(
      name,
      body.username,
      request.user.id,
    );
  }
}
