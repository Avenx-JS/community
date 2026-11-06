import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponses, ApiRouteParam } from '../common/openapi';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { CommunitiesService } from '../communities/communities.service';
import { ListCommunityPostsDto } from './dto/list-community-posts.dto';
import { PostListResponse } from './posts.responses';
import { PostsService } from './posts.service';

// A dedicated controller, as CommunityRulesController is: it lives in the
// posts module because PostsModule already imports CommunitiesModule, and
// the reverse would be a circular dependency.
@ApiTags('posts', 'communities')
@Controller('communities/:name/posts')
export class CommunityPostsController {
  constructor(
    private readonly communities: CommunitiesService,
    private readonly posts: PostsService,
  ) {}

  // Resolves the name, then runs the one post listing path with the id: no
  // second copy of the query, so this route and GET /posts?community_id=
  // return identical results, pins first included.
  @Get()
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: "List a community's posts",
    description:
      "The community's pinned posts first, most recently pinned first, then " +
      'newest first by ID. Identical to GET /posts?community_id=<its id>, ' +
      'and the form clients should prefer. Omits posts removed by moderators.',
  })
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiOkResponse({ type: PostListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found, deleted or suspended.',
  })
  async findAll(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListCommunityPostsDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    const communityId = await this.communities.resolveListedId(name);
    return this.posts.findAll(
      { ...query, community_id: communityId },
      request?.user?.id,
    );
  }
}
