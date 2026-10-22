import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { CommunitiesService } from './communities.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { ListCommunitiesDto } from './dto/list-communities.dto';
import { ManageModeratorDto } from './dto/manage-moderator.dto';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@Controller('communities')
export class CommunitiesController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  @Get()
  findAll(@Query() query: ListCommunitiesDto) {
    return this.communitiesService.findAll(query);
  }

  @Post()
  @UseGuards(AuthGuard)
  create(
    @Body() body: CreateCommunityDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communitiesService.create(body, request.user.id);
  }

  @Get(':name')
  findOne(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
  ) {
    return this.communitiesService.findOne(name);
  }

  @Post(':name/subscribe')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  subscribe(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.subscribe(name, request.user.id);
  }

  @Delete(':name/subscribe')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  unsubscribe(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.unsubscribe(name, request.user.id);
  }

  @Post(':name/moderators')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  addModerator(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: ManageModeratorDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.addModerator(
      name,
      body.username,
      request.user.id,
    );
  }

  @Delete(':name/moderators')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeModerator(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: ManageModeratorDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.removeModerator(
      name,
      body.username,
      request.user.id,
    );
  }
}
