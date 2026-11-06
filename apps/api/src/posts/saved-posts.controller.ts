import {
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
import { ListSavedPostsDto } from './dto/list-saved-posts.dto';
import { SavedPostListResponse } from './posts.responses';
import {
  SavedPostsService,
  type SavedPostListDto,
} from './saved-posts.service';

// A user's private bookmarks: the /save sub-resource of a post (like /pin,
// /lock and /subscribe) and the caller's own list under /users/me. A
// controller of its own, so PostsController and UsersController keep their
// dependencies.
@ApiTags('saved-posts')
@Controller()
export class SavedPostsController {
  constructor(private readonly savedPosts: SavedPostsService) {}

  @Post('posts/:id/save')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Save a post',
    description:
      'Adds the post to your private saved list. Idempotent: saving again ' +
      'keeps one save and its original time. Not gated on community rule ' +
      'acceptance: saving is private and adds nothing to the community.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is saved.' })
  @ApiErrorResponses({
    400: 'Invalid post ID.',
    404: 'Post not found, removed, or in a deleted or suspended community.',
  })
  save(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.savedPosts.save(id, request.user.id);
  }

  @Delete('posts/:id/save')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unsave a post',
    description:
      'Removes the post from your saved list. Idempotent: unsaving a post ' +
      'you have not saved also returns 204. Works for a post in any state.',
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Post ID.')
  @ApiNoContentResponse({ description: 'The post is not saved.' })
  @ApiErrorResponses({ 400: 'Invalid post ID.', 404: 'Post not found.' })
  unsave(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.savedPosts.unsave(id, request.user.id);
  }

  @Get('users/me/saved-posts')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List your saved posts',
    description:
      'Your own saves only; no route exposes another user’s. Most ' +
      'recently saved first (sort=oldest reverses it), by save time, not ' +
      'post time. Omits posts removed by moderators and posts in deleted ' +
      'or suspended communities; their saves are kept, so a restored post ' +
      'reappears.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: SavedPostListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  list(
    @Query() query: ListSavedPostsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<SavedPostListDto> {
    return this.savedPosts.list(request.user.id, query);
  }
}
