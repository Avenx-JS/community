import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminRestrictionsService } from './admin-restrictions.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  AdminRestrictionListResponse,
  AdminRestrictionResponse,
} from './admin.responses';
import { CreateRestrictionDto } from './dto/create-restriction.dto';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { ListRestrictionsDto } from './dto/list-restrictions.dto';

@ApiTags('admin: restrictions')
@ApiRouteParam('id', 'id', 'User ID.')
@Controller('admin/users/:id/restrictions')
@UseGuards(AuthGuard, AdminGuard)
export class AdminRestrictionsController {
  constructor(private readonly restrictionsService: AdminRestrictionsService) {}

  @Get()
  @ApiOperation({
    summary: "List a user's restrictions",
    description: 'Newest first, including lifted and expired ones.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminRestrictionListResponse })
  @ApiErrorResponses({
    400: 'Invalid user ID or query parameters.',
    404: 'User not found.',
  })
  findAll(
    @Param('id', new SafeRouteParamPipe('id')) userId: string,
    @Query() query: ListRestrictionsDto,
  ) {
    return this.restrictionsService.findAll(userId, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Suspend or ban a user',
    description:
      'Suspensions require duration_hours; bans must omit it. Revokes the ' +
      "user's sessions.",
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not a platform administrator, is targeting their own ' +
      'account, or the target is an administrator.',
  })
  @ApiCreatedResponse({ type: AdminRestrictionResponse })
  @ApiErrorResponses({
    400: 'Invalid user ID or restriction data.',
    404: 'User or linked report not found.',
    409: 'The user already has an active restriction.',
  })
  apply(
    @Param('id', new SafeRouteParamPipe('id')) userId: string,
    @Body() body: CreateRestrictionDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.restrictionsService.apply(userId, body, request.user.id);
  }

  // POST rather than DELETE: the row is kept and annotated, and the lift
  // carries a required justification in its body.
  @Post(':restrictionId/lift')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lift a restriction',
    description: 'The restriction is kept and annotated, not deleted.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('restrictionId', 'id', 'Restriction ID.')
  @ApiOkResponse({ type: AdminRestrictionResponse })
  @ApiErrorResponses({
    400: 'Invalid IDs or lift data.',
    404: 'Restriction not found for this user.',
    409: 'The restriction has already been lifted.',
  })
  lift(
    @Param('id', new SafeRouteParamPipe('id')) userId: string,
    @Param('restrictionId', new SafeRouteParamPipe('id')) restrictionId: string,
    @Body() body: LiftRestrictionDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.restrictionsService.lift(
      userId,
      restrictionId,
      body,
      request.user.id,
    );
  }
}
