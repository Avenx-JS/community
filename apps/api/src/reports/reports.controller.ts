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
    summary: 'Report a user, post, comment or community',
    description:
      '**Breaking change:** the `username` field is gone; send `target_type` ' +
      'and `target` instead. `target` is a username for `user`, a community ' +
      'name for `community`, and an ID for `post` and `comment`. ' +
      '`context_type` and `context_id` are only allowed for a `user` target. ' +
      'Removed content and deleted or suspended communities can still be ' +
      "reported, and accepting a community's rules is not required.",
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: CreatedReportResponse })
  @ApiErrorResponses({
    400:
      'Invalid report data, a target that does not match its type, context on ' +
      'a non-user target, or your own account, content or community.',
    404: 'Target or context not found.',
    409: 'You already have an active report about this target.',
  })
  create(@Body() body: CreateReportDto, @Req() request: AuthenticatedRequest) {
    return this.reportsService.create(body, request.user.id);
  }
}
