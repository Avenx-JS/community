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
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { ListUserCommunitiesDto } from './dto/list-user-activity.dto';
import {
  UserFollowsService,
  type FollowListDto,
  type FollowStatusDto,
  type FollowUserDto,
} from './user-follows.service';

export class FollowUserResponse implements FollowUserDto {
  @ApiProperty()
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  display_name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatar_url!: string | null;

  @ApiProperty({ format: 'date-time' })
  followed_at!: string;
}

export class FollowListResponse implements FollowListDto {
  @ApiProperty({ type: [FollowUserResponse] })
  items!: FollowUserResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class FollowStatusResponse implements FollowStatusDto {
  @ApiProperty({ description: 'You follow the user.' })
  following!: boolean;

  @ApiProperty({ description: 'The user follows you.' })
  followed_by!: boolean;
}

const username = () => new SafeRouteParamPipe('username');
const BLOCKED =
  'Either account has blocked the other; the body ({ "reason": "user_blocked" }) does not say which.';
const LISTS =
  'Public, newest first. Never a deleted account; for a signed-in caller, ' +
  'never an account blocked by or blocking the caller. An invalid token ' +
  'reads as anonymous. Follow lists are public: a hide_follow_lists ' +
  'preference is a follow-up.';

// Following accounts across every community (migration 047). Posts of
// followed accounts in GET /feed are a follow-up.
@ApiTags('users')
@Controller('users')
export class UserFollowsController {
  constructor(private readonly follows: UserFollowsService) {}

  @Post(':username/follow')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Follow a user',
    description:
      'Idempotent. The user is notified (new_follower) the first time, ' +
      'unless their notify_new_followers preference is off; unfollowing ' +
      'and following again notifies no one. Rate-limited per account ' +
      '(API_FOLLOW_ACCOUNT_*, 60 an hour).',
  })
  @ApiAuthenticated({ forbidden: BLOCKED })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiNoContentResponse({ description: 'You follow the user.' })
  @ApiErrorResponses({
    400: 'Invalid username, or yourself.',
    404: 'User not found or deleted.',
  })
  follow(
    @Param('username', username()) target: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.follows.follow(target, request.user.id);
  }

  @Delete(':username/follow')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unfollow a user',
    description: 'Idempotent: 204 also when you do not follow the user.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiNoContentResponse({ description: 'You do not follow the user.' })
  @ApiErrorResponses({
    400: 'Invalid username.',
    404: 'User not found or deleted.',
  })
  unfollow(
    @Param('username', username()) target: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.follows.unfollow(target, request.user.id);
  }

  @Get(':username/followers')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: "List a user's followers", description: LISTS })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: FollowListResponse })
  @ApiErrorResponses({
    400: 'Invalid username or query.',
    404: 'User not found or deleted.',
  })
  followers(
    @Param('username', username()) target: string,
    @Query() query: ListUserCommunitiesDto,
    @Req() request: OptionallyAuthenticatedRequest,
  ) {
    return this.follows.list('followers', target, request.user?.id, query);
  }

  @Get(':username/following')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'List whom a user follows', description: LISTS })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: FollowListResponse })
  @ApiErrorResponses({
    400: 'Invalid username or query.',
    404: 'User not found or deleted.',
  })
  following(
    @Param('username', username()) target: string,
    @Query() query: ListUserCommunitiesDto,
    @Req() request: OptionallyAuthenticatedRequest,
  ) {
    return this.follows.list('following', target, request.user?.id, query);
  }

  @Get(':username/follow-status')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Whether you and a user follow each other',
    description: 'Both false for yourself.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: FollowStatusResponse })
  @ApiErrorResponses({
    400: 'Invalid username.',
    404: 'User not found or deleted.',
  })
  status(
    @Param('username', username()) target: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.follows.status(target, request.user.id);
  }
}
