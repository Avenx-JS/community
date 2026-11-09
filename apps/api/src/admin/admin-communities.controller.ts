import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminCommunitiesService } from './admin-communities.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  AdminCommunityDetailResponse,
  AdminCommunityListResponse,
} from './admin.responses';
import {
  AdminUpdateCommunityDto,
  ListAdminCommunitiesDto,
  RestoreCommunityDto,
  SuspendCommunityDto,
} from './dto/admin-communities.dto';

// Addressed by id like every /admin route, unlike the public :name routes:
// an administrator arrives from a report or an audit entry holding an id.
// Suspension is enforced everywhere else by COMMUNITY_VISIBLE_PREDICATE;
// these routes are the only ones that still see a suspended community.
@ApiTags('admin: communities')
@Controller('admin/communities')
@UseGuards(AuthGuard, AdminGuard)
export class AdminCommunitiesController {
  constructor(private readonly communities: AdminCommunitiesService) {}

  @Get()
  @ApiOperation({
    summary: 'List communities',
    description:
      'Every community by default, including the suspended and soft-deleted ' +
      'ones the public listing hides. Newest first.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminCommunityListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListAdminCommunitiesDto) {
    return this.communities.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a community with moderation state and counts',
    description: 'Returned whether active, suspended or soft-deleted.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Community ID.')
  @ApiOkResponse({ type: AdminCommunityDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community ID.',
    404: 'Community not found.',
  })
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.communities.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: "Correct a community's description",
    description:
      'Overrides the creator, for content they will not or cannot fix. The ' +
      'description only: name and rules cannot be changed here. An empty ' +
      'or whitespace-only description clears it. Always recorded as a ' +
      '`community_updated` audit entry.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Community ID.')
  @ApiOkResponse({ type: AdminCommunityDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community ID, no description, or any other property (name and rules included).',
    404: 'Community not found.',
  })
  update(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AdminUpdateCommunityDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.communities.update(id, body, request.user.id);
  }

  // POST .../suspend and .../restore rather than DELETE, as for restrictions:
  // the row is updated, not deleted, and each call carries a required reason.
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend a community',
    description:
      'Takes the community offline for everyone but platform administrators, ' +
      'indefinitely: every public read and write answers 404, as for a ' +
      'deleted community, and its own moderators and creator lose their ' +
      'powers. Nothing is deleted. Requires a reason; there is no duration. ' +
      'Recorded as a community_suspended audit entry.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Community ID.')
  @ApiOkResponse({ type: AdminCommunityDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community ID, a missing or invalid reason, a duration, or any other property.',
    404: 'Community not found.',
    409: 'The community is already suspended, is deleted, or changed concurrently.',
  })
  suspend(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: SuspendCommunityDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.communities.suspend(id, body, request.user.id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a suspended community',
    description:
      'Makes the community public again exactly as it was. It does not ' +
      'undo anything done while suspended: removed content stays removed. ' +
      'Requires restore_reason. Recorded as a community_restored audit entry.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Community ID.')
  @ApiOkResponse({ type: AdminCommunityDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community ID, a missing or invalid restore_reason, or any other property.',
    404: 'Community not found.',
    409: 'The community is not suspended.',
  })
  restore(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: RestoreCommunityDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.communities.restore(id, body, request.user.id);
  }
}
