import {
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { ListBlockedUsersDto } from './dto/list-blocked-users.dto';
import type { Page } from './user-activity.service';
import { BlockedUserListResponse } from './users.responses';
import { UserBlocksService, type BlockedUserDto } from './user-blocks.service';

// The caller's private block list. A controller of its own, so UsersController
// keeps its dependencies. Addressed by username, the identifier the listing
// returns, so what GET lists is what DELETE accepts.
@ApiTags('blocks')
@Controller('users/me/blocked')
export class UserBlocksController {
  constructor(private readonly blocks: UserBlocksService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List the accounts you have blocked',
    description:
      'Your own blocks only; no route exposes another user’s. Most recently ' +
      'blocked first. Deleted accounts are omitted.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: BlockedUserListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  list(
    @Query() query: ListBlockedUsersDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<Page<BlockedUserDto>> {
    return this.blocks.list(request.user.id, query);
  }

  @Post(':username')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Block an account',
    description:
      'Adds the account to your private block list. The blocked user is not ' +
      'told, and no route reveals it to them. Idempotent: blocking again ' +
      'keeps one block and its original time. Neither of you can then ' +
      "comment on, reply to or vote on the other's content, their " +
      'notifications leave your inbox, and each sees the other’s profile ' +
      'feeds as 404. Shared spaces, reporting and moderation are unaffected.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiNoContentResponse({ description: 'The account is blocked.' })
  @ApiErrorResponses({
    400: 'Invalid username, or your own account.',
    404: 'User not found.',
    409: 'You have reached the limit on blocked accounts.',
  })
  block(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.blocks.block(username, request.user.id);
  }

  @Delete(':username')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unblock an account',
    description:
      'Removes the account from your block list. Idempotent: unblocking an ' +
      'account you have not blocked also returns 204.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiNoContentResponse({ description: 'The account is not blocked.' })
  @ApiErrorResponses({ 400: 'Invalid username.', 404: 'User not found.' })
  unblock(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.blocks.unblock(username, request.user.id);
  }
}
