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
  findOne(@Param('name') name: string) {
    return this.communitiesService.findOne(name);
  }

  @Post(':name/subscribe')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  subscribe(
    @Param('name') name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.subscribe(name, request.user.id);
  }

  @Delete(':name/subscribe')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  unsubscribe(
    @Param('name') name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.communitiesService.unsubscribe(name, request.user.id);
  }
}
