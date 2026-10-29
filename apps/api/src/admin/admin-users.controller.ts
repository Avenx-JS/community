import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminUsersService } from './admin-users.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  AdminUserDetailResponse,
  AdminUserListResponse,
} from './admin.responses';
import { ListUsersDto } from './dto/list-users.dto';

@ApiTags('admin: users')
@Controller('admin/users')
@UseGuards(AuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly usersService: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'List user accounts' })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminUserListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListUsersDto) {
    return this.usersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user account with activity and history' })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'User ID.')
  @ApiOkResponse({ type: AdminUserDetailResponse })
  @ApiErrorResponses({ 400: 'Invalid user ID.', 404: 'User not found.' })
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.usersService.findOne(id);
  }
}
