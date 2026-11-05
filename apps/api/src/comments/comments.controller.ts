import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { CommentReplyListResponse } from './comments.responses';
import { CommentsService, type CommentReplyListDto } from './comments.service';
import { ListCommentRepliesDto } from './dto/list-comment-replies.dto';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('comments')
@Controller('comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get(':id/replies')
  @ApiOperation({
    summary: "List a comment's direct replies",
    description:
      'One level only, oldest first by default (created_at, then id). Items ' +
      'are flat and carry a reply_count instead of nested replies; recurse ' +
      'through this route for any reply with reply_count > 0. Omits ' +
      'comments removed by moderators, but the replies of a removed comment ' +
      'stay readable here.',
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: CommentReplyListResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID or query parameters.',
    404: 'Comment not found, or its community is deleted.',
  })
  findReplies(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Query() query: ListCommentRepliesDto,
  ): Promise<CommentReplyListDto> {
    return this.commentsService.findReplies(id, query);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a comment',
    description:
      "Allowed for the author and for the post's community creator and " +
      'moderators.',
  })
  @ApiAuthenticated({ forbidden: 'The caller may not delete this comment.' })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiNoContentResponse({ description: 'The comment is deleted.' })
  @ApiErrorResponses({
    400: 'Invalid comment ID.',
    404: 'Comment not found.',
  })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.commentsService.remove(id, request.user.id);
  }
}
