import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { CommunityModerationActionListResponse } from './communities.responses';
import { CommunityModerationLogService } from './community-moderation-log.service';
import { ListCommunityModerationActionsDto } from './dto/list-community-moderation-actions.dto';

// Read-only by design: entries are written only by the moderation actions
// themselves, so this controller exposes no PATCH, PUT or DELETE route.
@ApiTags('community-moderation')
@Controller('communities/:name/moderation-log')
export class CommunityModerationLogController {
  constructor(
    private readonly moderationLogService: CommunityModerationLogService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List moderation actions in a community',
    description:
      'Newest first by default. Only the community creator and its ' +
      'moderators may read it; platform administrators are not granted ' +
      'access. An unknown community answers 404 before any 403.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller is neither the community creator nor a moderator.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityModerationActionListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found.',
  })
  findAll(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListCommunityModerationActionsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.moderationLogService.findAll(name, request.user.id, query);
  }
}
