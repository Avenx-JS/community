import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { CommentLocksService } from './comment-locks.service';
import { CommentReplyResponse } from './comments.responses';
import type { CommentReplyDto } from './comments.service';

// The lock routes of a comment, on the comments prefix beside
// CommentsController. A controller of their own, as CommunityPostsController
// is, so CommentsController keeps its dependencies.
@ApiTags('comments')
@Controller('comments')
export class CommentLocksController {
  constructor(private readonly locks: CommentLocksService) {}

  @Post(':id/lock')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lock a comment and its subtree',
    description:
      'No new replies anywhere beneath the comment, at any depth, for ' +
      'everyone including moderators. The comment stays readable, votable ' +
      'and editable and deletable by its author. Community creator and ' +
      'moderators only; authorship is not enough. Idempotent: locking a ' +
      'locked comment returns it unchanged, keeping locked_at.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: CommentReplyResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID.',
    404: 'Comment not found.',
    409: 'The comment was removed by a moderator.',
  })
  lock(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CommentReplyDto> {
    return this.locks.lock(id, request.user.id);
  }

  @Delete(':id/lock')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unlock a comment',
    description:
      'Reopens the subtree to replies (unless the post or another ancestor ' +
      'is locked). Same authorisation as locking. Idempotent: unlocking an ' +
      'unlocked comment also returns 204.',
  })
  @ApiAuthenticated({
    forbidden: 'The caller does not moderate this community.',
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiNoContentResponse({ description: 'The comment is not locked.' })
  @ApiErrorResponses({
    400: 'Invalid comment ID.',
    404: 'Comment not found.',
    409: 'The comment was removed by a moderator.',
  })
  unlock(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.locks.unlock(id, request.user.id);
  }
}
