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
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  ListCommunityModmailDto,
  ListModmailDto,
  ModmailMessageBodyDto,
  StartModmailDto,
} from './dto/modmail.dto';
import {
  ModmailThreadDetailResponse,
  ModmailThreadListResponse,
} from './modmail.responses';
import { ModmailService } from './modmail.service';

const name = () => new SafeRouteParamPipe('communityName');
const id = () => new SafeRouteParamPipe('id');
const TEAM_ONLY =
  'The caller is not the community creator or a moderator of it.';
const OUT_OF_SCOPE =
  " Modmail is between a user and a community's moderator team; private " +
  'messages between users are out of scope.';

// The moderator team's side, and the one route a user writes to a team.
@ApiTags('modmail')
@Controller('communities/:name/modmail')
@UseGuards(AuthGuard)
export class CommunityModmailController {
  constructor(private readonly modmail: ModmailService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a modmail thread',
    description:
      "Without username, the caller writes to the community's moderator " +
      'team: a question, an application, or an appeal. Allowed while banned ' +
      'from the community, since that is the appeal path; not while ' +
      'suspended or banned from the platform. At most ' +
      'MODMAIL_THREADS_PER_DAY (3) new threads a day with one community, ' +
      'MODMAIL_BANNED_THREADS_PER_DAY (1) while banned from it. The team is ' +
      'notified. With username, a moderator or the creator starts a thread ' +
      'with any account (a warning, a question); the account is notified, ' +
      'and never learns which moderator wrote.' +
      OUT_OF_SCOPE,
  })
  @ApiAuthenticated({
    forbidden: `With username: ${TEAM_ONLY}`,
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiCreatedResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name, subject, body or username, or an unknown property; or a thread with yourself.',
    404: 'Community not found, deleted or suspended; or, with username, the account.',
    409: "Without username: the caller is on the community's moderator team.",
  })
  start(
    @Param('name', name()) community: string,
    @Body() body: StartModmailDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return body.username === undefined
      ? this.modmail.startAsUser(community, request.user.id, body)
      : this.modmail.startAsModerator(community, request.user.id, {
          username: body.username,
          subject: body.subject,
          body: body.body,
        });
  }

  @Get()
  @ApiOperation({
    summary: "List a community's modmail",
    description:
      'Moderator team only. ?status=open (default) or archived, the most ' +
      'recently active first.',
  })
  @ApiAuthenticated({ forbidden: TEAM_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: ModmailThreadListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query.',
    404: 'Community not found, deleted or suspended.',
  })
  list(
    @Param('name', name()) community: string,
    @Query() query: ListCommunityModmailDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.listCommunity(community, request.user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read a modmail thread',
    description:
      'Moderator team only. Each team message names its moderator ' +
      '(author_username), which the user never sees.',
  })
  @ApiAuthenticated({ forbidden: TEAM_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('id', 'id', 'Thread ID.')
  @ApiOkResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or thread ID.',
    404: 'Community or thread not found.',
  })
  get(
    @Param('name', name()) community: string,
    @Param('id', id()) threadId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.getCommunity(community, request.user.id, threadId);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply as the moderator team',
    description:
      'The user is notified; the reply shows to them as "moderators of ' +
      'c/<name>". Keeps the thread\'s status.',
  })
  @ApiAuthenticated({ forbidden: TEAM_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('id', 'id', 'Thread ID.')
  @ApiCreatedResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name, thread ID or body, or an unknown property.',
    404: 'Community or thread not found.',
  })
  reply(
    @Param('name', name()) community: string,
    @Param('id', id()) threadId: string,
    @Body() body: ModmailMessageBodyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.replyAsModerator(
      community,
      request.user.id,
      threadId,
      body.body,
    );
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a modmail thread',
    description:
      'Moderator team only. Idempotent. A later message from the user ' +
      'reopens it.',
  })
  @ApiAuthenticated({ forbidden: TEAM_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('id', 'id', 'Thread ID.')
  @ApiOkResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or thread ID.',
    404: 'Community or thread not found.',
  })
  archive(
    @Param('name', name()) community: string,
    @Param('id', id()) threadId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.setStatus(
      community,
      request.user.id,
      threadId,
      'archived',
    );
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reopen an archived modmail thread',
    description: 'Moderator team only. Idempotent.',
  })
  @ApiAuthenticated({ forbidden: TEAM_ONLY })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiRouteParam('id', 'id', 'Thread ID.')
  @ApiOkResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or thread ID.',
    404: 'Community or thread not found.',
  })
  unarchive(
    @Param('name', name()) community: string,
    @Param('id', id()) threadId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.setStatus(community, request.user.id, threadId, 'open');
  }
}

// The user's side. Open to suspended and banned accounts: a restricted
// user can still read and answer the threads they have, an appeal included.
@ApiTags('modmail')
@Controller('users/me/modmail')
@UseGuards(AuthGuard)
@AllowRestricted()
export class OwnModmailController {
  constructor(private readonly modmail: ModmailService) {}

  @Get()
  @ApiOperation({
    summary: 'List your modmail threads',
    description:
      'Every thread between you and a moderator team, the most recently ' +
      'active first, archived ones included. Open while suspended or banned.' +
      OUT_OF_SCOPE,
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiOkResponse({ type: ModmailThreadListResponse })
  @ApiErrorResponses({ 400: 'Invalid query.' })
  list(@Query() query: ListModmailDto, @Req() request: AuthenticatedRequest) {
    return this.modmail.listOwn(request.user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one of your modmail threads',
    description:
      'Team messages show as "moderators of c/<name>", never naming the ' +
      'moderator (author_username is null). Readable whatever the ' +
      "community's state: it is your record.",
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiRouteParam('id', 'id', 'Thread ID.')
  @ApiOkResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid thread ID.',
    404: 'Not found, or not your thread.',
  })
  get(
    @Param('id', id()) threadId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.getOwn(request.user.id, threadId);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply in one of your modmail threads',
    description:
      'The moderator team is notified. Reopens an archived thread. Open ' +
      'while suspended or banned from the platform, and while banned from ' +
      'the community.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiRouteParam('id', 'id', 'Thread ID.')
  @ApiCreatedResponse({ type: ModmailThreadDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid thread ID or body, or an unknown property.',
    404: 'Not found, or not your thread.',
    409: 'The community is deleted or suspended.',
  })
  reply(
    @Param('id', id()) threadId: string,
    @Body() body: ModmailMessageBodyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.modmail.replyAsUser(request.user.id, threadId, body.body);
  }
}
