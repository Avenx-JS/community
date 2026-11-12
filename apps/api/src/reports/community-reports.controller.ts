import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { RemoveContentDto } from '../common/remove-content.dto';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  CommunityReportDetailResponse,
  CommunityReportListResponse,
  ModQueueResponse,
} from './community-reports.responses';
import { CommunityReportsService } from './community-reports.service';
import {
  ListCommunityReportsDto,
  ListModQueueDto,
} from './dto/community-reports.dto';

const MODERATORS_ONLY = {
  forbidden:
    "The caller is neither the community's creator nor one of its moderators. " +
    'Platform administrators review reports under /admin/reports.',
};
const NOT_FOUND = 'Community not found, deleted or suspended.';
const REPORT_NOT_FOUND =
  "Community not found, deleted or suspended; or the report is not this community's, or was withdrawn.";

// The community level of reports about its posts and comments (migration
// 036). Administrators keep their own queue (/admin/reports), which these
// decisions never close. No modmail: see "Community report review" in the
// README.
@ApiTags('community-moderation')
@Controller('communities/:name')
export class CommunityReportsController {
  constructor(private readonly reports: CommunityReportsService) {}

  @Get('modqueue')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "List a community's moderation queue",
    description:
      'One entry per reported post or comment, gathering all its open ' +
      'reports: counts, reasons and the reports themselves, never who filed ' +
      'them. Open means not yet approved or removed by a moderator and not ' +
      'withdrawn. Sorted by the oldest open report by default.',
  })
  @ApiAuthenticated(MODERATORS_ONLY)
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiOkResponse({ type: ModQueueResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: NOT_FOUND,
  })
  modQueue(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListModQueueDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reports.modQueue(name, request.user.id, query);
  }

  @Get('reports')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "List a community's reports",
    description:
      'One report per item, with its reason, its content, and how many open ' +
      'reports and reporters that content has. Open reports by default; ' +
      'status selects decided ones. Only reports about posts and comments ' +
      'reach a community: account and community reports are for platform ' +
      'administrators only.',
  })
  @ApiAuthenticated(MODERATORS_ONLY)
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiOkResponse({ type: CommunityReportListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: NOT_FOUND,
  })
  list(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListCommunityReportsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reports.list(name, request.user.id, query);
  }

  @Get('reports/:id')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get a community report with its context',
    description:
      'The report, its content, the other open reports of that content, ' +
      'and the moderator who closed it.',
  })
  @ApiAuthenticated(MODERATORS_ONLY)
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: CommunityReportDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or report ID.',
    404: REPORT_NOT_FOUND,
  })
  findOne(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reports.findOne(name, request.user.id, id);
  }

  @Post('reports/:id/approve')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve reported content',
    description:
      'The content is fine: it stays visible, and every open report of it ' +
      'is closed as approved, so it leaves the queue. Logged as ' +
      'report_approved. The administrators’ review is not affected.',
  })
  @ApiAuthenticated(MODERATORS_ONLY)
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: CommunityReportDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or report ID.',
    404: REPORT_NOT_FOUND,
    409: 'The report is already closed.',
  })
  approve(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reports.approve(name, request.user.id, id);
  }

  @Post('reports/:id/remove')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove reported content',
    description:
      'Removes the post or comment, as POST /posts/{id}/remove or ' +
      'POST /comments/{id}/remove would (the author is notified, ' +
      'post_removed or comment_removed is logged), and closes every open ' +
      'report of it as removed (report_removed), in one transaction. ' +
      'Content already removed only has its reports closed.',
  })
  @ApiAuthenticated(MODERATORS_ONLY)
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: CommunityReportDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name, report ID or reason.',
    404: REPORT_NOT_FOUND,
    409:
      'The report is already closed, or its content no longer exists ' +
      '(approve it to close it).',
  })
  remove(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: RemoveContentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.reports.remove(name, request.user.id, id, body);
  }
}
