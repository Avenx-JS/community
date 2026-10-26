import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminUsersService } from './admin-users.service';
import { ListUsersDto } from './dto/list-users.dto';

@Controller('admin/users')
@UseGuards(AuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(private readonly usersService: AdminUsersService) {}

  @Get()
  findAll(@Query() query: ListUsersDto) {
    return this.usersService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.usersService.findOne(id);
  }
}
