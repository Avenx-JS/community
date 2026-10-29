import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { CreatedReportResponse } from './reports.responses';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Report a user',
    description:
      'Optionally names the post or comment that prompted the report.',
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: CreatedReportResponse })
  @ApiErrorResponses({
    400: 'Invalid report data, target, or context.',
    404: 'Reported user or context not found.',
    409: 'An active report against this user already exists.',
  })
  create(@Body() body: CreateReportDto, @Req() request: AuthenticatedRequest) {
    return this.reportsService.create(body, request.user.id);
  }
}
