import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import { ApiErrorResponses } from '../common/openapi';
import { SearchQueryDto } from './dto/search-query.dto';
import { SEARCH_RESULT_RESPONSES } from './search.responses';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
@ApiExtraModels(...SEARCH_RESULT_RESPONSES)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  // Public like GET /posts and GET /communities; an optional bearer token only
  // sets each post's saved flag. Rate limited by its own bucket on top of the
  // general read limit (API_SEARCH_IP_*).
  @Get()
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Search users, communities, posts or comments',
    description:
      'One result kind per request, chosen by the required `type`; issue ' +
      'parallel requests for a combined view. Communities, posts and ' +
      'comments use full-text search: `q` is read as plain words (operator ' +
      'characters are ignored), any of which may match, and a word needs at ' +
      'least 3 characters. Users are matched by username prefix only, never ' +
      'by email. `community`, `author`, `from` and `to` apply only to ' +
      '`posts` and `comments`; an unknown community or author is a 404. ' +
      'Removed content and anything in a deleted or suspended community, ' +
      'and deleted accounts, never appear. Pages stop at 100.',
  })
  @ApiOkResponse({
    description: 'The envelope for the requested `type`.',
    schema: {
      oneOf: SEARCH_RESULT_RESPONSES.map((response) => ({
        $ref: getSchemaPath(response),
      })),
      discriminator: { propertyName: 'type' },
    },
  })
  @ApiErrorResponses({
    400:
      'Invalid query: q missing, outside 3-100 characters or without a ' +
      '3-character word; type missing or unknown; a content filter with ' +
      'users or communities; to not after from; or an unknown property.',
    404: 'The community or author filter names no visible community or account.',
  })
  search(
    @Query() query: SearchQueryDto,
    @Req() request?: OptionallyAuthenticatedRequest,
  ) {
    return this.searchService.search(query, request?.user?.id);
  }
}
