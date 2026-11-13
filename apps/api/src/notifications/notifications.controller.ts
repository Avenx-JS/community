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
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { ReadAllNotificationsDto } from './dto/read-all-notifications.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { NotificationInboxService } from './notification-inbox.service';
import {
  DeleteAllNotificationsResponse,
  NotificationListResponse,
  NotificationResponse,
  ReadAllNotificationsResponse,
  StreamTicketResponse,
  UnreadCountResponse,
} from './notifications.responses';
import { NotificationStreamService } from './notification-stream.service';

// The recipient is always request.user.id; no route accepts a recipient.
// The read routes stay reachable for suspended or banned accounts so they can
// read their moderation notifications; state-changing notification routes
// must not be marked @AllowRestricted(). See "Notifications" in README.md.
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly inboxService: NotificationInboxService,
    private readonly streams: NotificationStreamService,
  ) {}

  @Get()
  @AllowRestricted()
  @ApiOperation({
    summary: 'List your notifications',
    description:
      'Newest first by default, then by ID. Notifications caused by an ' +
      'account you have blocked, or that has blocked you, are left out; ' +
      'they are kept, and reappear if the block is lifted. Moderation ' +
      'notifications are never left out.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiOkResponse({ type: NotificationListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  list(
    @Query() query: ListNotificationsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inboxService.list(request.user.id, query);
  }

  // Must stay declared before ':id', which would otherwise capture it.
  @Get('unread-count')
  @AllowRestricted()
  @ApiOperation({
    summary: 'Count your unread notifications',
    description:
      'The cheap route for polling a badge; poll this, not the listing. ' +
      'Counts exactly what the listing shows, blocked actors left out.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiOkResponse({ type: UnreadCountResponse })
  unreadCount(@Req() request: AuthenticatedRequest) {
    return this.inboxService.unreadCount(request.user.id);
  }

  @Get(':id')
  @AllowRestricted()
  @ApiOperation({
    summary: 'Get one of your notifications',
    description: 'Does not mark it read.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiRouteParam('id', 'id', 'Notification ID.')
  @ApiOkResponse({ type: NotificationResponse })
  @ApiErrorResponses({
    400: 'Invalid notification ID.',
    404: 'Notification not found, or it belongs to another user.',
  })
  findOne(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inboxService.findOne(request.user.id, id);
  }

  // State-changing routes are deliberately not @AllowRestricted(): a
  // restricted account may read why it is restricted, but not write.

  // For EventSource clients, which cannot send the Authorization header to
  // GET /notifications/stream.
  @Post('stream-tickets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Get a ticket for the notification stream',
    description:
      'A single-use ticket, valid for NOTIFICATION_STREAM_TICKET_TTL_SECONDS ' +
      '(default 60), for GET /notifications/stream?ticket=…. Bound to the ' +
      'session of the token that asked for it: the stream ends with that ' +
      'session. Stored only as a hash. Not for suspended or banned accounts.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: StreamTicketResponse })
  streamTicket(@Req() request: AuthenticatedRequest) {
    return this.streams.mintTicket(request.user.id, request.accessToken);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all your notifications read',
    description:
      'Accepts no filters. Idempotent; already-read timestamps are kept. ' +
      'The notifications stay in the inbox; DELETE /notifications removes ' +
      'them instead.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: ReadAllNotificationsResponse })
  @ApiErrorResponses({ 400: 'A body or query parameter was supplied.' })
  markAllRead(
    @Body() _body: ReadAllNotificationsDto,
    @Query() _query: ReadAllNotificationsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inboxService.markAllRead(request.user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete all your notifications',
    description:
      'Empties your inbox: every notification of yours, read or unread, is ' +
      'deleted for good, including those hidden from you because of a ' +
      'block. Unlike POST /notifications/read-all, which keeps them and ' +
      'only marks them read. Idempotent: an empty inbox answers ' +
      '{ "deleted": 0 }. Accepts no filters.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: DeleteAllNotificationsResponse })
  @ApiErrorResponses({ 400: 'A body or query parameter was supplied.' })
  removeAll(
    @Body() _body: ReadAllNotificationsDto,
    @Query() _query: ReadAllNotificationsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inboxService.removeAll(request.user.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Mark one of your notifications read or unread',
    description:
      'Idempotent; marking an already-read notification read keeps its ' +
      'original read_at.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Notification ID.')
  @ApiOkResponse({ type: NotificationResponse })
  @ApiErrorResponses({
    400: 'Invalid notification ID or body.',
    404: 'Notification not found, or it belongs to another user.',
  })
  update(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdateNotificationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inboxService.setRead(request.user.id, id, body.read);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dismiss one of your notifications',
    description: 'Permanent; a dismissed notification cannot be recovered.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Notification ID.')
  @ApiNoContentResponse({ description: 'The notification was deleted.' })
  @ApiErrorResponses({
    400: 'Invalid notification ID.',
    404: 'Notification not found, or it belongs to another user.',
  })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.inboxService.remove(request.user.id, id);
  }
}
