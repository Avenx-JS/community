import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
} from './dto/admin-communities.dto';

// Addressed by id like every /admin route, unlike the public :name routes:
// an administrator arrives from a report or an audit entry holding an id.
// There is deliberately no suspend or restore route here; those ship with
// the enforcement that makes suspension mean something.
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
}
