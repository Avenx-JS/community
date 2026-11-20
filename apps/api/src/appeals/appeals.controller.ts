import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ADMIN_ONLY } from '../admin/admin.openapi';
import { AdminGuard } from '../auth/admin.guard';
import { AllowRestricted } from '../auth/allow-restricted.decorator';
import {
  AuthGuard,
  type AdminAuthenticatedRequest,
  type AuthenticatedRequest,
} from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminAppealsService } from './admin-appeals.service';
import {
  AdminAppealDetailResponse,
  AdminAppealListResponse,
  AppealListResponse,
  AppealResponse,
} from './appeals.responses';
import { AppealsService } from './appeals.service';
import {
  CreateAppealDto,
  DecideAppealDto,
  ListAdminAppealsDto,
  ListOwnAppealsDto,
} from './dto/appeals.dto';

// Appeals of platform administrators' decisions (migration 048). A
// community moderator's decision is appealed to the community's moderators
// through modmail, never here.
@ApiTags('appeals')
@Controller()
@UseGuards(AuthGuard)
// The main use: a suspended or banned account appealing its restriction.
@AllowRestricted()
export class AppealsController {
  constructor(private readonly appeals: AppealsService) {}

  @Post('appeals')
  @ApiOperation({
    summary: 'Appeal a decision',
    description:
      "Appeals an administrator's decision that affects you: your " +
      'restriction (its id is in the login response while it is in force), ' +
      'the removal of your post or comment, or the suspension of a ' +
      'community you created. One appeal per decision, within ' +
      'APPEAL_WINDOW_DAYS (30) of it. Also available to suspended and ' +
      'banned accounts. Rate-limited per account (API_APPEAL_ACCOUNT_*, 5 ' +
      'a day).',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiCreatedResponse({ type: AppealResponse })
  @ApiErrorResponses({
    400: 'Invalid appeal data.',
    404: 'No such decision affecting you: another account’s is 404 too.',
    409:
      'The decision is no longer in force, was made more than ' +
      'APPEAL_WINDOW_DAYS ago, or has already been appealed; or it was a ' +
      'community moderator’s removal, with `{ "reason": ' +
      '"community_moderation", "community_name": … }`: appeal it to the ' +
      'community’s moderators through POST /communities/{name}/modmail.',
  })
  create(@Body() body: CreateAppealDto, @Req() request: AuthenticatedRequest) {
    return this.appeals.create(request.user.id, body);
  }

  @Get('users/me/appeals')
  @ApiOperation({
    summary: 'List your appeals',
    description:
      'Newest first, with their status and the decision note. Also ' +
      'available to suspended and banned accounts.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiOkResponse({ type: AppealListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  listOwn(
    @Query() query: ListOwnAppealsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.appeals.listOwn(request.user.id, query);
  }
}

@ApiTags('admin: appeals')
@Controller('admin/appeals')
@UseGuards(AuthGuard, AdminGuard)
export class AdminAppealsController {
  constructor(private readonly appeals: AdminAppealsService) {}

  @Get()
  @ApiOperation({
    summary: 'List appeals',
    description:
      'status open (the default) is the queue, oldest first; any other ' +
      'status, or any, is newest first. Each item has the user, the target ' +
      'and the original decision with its reason.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminAppealListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListAdminAppealsDto) {
    return this.appeals.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an appeal',
    description:
      'The appeal, the original decision, the affected restriction, post, ' +
      "comment or community as the admin routes show it, and the user's " +
      'other appeals.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Appeal ID.')
  @ApiOkResponse({ type: AdminAppealDetailResponse })
  @ApiErrorResponses({ 400: 'Invalid appeal ID.', 404: 'Appeal not found.' })
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.appeals.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Decide an appeal',
    description:
      'approved reverses the decision in the same transaction (lifts the ' +
      'restriction, restores the post or comment, or restores the ' +
      'community), unless it was reversed or replaced meanwhile; rejected ' +
      'keeps it. Both are audited (appeal_approved, appeal_rejected) and ' +
      'notify the user (appeal_decided) with decision_note.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not a platform administrator, or made the original ' +
      'decision or filed the appeal while another administrator exists.',
  })
  @ApiRouteParam('id', 'id', 'Appeal ID.')
  @ApiOkResponse({ type: AdminAppealDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid appeal ID or decision.',
    404: 'Appeal not found.',
    409:
      "The appeal has already been decided, or the comment's post is " +
      'removed (restore the post first).',
  })
  decide(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: DecideAppealDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.appeals.decide(id, body, request.user.id);
  }
}
