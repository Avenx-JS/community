import {
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { ContentRevisionsService } from './content-revisions.service';
import {
  HiddenPostListResponse,
  RevisionListResponse,
  SavedCommentListResponse,
  VotedListResponse,
} from './content-views.responses';
import {
  ListOwnContentDto,
  ListRevisionsDto,
  ListVotedDto,
} from './dto/own-content.dto';
import { HiddenPostsService } from './hidden-posts.service';
import { PostLabelsService, type PostLabel } from './post-labels.service';
import { SavedCommentsService } from './saved-comments.service';
import { VoteHistoryService } from './vote-history.service';

const id = () => new SafeRouteParamPipe('id');
const LABELLERS =
  'Not the author or a moderator of its community; or, removing, a label a moderator set and the caller is not a moderator.';
const LABEL_404 =
  'Post not found, in a deleted, suspended or (to a non-member) private community, or removed and the caller is not a moderator.';

// Labels, the reader's own view of content (hidden posts, saved comments,
// their votes) and edit history (migration 039), in controllers of their
// own, so PostsController and CommentsController keep their dependencies.
@ApiTags('posts')
@Controller('posts')
export class PostViewsController {
  constructor(
    private readonly labels: PostLabelsService,
    private readonly hidden: HiddenPostsService,
    private readonly revisions: ContentRevisionsService,
  ) {}

  private label(
    postId: string,
    label: PostLabel,
    set: boolean,
    request: AuthenticatedRequest,
  ): Promise<void> {
    return set
      ? this.labels.set(postId, label, request.user.id)
      : this.labels.clear(postId, label, request.user.id);
  }

  @Put(':id/nsfw')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Label a post NSFW',
    description:
      "The author or the community's creator and moderators. Idempotent. " +
      "A moderator's label can only be removed by a moderator.",
  })
  @ApiAuthenticated({ forbidden: LABELLERS })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is labelled NSFW.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: LABEL_404 })
  setNsfw(
    @Param('id', id()) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.label(postId, 'nsfw', true, request);
  }

  @Delete(':id/nsfw')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the NSFW label',
    description:
      'Idempotent. A label a moderator set only a moderator removes (403).',
  })
  @ApiAuthenticated({ forbidden: LABELLERS })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is not labelled NSFW.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: LABEL_404 })
  clearNsfw(
    @Param('id', id()) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.label(postId, 'nsfw', false, request);
  }

  @Put(':id/spoiler')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Label a post a spoiler',
    description:
      "The author or the community's creator and moderators. Idempotent. " +
      "A moderator's label can only be removed by a moderator.",
  })
  @ApiAuthenticated({ forbidden: LABELLERS })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is labelled a spoiler.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: LABEL_404 })
  setSpoiler(
    @Param('id', id()) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.label(postId, 'spoiler', true, request);
  }

  @Delete(':id/spoiler')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the spoiler label',
    description:
      'Idempotent. A label a moderator set only a moderator removes (403).',
  })
  @ApiAuthenticated({ forbidden: LABELLERS })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is not labelled a spoiler.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: LABEL_404 })
  clearSpoiler(
    @Param('id', id()) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.label(postId, 'spoiler', false, request);
  }

  @Post(':id/hide')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Hide a post',
    description:
      'Takes the post out of your GET /posts, /feed and ' +
      '/communities/{name}/posts; its permalink stays reachable. Private ' +
      'and idempotent.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is hidden for you.' })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found, removed, or not readable for you.',
  })
  hide(
    @Param('id', id()) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.hidden.hide(postId, request.user.id);
  }

  @Delete(':id/hide')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unhide a post',
    description: 'Idempotent; open for any existing post.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is not hidden for you.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  unhide(
    @Param('id', id()) postId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.hidden.unhide(postId, request.user.id);
  }

  @Get(':id/revisions')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "List a post's earlier versions",
    description:
      'current is the version shown now; items are earlier versions, most ' +
      'recently replaced first, each with when it was written and replaced. ' +
      'History is kept from migration 039: complete is false when older ' +
      'edits left nothing. Readable exactly as the post: a removed post ' +
      'only for its reviewers. An invalid token reads as anonymous.',
  })
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: RevisionListResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID or query parameters.',
    404: 'Post not found, deleted, not readable for the caller, or removed and the caller may not review it.',
  })
  postRevisions(
    @Param('id', id()) postId: string,
    @Query() query: ListRevisionsDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.revisions.forPost(postId, request?.user?.id, query);
  }
}

@ApiTags('comments')
@Controller('comments')
export class CommentViewsController {
  constructor(
    private readonly savedComments: SavedCommentsService,
    private readonly revisions: ContentRevisionsService,
  ) {}

  @Post(':id/save')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Save a comment',
    description:
      'Adds the comment to your private saved list, as POST ' +
      '/posts/{id}/save does for posts. Idempotent, keeping the first time.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiNoContentResponse({ description: 'The comment is saved.' })
  @ApiErrorResponses({
    400: 'Invalid comment ID.',
    404: 'Comment not found, removed, under a removed post, or not readable for you.',
  })
  saveComment(
    @Param('id', id()) commentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.savedComments.save(commentId, request.user.id);
  }

  @Delete(':id/save')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unsave a comment',
    description: 'Idempotent; open for any existing comment.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiNoContentResponse({ description: 'The comment is not saved.' })
  @ApiErrorResponses({ 400: 'Invalid comment ID.', 404: 'Comment not found.' })
  unsaveComment(
    @Param('id', id()) commentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.savedComments.unsave(commentId, request.user.id);
  }

  @Get(':id/revisions')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "List a comment's earlier versions",
    description:
      'As GET /posts/{id}/revisions; title is always null. A removed ' +
      'comment, or one under a removed post, only for its reviewers.',
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: RevisionListResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID or query parameters.',
    404: 'Comment not found, deleted, not readable for the caller, or removed and the caller may not review it.',
  })
  commentRevisions(
    @Param('id', id()) commentId: string,
    @Query() query: ListRevisionsDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.revisions.forComment(commentId, request?.user?.id, query);
  }
}

@ApiTags('users')
@Controller('users/me')
export class OwnContentController {
  constructor(
    private readonly hidden: HiddenPostsService,
    private readonly savedComments: SavedCommentsService,
    private readonly votes: VoteHistoryService,
  ) {}

  @Get('hidden-posts')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List your hidden posts',
    description:
      'Most recently hidden first by default. Posts since removed or no ' +
      'longer readable are omitted, their rows kept.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: HiddenPostListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  listHidden(
    @Query() query: ListOwnContentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hidden.list(request.user.id, query);
  }

  @Get('saved-comments')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List your saved comments',
    description:
      'Most recently saved first by default. Like saved posts: comments ' +
      'removed, under a removed post, or in a hidden community are ' +
      'omitted and their saves kept; a deleted comment takes its saves.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: SavedCommentListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  listSavedComments(
    @Query() query: ListOwnContentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.savedComments.list(request.user.id, query);
  }

  @Get('upvoted')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List what you upvoted',
    description:
      'Private. type=posts (default) or comments, most recent vote first. ' +
      'Removed content, content under a removed post, and content in a ' +
      'deleted, suspended or (no longer a member) private community are ' +
      'omitted.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: VotedListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  upvoted(@Query() query: ListVotedDto, @Req() request: AuthenticatedRequest) {
    return this.votes.list(request.user.id, 1, query);
  }

  @Get('downvoted')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List what you downvoted',
    description: 'As GET /users/me/upvoted, for downvotes.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: VotedListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  downvoted(
    @Query() query: ListVotedDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.votes.list(request.user.id, -1, query);
  }
}
