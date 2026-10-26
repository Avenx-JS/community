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
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminReportsService } from './admin-reports.service';
import { ListReportsDto } from './dto/list-reports.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';

@Controller('admin/reports')
@UseGuards(AuthGuard, AdminGuard)
export class AdminReportsController {
  constructor(private readonly reportsService: AdminReportsService) {}

  @Get()
  findAll(@Query() query: ListReportsDto) {
    return this.reportsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.reportsService.findOne(id);
  }

  @Patch(':id')
  updateStatus(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdateReportStatusDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.reportsService.updateStatus(id, body, request.user.id);
  }
}
