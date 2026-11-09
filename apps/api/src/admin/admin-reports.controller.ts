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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminReportsService } from './admin-reports.service';
import { ADMIN_ONLY } from './admin.openapi';
import { NoQueryParamsGuard } from '../common/no-query-params.guard';
import {
  AdminReportDetailResponse,
  AdminReportListResponse,
  ReportQueueStatsResponse,
} from './admin.responses';
import { AssignReportDto } from './dto/assign-report.dto';
import { ListReportsDto } from './dto/list-reports.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';

// No @RequiresRole: AdminGuard's default (admin) applies to every route, and
// REPORT_ASSIGNEE_ROLES mirrors it. There are deliberately no /resolve or
// /dismiss routes: PATCH :id already performs both.
@ApiTags('admin: reports')
@Controller('admin/reports')
@UseGuards(AuthGuard, AdminGuard)
export class AdminReportsController {
  constructor(private readonly reportsService: AdminReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'List user reports',
    description:
      'Reports withdrawn by their reporter are left out unless `withdrawn` ' +
      'is `include` or `only`. `assigned=me` is your own queue; ' +
      '`assigned=none` lists unassigned reports.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminReportListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(
    @Query() query: ListReportsDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.reportsService.findAll(query, request.user.id);
  }

  // Must stay above GET :id: SafeRouteParamPipe('id') accepts "stats", so a
  // later declaration would answer with a confusing 404 for report "stats".
  // admin-reports.controller.spec.ts pins the order.
  @Get('stats')
  @UseGuards(NoQueryParamsGuard)
  @ApiOperation({
    summary: 'Count the live report queue',
    description:
      'The backlog as it stands: what is waiting, how it is spread, and the ' +
      'oldest open report. Takes no query parameters. Counts apply the ' +
      "queue's default visibility, so open equals the total of " +
      '`GET /admin/reports?status=open`. History over a window (submission ' +
      'rates, outcomes, review latency) is `GET /admin/analytics/moderation`.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: ReportQueueStatsResponse })
  @ApiErrorResponses({ 400: 'The route takes no query parameters.' })
  queueStats(@Req() request: AdminAuthenticatedRequest) {
    return this.reportsService.queueStats(request.user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a report with context and history',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: AdminReportDetailResponse })
  @ApiErrorResponses({ 400: 'Invalid report ID.', 404: 'Report not found.' })
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.reportsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change the status of a report',
    description:
      'open moves to under_review, resolved, or rejected; under_review ' +
      'moves to resolved or rejected. resolution is required only when ' +
      'resolving. A report withdrawn by its reporter cannot be transitioned. ' +
      'Assignment does not affect which transitions are allowed.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not a platform administrator, or filed or is the ' +
      'subject of this report.',
  })
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: AdminReportDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid report ID or status data.',
    404: 'Report not found.',
    409:
      'The report is in a terminal status, was withdrawn by its reporter, or ' +
      'changed concurrently.',
  })
  updateStatus(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdateReportStatusDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.reportsService.updateStatus(id, body, request.user.id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a report to an administrator',
    description:
      'Omit `username` to assign the report to yourself. Assigning a report ' +
      'that is already assigned hands it over; repeating the current ' +
      'assignment changes nothing and keeps `assigned_at`. Assignment never ' +
      'changes `status`: move the report to under_review with PATCH ' +
      'separately if wanted.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not a platform administrator, or the caller or the ' +
      'assignee filed or is the subject of this report.',
  })
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: AdminReportDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid report ID or body, or the assignee is not an administrator.',
    404: 'Report or user not found.',
    409: 'The report is resolved, rejected or withdrawn, or changed concurrently.',
  })
  assign(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AssignReportDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.reportsService.assign(id, body, request.user.id);
  }

  @Delete(':id/assign')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unassign a report',
    description:
      'Clears the assignee. Idempotent: an unassigned report also returns 204.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not a platform administrator, or filed or is the ' +
      'subject of this report.',
  })
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiNoContentResponse({ description: 'The report is unassigned.' })
  @ApiErrorResponses({
    400: 'Invalid report ID.',
    404: 'Report not found.',
    409: 'The report is resolved, rejected or withdrawn, or changed concurrently.',
  })
  unassign(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AdminAuthenticatedRequest,
  ): Promise<void> {
    return this.reportsService.unassign(id, request.user.id);
  }
}
