import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService, hashOpaqueToken } from '../auth/auth.service';
import { ErrorResponse } from '../common/openapi';
import { StreamQueryDto } from './dto/stream-query.dto';
import {
  NotificationStreamService,
  type StreamIdentity,
} from './notification-stream.service';

// The live channel, a controller of its own: it authenticates itself, by
// bearer token or by a single-use ticket (EventSource cannot send headers),
// and is registered before NotificationsController so that GET :id does not
// capture "stream".
@ApiTags('notifications')
@Controller('notifications')
export class NotificationStreamController {
  constructor(
    private readonly auth: AuthService,
    private readonly streams: NotificationStreamService,
  ) {}

  @Get('stream')
  @ApiProduces('text/event-stream')
  @ApiQuery({
    name: 'ticket',
    required: false,
    description:
      'Instead of the Authorization header: a ticket from POST ' +
      '/notifications/stream-tickets, valid once, for 60 seconds.',
  })
  @ApiOperation({
    summary: 'Stream your notifications (Server-Sent Events)',
    description:
      'Authenticated by the Authorization: Bearer header, or by ?ticket= ' +
      'for EventSource. A text/event-stream of your own notifications ' +
      'only. Events: ' +
      '`unread-count` (`{ "unread": n }`, on connecting and after every ' +
      'change), `notification` (the inbox DTO, `id:` its id) for each new ' +
      'one, and `end` (`{ "reason": "session_ended" | "replaced" | ' +
      '"shutdown" }`) before the server closes it. A comment line ' +
      '(`: ping`) every NOTIFICATION_STREAM_HEARTBEAT_SECONDS keeps proxies ' +
      'from timing it out. Notifications that existed when you connected ' +
      'are not sent: read the inbox, then follow the stream. The stream ' +
      'ends with its session (logout, session revoked, token expired), when ' +
      'the account is suspended, banned or deleted, and when the account ' +
      'opens more than NOTIFICATION_STREAMS_PER_ACCOUNT streams (the ' +
      'oldest gives way). Reconnect with a fresh token or ticket.',
  })
  @ApiOkResponse({
    description: 'The event stream.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description:
      'No token or ticket, or an invalid, expired, used or ended one.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponse,
    description: 'The account is suspended or banned.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'This instance holds NOTIFICATION_STREAMS_MAX streams.',
  })
  async stream(
    @Query() query: StreamQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const identity = await this.identify(request, query.ticket);
    if (this.streams.size >= this.streams.maxStreams) {
      throw new ServiceUnavailableException(
        'Too many open streams; retry later',
      );
    }
    await this.streams.open(identity, response);
  }

  private async identify(
    request: Request,
    ticket: string | undefined,
  ): Promise<StreamIdentity> {
    const bearer = /^Bearer\s+(\S+)$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (bearer) {
      const state = await this.auth.validateAccessTokenState(bearer);
      if (state.kind === 'restricted') {
        throw new ForbiddenException('The account is suspended or banned');
      }
      if (state.kind !== 'valid') {
        throw new UnauthorizedException('Invalid or expired token');
      }
      return { userId: state.userId, tokenHash: hashOpaqueToken(bearer) };
    }
    if (ticket) {
      const identity = await this.streams.redeemTicket(ticket);
      if (identity) {
        return identity;
      }
    }
    throw new UnauthorizedException(
      'A bearer token or a stream ticket is required',
    );
  }
}
