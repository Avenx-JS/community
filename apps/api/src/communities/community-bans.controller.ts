import {
  Body,
  Controller,
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
  ApiCreatedResponse,
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
import {
  CommunityBanListResponse,
  CommunityBanResponse,
} from './communities.responses';
import { CommunityBansService } from './community-bans.service';
import {
  CreateCommunityBanDto,
  LiftCommunityBanDto,
  ListCommunityBansDto,
} from './dto/community-ban.dto';

const MODERATORS_ONLY =
  'The caller is not the community creator or one of its moderators.';
const ENFORCED =
  ' The account is then refused subscribing, posting, commenting, voting ' +
  'and editing in this community; reading, reporting, leaving and deleting ' +
  'its own content stay open.';

// Bans exclude an account from one community. They are not platform
// restrictions (/admin/restrictions) and never touch them. Users are
// addressed by username, the identifier the listing returns.
@ApiTags('community-bans')
@Controller('communities')
@UseGuards(AuthGuard)
export class CommunityBansController {
  constructor(private readonly bans: CommunityBansService) {}

  @Get(':name/bans')
  @ApiOperation({
    summary: "List a community's bans",
    description:
      'Creator and moderators only: the list is a moderation record and is ' +
      'never public. Newest first; `active` defaults to bans in force now.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityBanListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found.',
  })
  list(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListCommunityBansDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bans.list(name, request.user.id, query);
  }

  @Post(':name/bans')
  @ApiOperation({
    summary: 'Ban an account from the community',
    description:
      'Excludes the account from this community only; it is not a platform ' +
      'restriction. Omit `duration_hours` for a permanent ban. Deletes the ' +
      "account's membership; rule acceptances are kept. Only the creator " +
      'may ban a moderator, and doing so also removes the moderator role. A ' +
      'platform administrator can be banned like anyone else.' +
      ENFORCED,
  })
  @ApiAuthenticated({
    forbidden: `${MODERATORS_ONLY} Also: banning the community creator, or a moderator when the caller is not the creator.`,
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiCreatedResponse({ type: CommunityBanResponse })
  @ApiErrorResponses({
    400: 'Invalid body, an unknown property, or banning yourself.',
    404: 'Community or user not found.',
    409: 'The account is already banned from this community.',
  })
  ban(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: CreateCommunityBanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bans.ban(name, body, request.user.id);
  }

  // POST .../lift rather than DELETE, as for platform restrictions: the ban
  // row is updated, never deleted, and a body with a reason is expected.
  @Post(':name/bans/:username/lift')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Lift a ban',
    description:
      "Closes the account's open bans in this community, including one that " +
      'has already expired. Does not restore membership: the account rejoins ' +
      'with POST /communities/:name/subscribe.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiNoContentResponse({ description: 'The ban is lifted.' })
  @ApiErrorResponses({
    400: 'Invalid name, username or body.',
    404: 'Community or user not found, or the user was never banned here.',
    409: 'Every ban of the user here has already been lifted.',
  })
  lift(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Body() body: LiftCommunityBanDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.bans.lift(name, username, body, request.user.id);
  }

  @Post(':name/members/:username/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member without banning',
    description:
      'Ends the membership only; the account may rejoin at once. Creates no ' +
      'ban. Idempotent: removing a non-member also returns 204. A moderator ' +
      'must lose the role (DELETE /communities/:name/moderators) first.',
  })
  @ApiAuthenticated({
    forbidden: `${MODERATORS_ONLY} Also: removing the community creator, or a moderator when the caller is not the creator.`,
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('username', 'username', 'Exact username.')
  @ApiNoContentResponse({ description: 'The account is not a member.' })
  @ApiErrorResponses({
    400: 'Invalid name or username, or removing yourself.',
    404: 'Community or user not found.',
    409: 'The account is a moderator; remove the role first.',
  })
  removeMember(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.bans.removeMember(name, username, request.user.id);
  }
}
