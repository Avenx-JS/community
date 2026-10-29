import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { CommunitiesService } from './communities.service';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  @Get()
  @UseGuards(AuthGuard)
  findAll(
    @Query() query: ListSubscriptionsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.listSubscriptions(request.user.id, query);
  }
}
