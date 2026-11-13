import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
  ErrorResponse,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { CreatePushSubscriptionDto } from './dto/push-subscription.dto';
import {
  PushSubscriptionListResponse,
  PushSubscriptionResponse,
} from './notifications.responses';
import { PushSubscriptionsService } from './web-push/push-subscriptions.service';

// The caller's Web Push subscriptions: one per browser that should receive
// notifications while the site is closed.
@ApiTags('notifications')
@Controller('users/me/push-subscriptions')
@UseGuards(AuthGuard)
export class PushSubscriptionsController {
  constructor(private readonly subscriptions: PushSubscriptionsService) {}

  @Post()
  @ApiOperation({
    summary: 'Register a Web Push subscription',
    description:
      "The browser's PushSubscription.toJSON(), created with public_key from " +
      'GET /users/me/push-subscriptions as applicationServerKey. The endpoint ' +
      "must be https on one of the operator's push service hosts " +
      '(PUSH_ALLOWED_HOSTS). Registering the same endpoint again updates ' +
      'it, also under another account. At most ' +
      'PUSH_SUBSCRIPTIONS_PER_ACCOUNT (default 10) per account. Pushes ' +
      'follow your push_notifications preference and, for new posts, each ' +
      "community's notification preferences; a subscription the push " +
      'service reports gone (404, 410), or that keeps failing, is removed.',
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: PushSubscriptionResponse })
  @ApiErrorResponses({
    400: 'Invalid subscription: endpoint not an allowed push service, keys malformed, or expired.',
    409: 'The account has the most subscriptions allowed.',
  })
  @ApiServiceUnavailableResponse({
    type: ErrorResponse,
    description: 'Web Push is not configured on this server (no VAPID keys).',
  })
  register(
    @Body() body: CreatePushSubscriptionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.subscriptions.register(
      request.user.id,
      body,
      request.headers['user-agent'],
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List your Web Push subscriptions',
    description:
      'With whether push is enabled and the VAPID public key to subscribe ' +
      'with. Endpoints are shown by origin only.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: PushSubscriptionListResponse })
  list(@Req() request: AuthenticatedRequest) {
    return this.subscriptions.list(request.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a Web Push subscription' })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Subscription ID.')
  @ApiNoContentResponse({ description: 'The browser gets no more pushes.' })
  @ApiErrorResponses({
    400: 'Invalid subscription ID.',
    404: 'Subscription not found, or it belongs to another account.',
  })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.subscriptions.remove(request.user.id, id);
  }
}
