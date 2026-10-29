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
  NotificationListResponse,
  NotificationResponse,
  ReadAllNotificationsResponse,
  UnreadCountResponse,
} from './notifications.responses';

// The recipient is always request.user.id; no route accepts a recipient.
// The read routes stay reachable for suspended or banned accounts so they can
// read their moderation notifications; state-changing notification routes
// must not be marked @AllowRestricted(). See "Notifications" in README.md.
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly inboxService: NotificationInboxService) {}

  @Get()
  @AllowRestricted()
  @ApiOperation({
    summary: 'List your notifications',
    description: 'Newest first by default, then by ID.',
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
      'The cheap route for polling a badge; poll this, not the listing.',
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

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark all your notifications read',
    description:
      'Accepts no filters. Idempotent; already-read timestamps are kept.',
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
