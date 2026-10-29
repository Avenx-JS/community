import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { PositiveIntRouteParamPipe } from '../common/positive-int-route-param.pipe';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import {
  CommunityRulesResponse,
  CommunityRuleVersionListResponse,
} from './communities.responses';
import { CommunityRulesService } from './community-rules.service';
import { ListRuleVersionsDto } from './dto/list-rule-versions.dto';
import { PublishCommunityRulesDto } from './dto/publish-community-rules.dto';

// community_rule_documents.version is INT UNSIGNED.
const MAX_RULE_VERSION = 4294967295;

@ApiTags('communities')
@Controller('communities/:name/rules')
export class CommunityRulesController {
  constructor(private readonly communityRulesService: CommunityRulesService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the current community rules',
    description:
      'Public. A community without published rules answers 200 with ' +
      'version: null and no items.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityRulesResponse })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found.',
  })
  getCurrent(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
  ) {
    return this.communityRulesService.getCurrent(name);
  }

  @Put()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Publish the community rules',
    description:
      'Replaces the whole document. Only the community creator may publish. ' +
      'Items equal to the current version return it unchanged; anything ' +
      'else, including a reorder, publishes the next version.',
  })
  @ApiAuthenticated({ forbidden: 'The caller is not the community creator.' })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityRulesResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or rule data.',
    404: 'Community not found.',
    409: 'Another publish for this community completed first.',
  })
  publish(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Body() body: PublishCommunityRulesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.communityRulesService.publish(name, body, request.user.id);
  }

  @Get('versions')
  @ApiOperation({
    summary: 'List published rule versions',
    description: 'Public. Newest version first.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiOkResponse({ type: CommunityRuleVersionListResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or query parameters.',
    404: 'Community not found.',
  })
  listVersions(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Query() query: ListRuleVersionsDto,
  ) {
    return this.communityRulesService.listVersions(name, query);
  }

  @Get('versions/:version')
  @ApiOperation({
    summary: 'Get one published rule version',
    description: 'Public. Published versions never change.',
  })
  @ApiRouteParam('name', 'communityName', 'Exact community name.')
  @ApiParam({
    name: 'version',
    schema: { type: 'integer', minimum: 1, maximum: MAX_RULE_VERSION },
  })
  @ApiOkResponse({ type: CommunityRulesResponse })
  @ApiErrorResponses({
    400: 'Invalid community name or version.',
    404: 'Community or version not found.',
  })
  getVersion(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Param('version', new PositiveIntRouteParamPipe(MAX_RULE_VERSION))
    version: number,
  ) {
    return this.communityRulesService.getVersion(name, version);
  }
}
