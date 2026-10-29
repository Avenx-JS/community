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
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  CommentResponse,
  CommentThreadResponse,
} from '../comments/comments.responses';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { PostListResponse, PostResponse } from './posts.responses';
import { CreateCommentDto } from '../comments/dto/create-comment.dto';
import { CommentsService } from '../comments/comments.service';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { PostsService } from './posts.service';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly commentsService: CommentsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List posts',
    description: 'Newest first, then by ID descending.',
  })
  @ApiOkResponse({ type: PostListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListPostsDto) {
    return this.postsService.findAll(query);
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Create a post',
    description: 'Link and media posts carry an HTTP(S) URL as content.',
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post data.',
    404: 'Community not found.',
  })
  create(@Body() body: CreatePostDto, @Req() request: AuthenticatedRequest) {
    return this.postsService.create(body, request.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a post' })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.postsService.findOne(id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a post',
    description:
      "Allowed for the author and for the post's community creator and " +
      'moderators.',
  })
  @ApiAuthenticated({ forbidden: 'The caller may not delete this post.' })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is deleted.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.postsService.remove(id, request.user.id);
  }

  @Get(':postId/comments')
  @ApiTags('comments')
  @ApiOperation({
    summary: 'Get the comment thread of a post',
    description: 'Comments oldest first, with replies nested under parents.',
  })
  @ApiRouteParam('postId', 'id', 'Post ID.')
  @ApiOkResponse({ type: CommentThreadResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found.',
    413: 'The thread exceeds the maximum number of comments.',
  })
  getComments(@Param('postId', new SafeRouteParamPipe('id')) postId: string) {
    return this.commentsService.findThread(postId);
  }

  @Post(':postId/comments')
  @UseGuards(AuthGuard)
  @ApiTags('comments')
  @ApiOperation({
    summary: 'Comment on a post',
    description: 'Set parent_id to reply to a comment on the same post.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('postId', 'id', 'Post ID.')
  @ApiCreatedResponse({ type: CommentResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or comment data.',
    404: 'Post or parent comment not found.',
  })
  addComment(
    @Param('postId', new SafeRouteParamPipe('id')) postId: string,
    @Body() body: CreateCommentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commentsService.create(postId, body, request.user.id);
  }
}
