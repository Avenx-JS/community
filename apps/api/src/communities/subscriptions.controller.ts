import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { SubscriptionListResponse } from './communities.responses';
import { CommunitiesService } from './communities.service';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';

@ApiTags('subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List your subscriptions',
    description:
      'Only the authenticated user; newest first, then by community ID ' +
      'descending. Reports membership only, not notification delivery.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: SubscriptionListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(
    @Query() query: ListSubscriptionsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.listSubscriptions(request.user.id, query);
  }
}
