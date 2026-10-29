import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiRouteParam } from '../common/openapi';
import { UsersService } from './users.service';
import { UserProfileResponse } from './users.responses';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':username')
  @ApiOperation({ summary: 'Get a public user profile' })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: UserProfileResponse })
  @ApiErrorResponses({ 400: 'Invalid username.', 404: 'User not found.' })
  getUserProfile(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
  ) {
    return this.usersService.getUserProfile(username);
  }
}
