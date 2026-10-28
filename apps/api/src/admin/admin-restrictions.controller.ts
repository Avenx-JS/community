import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminRestrictionsService } from './admin-restrictions.service';
import { CreateRestrictionDto } from './dto/create-restriction.dto';
import { LiftRestrictionDto } from './dto/lift-restriction.dto';
import { ListRestrictionsDto } from './dto/list-restrictions.dto';

@Controller('admin/users/:id/restrictions')
@UseGuards(AuthGuard, AdminGuard)
export class AdminRestrictionsController {
  constructor(private readonly restrictionsService: AdminRestrictionsService) {}

  @Get()
  findAll(
    @Param('id', new SafeRouteParamPipe('id')) userId: string,
    @Query() query: ListRestrictionsDto,
  ) {
    return this.restrictionsService.findAll(userId, query);
  }

  @Post()
  apply(
    @Param('id', new SafeRouteParamPipe('id')) userId: string,
    @Body() body: CreateRestrictionDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.restrictionsService.apply(userId, body, request.user.id);
  }

  // POST rather than DELETE: the row is kept and annotated, and the lift
  // carries a required justification in its body.
  @Post(':restrictionId/lift')
  @HttpCode(200)
  lift(
    @Param('id', new SafeRouteParamPipe('id')) userId: string,
    @Param('restrictionId', new SafeRouteParamPipe('id')) restrictionId: string,
    @Body() body: LiftRestrictionDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.restrictionsService.lift(
      userId,
      restrictionId,
      body,
      request.user.id,
    );
  }
}
