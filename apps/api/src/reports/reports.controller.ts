import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { AuthGuard } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  CreatedReportResponse,
  OwnReportListResponse,
  OwnReportResponse,
} from './reports.responses';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { CreateReportDto } from './dto/create-report.dto';
import { ListOwnReportsDto } from './dto/list-own-reports.dto';
import { ReportsService } from './reports.service';
import type { OwnReportDto, OwnReportList } from './reports.service';

// Every route takes its reporter from the token, like GET /notifications. The
// caller's own reports live here rather than under /users/me/reports, which is
// deliberately not added as a second path to the same collection.
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

  // Declared before GET :id. There is no literal-segment route under /reports;
  // one added later must be declared above GET :id or :id will capture it.
  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List the reports you have filed',
    description:
      'Your own reports only, newest first. Shows where each report is in ' +
      'the queue (`status`) and never the outcome: no resolution, moderator ' +
      'note, reviewer or review time. Withdrawn reports are included, with ' +
      '`withdrawn_at` set.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: OwnReportListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  listOwn(
    @Query() query: ListOwnReportsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<OwnReportList> {
    return this.reportsService.listOwn(request.user.id, query);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get one of your reports',
    description:
      'Another reporter’s report answers 404, exactly like an unknown ID.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiOkResponse({ type: OwnReportResponse })
  @ApiErrorResponses({
    400: 'Invalid report ID.',
    404: 'Report not found, or not yours.',
  })
  findOwn(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<OwnReportDto> {
    return this.reportsService.findOwn(id, request.user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Withdraw one of your reports',
    description:
      'Marks the report withdrawn; the report itself is kept. Only an open ' +
      'report can be withdrawn. A withdrawn report leaves the moderation ' +
      'queue, and you may report the same target again. Nobody is notified.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Report ID.')
  @ApiNoContentResponse({ description: 'The report is withdrawn.' })
  @ApiErrorResponses({
    400: 'Invalid report ID.',
    404: 'Report not found, or not yours.',
    409: 'The report is under review, closed, or already withdrawn.',
  })
  withdraw(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.reportsService.withdraw(id, request.user.id);
  }
}
