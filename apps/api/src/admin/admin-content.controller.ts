import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import type { AdminAuthenticatedRequest } from '../auth/auth.guard';
import { RequiresRole } from '../auth/requires-role.decorator';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  AdminCommentDetailResponse,
  AdminCommentListResponse,
  AdminPostDetailResponse,
  AdminPostListResponse,
} from './admin-content.responses';
import { AdminContentService } from './admin-content.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  AdminReasonDto,
  ListAdminCommentsDto,
  ListAdminPostsDto,
} from './dto/admin-content.dto';

const EVERYWHERE =
  'Platform-wide: removed content and content in suspended and ' +
  'soft-deleted communities included, which every public route hides.';

const REMOVE =
  'Sets removed_by_admin: community moderators can no longer restore it ' +
  '(their restore answers 403). Content a moderator removed is taken over ' +
  'the same way. The author is notified (content_removed) without the ' +
  "reason or the administrator, unless a moderator's removal already told " +
  'them. Open community reports of the content are closed as removed. ' +
  'Requires a reason; recorded as an audit entry with it.';

const RESTORE =
  "Restores any removal, an administrator's or a community moderator's. " +
  'Requires a reason; recorded as an audit entry with it. No notification.';

// Addressed by id like every /admin route. The only routes that act on
// content in a suspended or deleted community, whose own moderators get 404.
@ApiTags('admin: content')
@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
@RequiresRole('admin')
export class AdminContentController {
  constructor(private readonly content: AdminContentService) {}

  @Get('posts')
  @ApiOperation({
    summary: 'List posts',
    description: `${EVERYWHERE} Newest first.`,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminPostListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findPosts(@Query() query: ListAdminPostsDto) {
    return this.content.findPosts(query);
  }

  @Get('posts/:id')
  @ApiOperation({
    summary: 'Get a post with its removal state',
    description: EVERYWHERE,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: AdminPostDetailResponse })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  findPost(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.content.findPost(id);
  }

  @Post('posts/:id/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a post as an administrator',
    description: REMOVE,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: AdminPostDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID, a missing or invalid reason, or any other property.',
    404: 'Post not found.',
    409: 'An administrator already removed the post.',
  })
  removePost(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AdminReasonDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.content.removePost(id, body, request.user.id);
  }

  @Post('posts/:id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a removed post', description: RESTORE })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiOkResponse({ type: AdminPostDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid post ID, a missing or invalid reason, or any other property.',
    404: 'Post not found.',
    409: 'The post is not removed.',
  })
  restorePost(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AdminReasonDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.content.restorePost(id, body, request.user.id);
  }

  @Get('comments')
  @ApiOperation({
    summary: 'List comments',
    description: `${EVERYWHERE} Newest first.`,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminCommentListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findComments(@Query() query: ListAdminCommentsDto) {
    return this.content.findComments(query);
  }

  @Get('comments/:id')
  @ApiOperation({
    summary: 'Get a comment with its removal state',
    description: EVERYWHERE,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: AdminCommentDetailResponse })
  @ApiErrorResponses({ 400: 'Invalid comment ID.', 404: 'Comment not found.' })
  findComment(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.content.findComment(id);
  }

  @Post('comments/:id/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a comment as an administrator',
    description: REMOVE,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: AdminCommentDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID, a missing or invalid reason, or any other property.',
    404: 'Comment not found.',
    409: 'An administrator already removed the comment.',
  })
  removeComment(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AdminReasonDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.content.removeComment(id, body, request.user.id);
  }

  @Post('comments/:id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a removed comment',
    description: `${RESTORE} Refused with 409 while the comment's post is removed.`,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: AdminCommentDetailResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID, a missing or invalid reason, or any other property.',
    404: 'Comment not found.',
    409: 'The comment is not removed, or its post is removed.',
  })
  restoreComment(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: AdminReasonDto,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.content.restoreComment(id, body, request.user.id);
  }
}
