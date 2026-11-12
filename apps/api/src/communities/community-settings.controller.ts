import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { COMMUNITY_BANNED_FORBIDDEN_DOC } from './community-ban-policy.service';
import { CommunityDiscoveryService } from './community-discovery.service';
import { CommunityFlairsService } from './community-flairs.service';
import { CommunityJoinRequestsService } from './community-join-requests.service';
import { CommunityModeratorInvitesService } from './community-moderator-invites.service';
import {
  AssignedFlairResponse,
  FlairListResponse,
  FlairResponse,
  JoinRequestResponse,
  ModeratorInviteListResponse,
  PendingJoinRequestListResponse,
  UserFlairResponse,
} from './community-settings.responses';
import {
  AssignFlairDto,
  AssignUserFlairDto,
  CreateFlairDto,
  ListFlairsDto,
  UpdateFlairDto,
} from './dto/community-flairs.dto';
import {
  CreateJoinRequestDto,
  InviteModeratorDto,
  ModeratorInviteTargetDto,
} from './dto/community-join-requests.dto';
import { ListCommunityModeratorsDto } from './dto/list-community-moderators.dto';

const MODERATORS_ONLY =
  'The caller is not the community creator or one of its moderators.';
const CREATOR_ONLY = 'The caller is not the community creator.';
const PRIVATE_403 =
  'The community is private and the caller is not a member (`{ "reason": "private_community" }`).';

const name = () => new SafeRouteParamPipe('communityName');

// Joining by request, moderator invitations, flairs and mutes: the people
// and labels of one community (migration 038).
@ApiTags('communities')
@Controller('communities/:name')
export class CommunitySettingsController {
  constructor(
    private readonly joinRequests: CommunityJoinRequestsService,
    private readonly invites: CommunityModeratorInvitesService,
    private readonly flairs: CommunityFlairsService,
    private readonly discovery: CommunityDiscoveryService,
  ) {}

  @Post('join-requests')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Ask to join a restricted or private community',
    description:
      'With an optional message to the moderators. One request per account ' +
      'and community: 409 while one is pending, for a member, for a public ' +
      'community (join it with POST /communities/{name}/subscribe), and ' +
      'within COMMUNITY_JOIN_REQUEST_RETRY_HOURS (default 168) of a denial. ' +
      "Requires the community's current rules to be accepted.",
  })
  @ApiAuthenticated({
    forbidden: `The caller has not accepted the community's current rules. ${COMMUNITY_BANNED_FORBIDDEN_DOC}`,
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiCreatedResponse({ type: JoinRequestResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or message.',
    404: 'Community not found.',
    409: 'Public community, already a member, a request pending, or denied recently.',
  })
  requestToJoin(
    @Param('name', name()) community: string,
    @Body() body: CreateJoinRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.joinRequests.create(community, request.user.id, body);
  }

  @Get('join-requests/me')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get your join request',
    description: 'Its status: pending, approved or denied.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: JoinRequestResponse })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found, or no request.',
  })
  ownJoinRequest(
    @Param('name', name()) community: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.joinRequests.findOwn(community, request.user.id);
  }

  @Get('join-requests')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List pending join requests',
    description: 'Creator and moderators only. Oldest first.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: PendingJoinRequestListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found.',
  })
  listJoinRequests(
    @Param('name', name()) community: string,
    @Query() query: ListCommunityModeratorsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.joinRequests.listPending(community, request.user.id, query);
  }

  @Post('join-requests/:username/approve')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Approve a join request',
    description:
      'Creator and moderators only. The account becomes a member at once. ' +
      'Logged as join_request_approved.',
  })
  @ApiAuthenticated({
    forbidden: `${MODERATORS_ONLY} Or the account has been banned since asking.`,
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('username', 'username', 'The account that asked.')
  @ApiNoContentResponse({ description: 'The account is a member.' })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    404: 'Community not found, or no pending request from this account.',
  })
  approve(
    @Param('name', name()) community: string,
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.joinRequests.approve(community, username, request.user.id);
  }

  @Post('join-requests/:username/deny')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deny a join request',
    description:
      'Creator and moderators only. Logged as join_request_denied; the ' +
      'account may ask again after COMMUNITY_JOIN_REQUEST_RETRY_HOURS.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('username', 'username', 'The account that asked.')
  @ApiNoContentResponse({ description: 'The request is denied.' })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    404: 'Community not found, or no pending request from this account.',
  })
  deny(
    @Param('name', name()) community: string,
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.joinRequests.deny(community, username, request.user.id);
  }

  @Post('moderators/invites')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Invite a member to moderate',
    description:
      'Creator only. Nobody becomes a moderator without accepting: the ' +
      'member sees the invitation in GET /users/me/moderator-invites and ' +
      'accepts or declines it. Only subscribed members, not banned, can be ' +
      'invited. Idempotent; logged as moderator_invited.',
  })
  @ApiAuthenticated({
    forbidden: `${CREATOR_ONLY} Or the user is not a subscribed member, or is banned.`,
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The invitation is pending.' })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    404: 'Community or user not found.',
    409: 'The user already moderates or created the community.',
  })
  invite(
    @Param('name', name()) community: string,
    @Body() body: InviteModeratorDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.invites.invite(community, body.username, request.user.id);
  }

  @Post('moderators/invites/accept')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Accept a moderator invitation',
    description:
      'The invited account becomes a moderator; the invitation is ' +
      'consumed. Logged as moderator_added.',
  })
  @ApiAuthenticated({ forbidden: COMMUNITY_BANNED_FORBIDDEN_DOC })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The caller is a moderator.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found, or no invitation.',
  })
  acceptInvite(
    @Param('name', name()) community: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.invites.accept(community, request.user.id);
  }

  @Delete('moderators/invites')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke or decline a moderator invitation',
    description:
      'With ?username= the creator revokes that invitation ' +
      '(moderator_invite_revoked); without it the caller declines their ' +
      'own (moderator_invite_declined). Idempotent.',
  })
  @ApiAuthenticated({ forbidden: `With username: ${CREATOR_ONLY}` })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'No such invitation remains.' })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    404: 'Community or user not found.',
  })
  withdrawInvite(
    @Param('name', name()) community: string,
    @Query() query: ModeratorInviteTargetDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.invites.withdraw(community, request.user.id, query.username);
  }

  @Get('flairs')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "List a community's flairs",
    description:
      'Post and user flairs, by kind then text. Public, except for a ' +
      'private community: members only.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: FlairListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or kind.',
    403: PRIVATE_403,
    404: 'Community not found.',
  })
  listFlairs(
    @Param('name', name()) community: string,
    @Query() query: ListFlairsDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.flairs.list(community, request?.user?.id, query);
  }

  @Post('flairs')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Create a flair',
    description:
      'Creator and moderators only. At most COMMUNITY_FLAIRS_MAX (default ' +
      '100) per community; the text is unique per kind.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiCreatedResponse({ type: FlairResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or flair.',
    404: 'Community not found.',
    409: 'The text exists already for this kind, or the community has the most flairs allowed.',
  })
  createFlair(
    @Param('name', name()) community: string,
    @Body() body: CreateFlairDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flairs.create(community, request.user.id, body);
  }

  @Patch('flairs/:id')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Edit a flair',
    description:
      'Creator and moderators only. text, background_color (null clears) ' +
      'and mod_only; the kind is fixed. Posts and members carrying it show ' +
      'the change at once.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('id', 'id', 'Flair ID.')
  @ApiOkResponse({ type: FlairResponse })
  @ApiErrorResponses({
    400: 'Invalid community name, flair ID or body.',
    404: 'Community or flair not found.',
    409: 'The text exists already for this kind.',
  })
  updateFlair(
    @Param('name', name()) community: string,
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdateFlairDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flairs.update(community, id, request.user.id, body);
  }

  @Delete('flairs/:id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a flair',
    description:
      'Creator and moderators only. Removed from every post and member ' +
      'carrying it.',
  })
  @ApiAuthenticated({ forbidden: MODERATORS_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('id', 'id', 'Flair ID.')
  @ApiNoContentResponse({ description: 'The flair is gone.' })
  @ApiErrorResponses({
    400: 'Invalid community name or flair ID.',
    404: 'Community or flair not found.',
  })
  deleteFlair(
    @Param('name', name()) community: string,
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.flairs.remove(community, id, request.user.id);
  }

  @Get('members/:username/flair')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "Get a member's user flair",
    description:
      'flair is null when the account has none here. Public, except for a private ' +
      'community: members only.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('username', 'username', 'The member.')
  @ApiOkResponse({ type: UserFlairResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or username.',
    403: PRIVATE_403,
    404: 'Community not found.',
  })
  getUserFlair(
    @Param('name', name()) community: string,
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.flairs.getUserFlair(community, username, request?.user?.id);
  }

  @Put('members/:username/flair')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Set a member's user flair",
    description:
      'A member sets their own from the user flairs not marked mod_only; ' +
      "the creator and moderators set any member's, to any user flair. " +
      '`{ "flair_id": null }` clears it. Answers `{ flair }`, null when cleared.',
  })
  @ApiAuthenticated({
    forbidden:
      "Another member's flair, or a mod_only flair, and the caller is not a moderator.",
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('username', 'username', 'The member.')
  @ApiOkResponse({ type: UserFlairResponse })
  @ApiErrorResponses({
    400: "Invalid community name, username, or not one of the community's user flairs.",
    404: 'Community or user not found.',
    409: 'The user is not a member.',
  })
  setUserFlair(
    @Param('name', name()) community: string,
    @Param('username', new SafeRouteParamPipe('username')) username: string,
    @Body() body: AssignUserFlairDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flairs.setUserFlair(
      community,
      username,
      body.flair_id,
      request.user.id,
    );
  }

  @Post('mute')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mute a community',
    description:
      'Idempotent. Its posts leave your feed and search, and it leaves ' +
      'trending and recommendations; its own page and your membership stay.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The community is muted.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  mute(
    @Param('name', name()) community: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.discovery.mute(community, request.user.id);
  }

  @Delete('mute')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unmute a community', description: 'Idempotent.' })
  @ApiAuthenticated()
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiNoContentResponse({ description: 'The community is not muted.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  unmute(
    @Param('name', name()) community: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.discovery.unmute(community, request.user.id);
  }
}

@ApiTags('posts')
@Controller('posts/:id/flair')
@UseGuards(AuthGuard)
export class PostFlairController {
  constructor(private readonly flairs: CommunityFlairsService) {}

  @Put()
  @ApiOperation({
    summary: "Set a post's flair",
    description:
      "The author picks one of the community's post flairs not marked " +
      'mod_only; the creator and moderators set any post flair.',
  })
  @ApiAuthenticated({
    forbidden:
      'Not the author or a moderator, or a mod_only flair and not a moderator.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: AssignedFlairResponse })
  @ApiErrorResponses({
    400: "Invalid post ID, or not one of the community's post flairs.",
    404: 'Post not found.',
  })
  set(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AssignFlairDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flairs.setPostFlair(id, body.flair_id, request.user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Clear a post's flair",
    description:
      'The author clears a flair they could have chosen; a mod_only flair ' +
      'only a moderator clears.',
  })
  @ApiAuthenticated({
    forbidden: 'Not the author or a moderator, or a mod_only flair.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post has no flair.' })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found.',
  })
  clear(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.flairs.clearPostFlair(id, request.user.id);
  }
}

@ApiTags('communities')
@Controller('users/me/moderator-invites')
@UseGuards(AuthGuard)
export class OwnModeratorInvitesController {
  constructor(private readonly invites: CommunityModeratorInvitesService) {}

  @Get()
  @ApiOperation({
    summary: 'List your moderator invitations',
    description:
      'Pending invitations to moderate, newest first. Accept with POST ' +
      '/communities/{name}/moderators/invites/accept, decline with DELETE ' +
      '/communities/{name}/moderators/invites.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: ModeratorInviteListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  list(
    @Query() query: ListCommunityModeratorsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.invites.listOwn(request.user.id, query);
  }
}
