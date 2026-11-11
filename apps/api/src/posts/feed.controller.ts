import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { ListFeedDto } from './dto/list-feed.dto';
import { PostListResponse } from './posts.responses';
import { PostsService, type PostListDto } from './posts.service';

// The caller's home feed. Its own route rather than GET /posts?subscribed=
// true: it is authenticated where /posts is public, and a flag that changes
// who may call a route and what it returns is a different resource.
@ApiTags('posts')
@Controller('feed')
export class FeedController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'List your home feed',
    description:
      'Posts of the communities you subscribe to, in the same shape, paging ' +
      'and sorts as GET /posts. Omits deleted and suspended communities, ' +
      'communities you are banned from, posts removed by moderators, and ' +
      'posts by accounts you have blocked. Pinned posts do not float: pins ' +
      'belong to their community listing.',
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: PostListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findFeed(
    @Query() query: ListFeedDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<PostListDto> {
    return this.posts.findFeed(query, request.user.id);
  }
}
