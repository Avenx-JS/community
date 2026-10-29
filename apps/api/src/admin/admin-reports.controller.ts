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
import { AdminReportsService } from './admin-reports.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  AdminReportDetailResponse,
  AdminReportListResponse,
} from './admin.responses';
import { ListReportsDto } from './dto/list-reports.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';

@ApiTags('admin: reports')
@Controller('admin/reports')
@UseGuards(AuthGuard, AdminGuard)
export class AdminReportsController {
  constructor(private readonly reportsService: AdminReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List user reports' })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminReportListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListReportsDto) {
    return this.reportsService.findAll(query);
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
      'resolving.',
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
    409: 'The report is in a terminal status or changed concurrently.',
  })
  updateStatus(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdateReportStatusDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.reportsService.updateStatus(id, body, request.user.id);
  }
}
