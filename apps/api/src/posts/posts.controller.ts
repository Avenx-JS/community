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
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { PostsService } from './posts.service';

@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findAll(@Query() query: ListPostsDto) {
    return this.postsService.findAll(query);
  }

  @Post()
  @UseGuards(AuthGuard)
  create(@Body() body: CreatePostDto, @Req() request: AuthenticatedRequest) {
    return this.postsService.create(body, request.user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.postsService.findOne(id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.postsService.remove(id, request.user.id);
  }

  @Get(':postId/comments')
  getComments(@Param('postId') postId: string) {
    return { message: 'Not implemented' };
  }

  @Post(':postId/comments')
  addComment(@Param('postId') postId: string, @Body() body: any) {
    return { message: 'Not implemented' };
  }
}
