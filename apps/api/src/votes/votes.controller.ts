import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { VoteResponse } from './votes.responses';
import { CreateVoteDto } from './dto/create-vote.dto';
import { VotesService } from './votes.service';

@ApiTags('votes')
@Controller('votes')
export class VotesController {
  constructor(private readonly votesService: VotesService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Cast or change a vote (deprecated)',
    description:
      "Creates the user's vote on a post or comment, or updates its value. " +
      'Deprecated: use PUT /posts/{id}/vote or PUT /comments/{id}/vote, ' +
      'which behave identically. This route still works and will be ' +
      'removed in a future change.',
    deprecated: true,
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: VoteResponse })
  @ApiErrorResponses({
    400: 'Invalid vote data.',
    404: 'Vote target not found.',
  })
  vote(@Body() body: CreateVoteDto, @Req() request: AuthenticatedRequest) {
    return this.votesService.vote(body, request.user.id);
  }
}
