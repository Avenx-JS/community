import { Controller, Get, Param } from '@nestjs/common';
import { UsersService } from './users.service';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':username')
  getUserProfile(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
  ) {
    return this.usersService.getUserProfile(username);
  }
}
