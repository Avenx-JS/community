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
import { CreateCommentDto } from '../comments/dto/create-comment.dto';
import { CommentsService } from '../comments/comments.service';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { PostsService } from './posts.service';

@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly commentsService: CommentsService,
  ) {}

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
    return this.commentsService.findThread(postId);
  }

  @Post(':postId/comments')
  @UseGuards(AuthGuard)
  addComment(
    @Param('postId') postId: string,
    @Body() body: CreateCommentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commentsService.create(postId, body, request.user.id);
  }
}
