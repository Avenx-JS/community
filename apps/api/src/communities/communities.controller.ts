import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  CommunityResponse,
  NotificationPreferencesResponse,
  SubscriptionStatusResponse,
} from './communities.responses';
import { CommunitiesService } from './communities.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { ListCommunitiesDto } from './dto/list-communities.dto';
import { ManageModeratorDto } from './dto/manage-moderator.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('communities')
@Controller('communities')
export class CommunitiesController {
  constructor(
    private readonly communitiesService: CommunitiesService,
    private readonly notificationPreferencesService: NotificationPreferencesService,
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
