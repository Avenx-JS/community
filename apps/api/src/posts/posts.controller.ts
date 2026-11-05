import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
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
  CommentReplyListResponse,
  CommentResponse,
  CommentThreadResponse,
} from '../comments/comments.responses';
import { ListCommentRepliesDto } from '../comments/dto/list-comment-replies.dto';
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
import { CastVoteDto } from '../votes/dto/cast-vote.dto';
import {
  VoteResponse,
  VoteScoreResponse,
  VoteStateResponse,
} from '../votes/votes.responses';
import { VotesService } from '../votes/votes.service';

@ApiTags('posts')
@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly commentsService: CommentsService,
    private readonly votesService: VotesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List posts',
    description:
      'Newest first, then by ID descending. With community_id, that ' +
      "community's pinned posts come first, most recently pinned first; the " +
      'unfiltered listing does not float pinned posts.',
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

  @Post(':id/pin')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pin a post to the top of its community',
    description:
      "Only the post's community creator and moderators may pin; the post's " +
      'author may not (unlike deletion). Idempotent: pinning a pinned post ' +
      'returns it unchanged and keeps its original pinned_at.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found.',
    409: 'The community already has the maximum number of pinned posts, or the post was removed by a moderator.',
  })
  pin(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.postsService.pin(id, request.user.id);
  }

  @Delete(':id/pin')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unpin a post',
    description:
      "Only the post's community creator and moderators may unpin. " +
      'Idempotent: unpinning a post that is not pinned also returns 204.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is not pinned.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  unpin(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.postsService.unpin(id, request.user.id);
  }

  @Put(':id/vote')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiTags('votes')
  @ApiOperation({
    summary: 'Cast or change your vote on a post',
    description:
      "Idempotent: the caller's one vote on the post is set to value; " +
      'repeating the request leaves one vote. Requires acceptance of the ' +
      "community's current rules.",
  })
  @ApiAuthenticated({
    forbidden: "The caller has not accepted the community's current rules.",
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: VoteResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or vote data.',
    404: 'Post not found.',
  })
  castVote(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: CastVoteDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votesService.vote(
      { target_type: 'post', target_id: id, value: body.value },
      request.user.id,
    );
  }

  @Delete(':id/vote')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiTags('votes')
  @ApiOperation({
    summary: 'Withdraw your vote on a post',
    description:
      'Returns the score after the withdrawal. Idempotent: without a vote ' +
      'nothing is removed and the current score is returned. Not gated on ' +
      'rule acceptance.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: VoteScoreResponse })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  withdrawVote(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votesService.withdraw('post', id, request.user.id);
  }

  @Get(':id/vote')
  @UseGuards(AuthGuard)
  @ApiTags('votes')
  @ApiOperation({
    summary: 'Read your vote on a post',
    description:
      "The caller's own vote (null when they have none) and the post's score.",
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: VoteStateResponse })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  getVote(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votesService.state('post', id, request.user.id);
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
    413:
      'The thread exceeds the maximum number of comments; page it through ' +
      'GET /posts/{postId}/comments/top-level and GET /comments/{id}/replies.',
  })
  getComments(@Param('postId', new SafeRouteParamPipe('id')) postId: string) {
    return this.commentsService.findThread(postId);
  }

  @Get(':postId/comments/top-level')
  @ApiTags('comments')
  @ApiOperation({
    summary: "List a post's top-level comments",
    description:
      'Root comments only (no parent), oldest first by default (created_at, ' +
      'then id). Items are flat and carry a reply_count; page each subtree ' +
      'through GET /comments/{id}/replies. Together the two routes reach ' +
      'every comment of a thread of any size. Omits comments removed by ' +
      'moderators.',
  })
  @ApiRouteParam('postId', 'id', 'Post ID.')
  @ApiOkResponse({ type: CommentReplyListResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or query parameters.',
    404: 'Post not found, or its community is deleted.',
  })
  getTopLevelComments(
    @Param('postId', new SafeRouteParamPipe('id')) postId: string,
    @Query() query: ListCommentRepliesDto,
  ) {
    return this.commentsService.findTopLevel(postId, query);
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
