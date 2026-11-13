import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import { RequiresRole } from '../auth/requires-role.decorator';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminUserRolesResponse } from './admin-content.responses';
import { AdminRolesService, ELEVATED_ROLES } from './admin-roles.service';
import { AdminReasonDto, AssignRoleDto } from './dto/admin-content.dto';

const FORBIDDEN =
  'The caller is not a platform administrator, or the target is the caller: ' +
  'nobody changes their own role.';

// Explicitly administrators only: a platform moderator must never reach a
// route that hands out roles, whatever a future RequiresRole widening of
// other /admin routes does.
@ApiTags('admin: users')
@Controller('admin/users/:id/roles')
@UseGuards(AuthGuard, AdminGuard)
@RequiresRole('admin')
export class AdminRolesController {
  constructor(private readonly roles: AdminRolesService) {}

  @Get()
  @ApiOperation({
    summary: "Get an account's platform role",
    description:
      'An account holds exactly one platform role (`users.role`): `user`, ' +
      '`moderator` or `admin`. `roles` lists the elevated one, if any.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller is not a platform administrator.',
  })
  @ApiRouteParam('id', 'id', 'User ID.')
  @ApiOkResponse({ type: AdminUserRolesResponse })
  @ApiErrorResponses({ 400: 'Invalid user ID.', 404: 'User not found.' })
  find(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.roles.find(id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a platform role',
    description:
      'Sets `moderator` or `admin`, replacing the other elevated role if ' +
      'the account holds it. Taking `admin` away this way (admin to ' +
      'moderator) follows the rules of revoking it. A suspended or banned ' +
      'account cannot become an administrator. Requires a reason; recorded ' +
      'as a user_role_changed audit entry with from_role, to_role and reason.',
  })
  @ApiAuthenticated({ forbidden: FORBIDDEN })
  @ApiRouteParam('id', 'id', 'User ID.')
  @ApiOkResponse({ type: AdminUserRolesResponse })
  @ApiErrorResponses({
    400: 'Invalid user ID, a role other than moderator or admin, a missing or invalid reason, or any other property.',
    404: 'User not found.',
    409: 'The account already holds the role, is deleted, is restricted (for admin), or is the last administrator.',
  })
  assign(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AssignRoleDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.roles.assign(id, body.role, body.reason, request.user.id);
  }

  @Delete(':role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a platform role',
    description:
      'Returns the account to `user`. The last administrator cannot be ' +
      'revoked, and nobody revokes their own role. The reason goes in the ' +
      'JSON body. Recorded as a user_role_changed audit entry.',
  })
  @ApiAuthenticated({ forbidden: FORBIDDEN })
  @ApiRouteParam('id', 'id', 'User ID.')
  @ApiParam({ name: 'role', enum: ELEVATED_ROLES })
  @ApiOkResponse({ type: AdminUserRolesResponse })
  @ApiErrorResponses({
    400: 'Invalid user ID, a role other than moderator or admin, a missing or invalid reason, or any other property.',
    404: 'User not found, or the account does not hold the role.',
    409: 'The account is deleted, or is the last administrator.',
  })
  revoke(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Param('role') role: string,
    @Body() body: AdminReasonDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.roles.revoke(id, role, body.reason, request.user.id);
  }
}
