import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { RemoveContentDto } from '../common/remove-content.dto';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  CommentRemovalService,
  type RemovedCommentDto,
} from './comment-removals.service';
import {
  CommentReplyResponse,
  RemovedCommentResponse,
} from './comments.responses';
import type { CommentReplyDto } from './comments.service';

// A moderator's reversible removal of a comment, on the comments prefix
// beside CommentsController (whose DELETE is the author's own hard delete).
@ApiTags('comments')
@Controller('comments')
export class CommentRemovalsController {
  constructor(private readonly removals: CommentRemovalService) {}

  @Post(':id/remove')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a comment (moderators)',
    description:
      'Reversible moderative removal: the comment is kept for review and ' +
      'restoration and shown to everyone but reviewers as a tombstone in the ' +
      'thread, with its replies in place. Community creator and moderators ' +
      'only; the author deletes with DELETE. The author is notified without ' +
      'the reason or the moderator.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller does not moderate this community (authors use DELETE).',
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: RemovedCommentResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID or reason, or an unknown property.',
    404: 'Comment not found.',
    409: 'The comment is already removed.',
  })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: RemoveContentDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<RemovedCommentDto> {
    return this.removals.remove(id, body, request.user.id);
  }

  @Post(':id/restore')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a removed comment (moderators)',
    description:
      'Clears the removal. Same authorisation as removing. No notification. ' +
      'Refused with 409 while the comment’s post is itself removed, and ' +
      'with 403 when a platform administrator removed the comment ' +
      '(removed_by_admin): only POST /admin/comments/:id/restore undoes it.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller does not moderate this community, or a platform administrator removed the comment.',
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: CommentReplyResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID.',
    404: 'Comment not found.',
    409: 'The comment is not removed, or its post is removed.',
  })
  restore(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<CommentReplyDto> {
    return this.removals.restore(id, request.user.id);
  }
}
