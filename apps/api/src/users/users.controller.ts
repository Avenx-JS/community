import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { AllowRestricted } from '../auth/allow-restricted.decorator';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { AccountDeletionService } from './account-deletion.service';
import {
  ListUserActivityDto,
  ListUserCommunitiesDto,
} from './dto/list-user-activity.dto';
import { UserActivityService } from './user-activity.service';
import { DeleteOwnAccountDto } from './dto/delete-own-account.dto';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { UsersService } from './users.service';
import {
  OwnProfileResponse,
  UserCommentListResponse,
  UserCommunityListResponse,
  UserPostListResponse,
  UserProfileResponse,
} from './users.responses';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accountDeletion: AccountDeletionService,
    private readonly userActivity: UserActivityService,
  ) {}

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

  // DELETE with a body rather than POST /users/me/delete: the resource is the
  // account itself, and the body only confirms the password. A client or
  // proxy that drops DELETE bodies gets a 400 and deletes nothing.
  // Deliberately not @AllowRestricted(): deletion must not be a way out of a
  // suspension or ban. The dedicated account:delete rate-limit buckets live in
  // AuthRateLimitService.enforceApiRequest.
  @Delete('me')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete the caller's own account",
    description:
      'Requires the current password. Anonymises the account rather than ' +
      'erasing it: posts, comments, votes, reports and restrictions are kept; ' +
      'the username is not released. Rate limited per IP and account per day.',
  })
  @ApiAuthenticated({
    unauthorized: 'Incorrect password.',
    forbidden: 'Restricted accounts cannot delete themselves.',
  })
  @ApiNoContentResponse({ description: 'The account is deleted.' })
  @ApiErrorResponses({
    400: 'Missing or malformed password, or an unknown property.',
    404: 'The account is already deleted.',
    409: 'The caller created a community that is not deleted and must delete or transfer it first.',
  })
  deleteOwnAccount(
    @Req() request: AuthenticatedRequest,
    @Body() body: DeleteOwnAccountDto,
  ): Promise<void> {
    return this.accountDeletion.deleteOwnAccount(
      request.user.id,
      body.password,
    );
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

  @Get(':username/posts')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "List a user's posts",
    description:
      'Newest first by default (sort=oldest reverses it), then by ID. Omits ' +
      'posts removed by moderators and posts in deleted or suspended ' +
      'communities.',
  })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: UserPostListResponse })
  @ApiErrorResponses({
    400: 'Invalid username or query parameters.',
    404: 'User not found.',
  })
  listUserPosts(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Query() query: ListUserActivityDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.userActivity.listPosts(username, query, request?.user?.id);
  }

  @Get(':username/comments')
  @ApiOperation({
    summary: "List a user's comments",
    description:
      'Flat comments with their post title and community name, newest first ' +
      'by default (sort=oldest reverses it), then by ID. Omits removed ' +
      'comments, comments on removed posts, and comments in deleted or ' +
      'suspended communities.',
  })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: UserCommentListResponse })
  @ApiErrorResponses({
    400: 'Invalid username or query parameters.',
    404: 'User not found.',
  })
  listUserComments(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Query() query: ListUserActivityDto,
  ) {
    return this.userActivity.listComments(username, query);
  }

  @Get(':username/communities')
  @ApiOperation({
    summary: 'List the communities a user visibly takes part in',
    description:
      'Communities the user created, moderates, or wrote a visible post or ' +
      'comment in, by name. A subscription alone is never listed, and no ' +
      'subscription date is returned. Omits deleted and suspended ' +
      'communities.',
  })
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiOkResponse({ type: UserCommunityListResponse })
  @ApiErrorResponses({
    400: 'Invalid username or query parameters.',
    404: 'User not found.',
  })
  listUserCommunities(
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Query() query: ListUserCommunitiesDto,
  ) {
    return this.userActivity.listCommunities(username, query);
  }
}
