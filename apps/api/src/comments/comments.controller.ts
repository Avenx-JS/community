import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { CommentsService } from './comments.service';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';

@ApiTags('comments')
@Controller('comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

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
