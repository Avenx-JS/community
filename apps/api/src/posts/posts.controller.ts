import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
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
  CommentTombstoneResponse,
} from '../comments/comments.responses';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import { RemoveContentDto } from '../common/remove-content.dto';
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
import { UpdatePostDto } from './dto/update-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { PostsService } from './posts.service';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { COMMUNITY_BANNED_FORBIDDEN_DOC } from '../communities/community-ban-policy.service';
import { USER_BLOCKED_FORBIDDEN_DOC } from '../users/user-block-policy.service';
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
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'List posts',
    description:
      'Newest first, then by ID descending. With community_id, that ' +
      "community's pinned posts come first, most recently pinned first; the " +
      'unfiltered listing does not float pinned posts. With an optional ' +
      'bearer token, each post\u2019s saved flag reflects the caller.',
  })
  @ApiOkResponse({ type: PostListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(
    @Query() query: ListPostsDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.postsService.findAll(query, request?.user?.id);
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Create a post',
    description:
      'Link and media posts carry an HTTP(S) URL as content. Refused for an ' +
      'account banned from the community.',
  })
  @ApiAuthenticated({
    forbidden: `The caller has not accepted the community's current rules. ${COMMUNITY_BANNED_FORBIDDEN_DOC}`,
  })
  @ApiCreatedResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post data.',
    404: 'Community not found.',
  })
  create(@Body() body: CreatePostDto, @Req() request: AuthenticatedRequest) {
    return this.postsService.create(body, request.user.id);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Get a post',
    description:
      'Public. A post removed by a moderator is 404, except for its ' +
      "community's creator and moderators and for platform admins: with a " +
      'bearer token they receive the full post plus removed, removed_at, ' +
      'removed_by and removal_reason. An invalid token reads as anonymous.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found, or removed and the caller may not review it.',
  })
  findOne(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.postsService.findOne(id, request?.user?.id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Edit your post',
    description:
      'Author only: unlike DELETE /posts/{id}, moderators and the community ' +
      'creator may not edit. title and content are editable, each optional ' +
      'but at least one required; type is immutable, and content is ' +
      "validated against the post's stored type. Submitting the stored " +
      'values changes nothing and leaves edited_at unchanged. A locked post ' +
      'may still be edited. Not gated on rule acceptance.',
  })
  @ApiAuthenticated({
    forbidden: `Only the author may edit this content, and not while banned from the community: editing publishes, deleting does not. ${COMMUNITY_BANNED_FORBIDDEN_DOC}`,
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or post data, or a non-editable property.',
    404: 'Post not found, or its community is deleted or suspended.',
    409: 'The post was removed by a moderator.',
  })
  update(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdatePostDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.postsService.update(id, body, request.user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete your post',
    description:
      'Author only: a hard delete, with the comments and votes beneath it. ' +
      'Breaking change: community moderators and the creator now receive ' +
      '403 here; they remove posts reversibly with POST /posts/{id}/remove.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not the author. Moderators use POST /posts/{id}/remove.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is deleted.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.postsService.remove(id, request.user.id);
  }

  @Post(':id/remove')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a post (moderators)',
    description:
      'Reversible moderative removal: the post, its comments and votes are ' +
      'kept for review and restoration, and hidden from everyone but the ' +
      "community's creator and moderators and platform admins. Community " +
      'creator and moderators only; the author deletes with DELETE. The ' +
      'author is notified without the reason or the moderator.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller does not moderate this community (authors use DELETE).',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or reason, or an unknown property.',
    404: 'Post not found.',
    409: 'The post is already removed.',
  })
  removeContent(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: RemoveContentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.postsService.removeContent(id, body, request.user.id);
  }

  @Post(':id/restore')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a removed post (moderators)',
    description:
      'Clears the removal. Same authorisation as removing. No notification.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found.',
    409: 'The post is not removed.',
  })
  restore(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.postsService.restore(id, request.user.id);
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

  @Post(':id/lock')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lock a post',
    description:
      'Closes the post to new comments, for everyone including moderators; ' +
      'it stays readable, votable and editable by its author. Community ' +
      'creator and moderators only: the post author may not lock their own ' +
      'post (as for pinning, and unlike editing, which only the author may ' +
      'do). Idempotent: locking a locked post returns it unchanged, keeping ' +
      'locked_at.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: PostResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found.',
    409: 'The post was removed by a moderator.',
  })
  lock(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.postsService.lock(id, request.user.id);
  }

  @Delete(':id/lock')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unlock a post',
    description:
      'Reopens the post to new comments. Same authorisation as locking. ' +
      'Idempotent: unlocking an unlocked post also returns 204.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is not locked.' })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found.',
    409: 'The post was removed by a moderator.',
  })
  unlock(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.postsService.unlock(id, request.user.id);
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
      "community's current rules. Refused when the caller and the post's " +
      'author have blocked each other.',
  })
  @ApiAuthenticated({
    forbidden: `The caller has not accepted the community's current rules. ${COMMUNITY_BANNED_FORBIDDEN_DOC} ${USER_BLOCKED_FORBIDDEN_DOC}`,
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
  @UseGuards(OptionalAuthGuard)
  @ApiTags('comments')
  @ApiExtraModels(CommentResponse, CommentTombstoneResponse)
  @ApiOperation({
    summary: 'Get the comment thread of a post',
    description:
      'Public. Comments oldest first, with replies nested under parents. A ' +
      'comment removed by a moderator stays in place as a tombstone ' +
      '({ id, post_id, parent_id, created_at, removed: true, replies }) so ' +
      "its replies keep their place; the community's creator and " +
      'moderators and platform admins see it in full with its removal ' +
      'state. The thread of a removed post is 404 except for those reviewers.',
  })
  @ApiRouteParam('postId', 'id', 'Post ID.')
  @ApiOkResponse({ type: CommentThreadResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found, or removed and the caller may not review it.',
    413:
      'The thread exceeds the maximum number of comments; page it through ' +
      'GET /posts/{postId}/comments/top-level and GET /comments/{id}/replies.',
  })
  getComments(
    @Param('postId', new SafeRouteParamPipe('id')) postId: string,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.commentsService.findThread(postId, request?.user?.id);
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
    description:
      'Set parent_id to reply to a comment on the same post. Refused when ' +
      'the caller and the author it is directed at have blocked each other: ' +
      "the post's author for a comment, the parent comment's author for a " +
      'reply.',
  })
  @ApiAuthenticated({
    forbidden: `The caller has not accepted the community's current rules. ${COMMUNITY_BANNED_FORBIDDEN_DOC} ${USER_BLOCKED_FORBIDDEN_DOC}`,
  })
  @ApiRouteParam('postId', 'id', 'Post ID.')
  @ApiCreatedResponse({ type: CommentResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or comment data.',
    404: 'Post or parent comment not found.',
    409:
      'The post is locked, or a comment above the reply is locked (a lock ' +
      'binds moderators too), or the thread is nested too deeply.',
  })
  addComment(
    @Param('postId', new SafeRouteParamPipe('id')) postId: string,
    @Body() body: CreateCommentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.commentsService.create(postId, body, request.user.id);
  }
}
