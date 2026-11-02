import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowRestricted } from '../auth/allow-restricted.decorator';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { UsersService } from './users.service';
import { OwnProfileResponse, UserProfileResponse } from './users.responses';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // The 'me' routes must stay above ':username', or Express would hand
  // /users/me to the public profile handler. Today SafeRouteParamPipe's
  // three-character minimum would turn that into a 400, hiding the mistake;
  // users.controller.spec.ts pins the order.
  @Get('me')
  @UseGuards(AuthGuard)
  // A suspended or banned account may still read its own record.
  @AllowRestricted()
  @ApiOperation({
    summary: "Get the caller's own account",
    description:
      "The only route that returns the caller's email and role. Never returns credentials, sessions or last_seen_at.",
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiOkResponse({ type: OwnProfileResponse })
  getOwnProfile(@Req() request: AuthenticatedRequest) {
    return this.usersService.getOwnProfile(request.user.id);
  }

  // Deliberately not @AllowRestricted(): a restricted account may read its
  // profile but not change it.
  @Patch('me')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Update the caller's display name and bio",
    description:
      'Absent fields are left unchanged; an empty string clears a field. username, email and role cannot be changed here.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: OwnProfileResponse })
  @ApiErrorResponses({
    400: 'Empty body, unknown property, or an invalid display_name or bio.',
  })
  updateOwnProfile(
    @Req() request: AuthenticatedRequest,
    @Body() body: UpdateOwnProfileDto,
  ) {
    return this.usersService.updateOwnProfile(request.user.id, body);
  }

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
