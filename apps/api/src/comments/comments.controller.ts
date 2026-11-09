import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import {
  CommentReplyListResponse,
  CommentReplyResponse,
} from './comments.responses';
import {
  CommentsService,
  type CommentReplyDto,
  type CommentReplyListDto,
} from './comments.service';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ListCommentRepliesDto } from './dto/list-comment-replies.dto';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { USER_BLOCKED_FORBIDDEN_DOC } from '../users/user-block-policy.service';
import { CastVoteDto } from '../votes/dto/cast-vote.dto';
import {
  VoteResponse,
  VoteScoreResponse,
  VoteStateResponse,
} from '../votes/votes.responses';
import {
  VotesService,
  type VoteResponseDto,
  type VoteScoreDto,
  type VoteStateDto,
} from '../votes/votes.service';

@ApiTags('comments')
@Controller('comments')
export class CommentsController {
  constructor(
    private readonly commentsService: CommentsService,
    private readonly votesService: VotesService,
  ) {}

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

  @Patch(':id')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Edit your comment',
    description:
      'Author only: unlike DELETE /comments/{id}, moderators and the ' +
      'community creator may not edit. Only content is editable; parent_id ' +
      'is immutable. Submitting the stored content changes nothing and ' +
      'leaves edited_at unchanged. Not gated on rule acceptance.',
  })
  @ApiAuthenticated({ forbidden: 'Only the author may edit this content.' })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: CommentReplyResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID or comment data, or a non-editable property.',
    404: 'Comment not found, or its community is deleted or suspended.',
    409: 'The comment or its post was removed, or the discussion is locked.',
  })
  update(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: UpdateCommentDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<CommentReplyDto> {
    return this.commentsService.update(id, body, request.user.id);
  }

  @Put(':id/vote')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiTags('votes')
  @ApiOperation({
    summary: 'Cast or change your vote on a comment',
    description:
      "Idempotent: the caller's one vote on the comment is set to value; " +
      'repeating the request leaves one vote. Requires acceptance of the ' +
      "current rules of the post's community. Refused when the caller and " +
      "the comment's author have blocked each other.",
  })
  @ApiAuthenticated({
    forbidden: `The caller has not accepted the community's current rules. ${USER_BLOCKED_FORBIDDEN_DOC}`,
  })
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: VoteResponse })
  @ApiErrorResponses({
    400: 'Invalid comment ID or vote data.',
    404: 'Comment not found.',
  })
  castVote(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Body() body: CastVoteDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<VoteResponseDto> {
    return this.votesService.vote(
      { target_type: 'comment', target_id: id, value: body.value },
      request.user.id,
    );
  }

  @Delete(':id/vote')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiTags('votes')
  @ApiOperation({
    summary: 'Withdraw your vote on a comment',
    description:
      'Returns the score after the withdrawal. Idempotent: without a vote ' +
      'nothing is removed and the current score is returned. Not gated on ' +
      'rule acceptance.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: VoteScoreResponse })
  @ApiErrorResponses({ 400: 'Invalid comment ID.', 404: 'Comment not found.' })
  withdrawVote(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<VoteScoreDto> {
    return this.votesService.withdraw('comment', id, request.user.id);
  }

  @Get(':id/vote')
  @UseGuards(AuthGuard)
  @ApiTags('votes')
  @ApiOperation({
    summary: 'Read your vote on a comment',
    description:
      "The caller's own vote (null when they have none) and the comment's " +
      'score.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Comment ID.')
  @ApiOkResponse({ type: VoteStateResponse })
  @ApiErrorResponses({ 400: 'Invalid comment ID.', 404: 'Comment not found.' })
  getVote(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<VoteStateDto> {
    return this.votesService.state('comment', id, request.user.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete your comment',
    description:
      'Author only: a hard delete, with its replies. Breaking change: ' +
      'community moderators and the creator now receive 403 here; they ' +
      'remove comments reversibly with POST /comments/{id}/remove.',
  })
  @ApiAuthenticated({
    forbidden:
      'The caller is not the author. Moderators use POST /comments/{id}/remove.',
  })
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
