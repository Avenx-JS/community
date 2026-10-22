import {
  Body,
  Controller,
  Delete,
  Get,
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
  subscribe(@Param('name') name: string) {
    return { message: 'Not implemented' };
  }

  @Delete(':name/subscribe')
  unsubscribe(@Param('name') name: string) {
    return { message: 'Not implemented' };
  }
}
