import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import { CreateVoteDto } from './dto/create-vote.dto';
import { VotesService } from './votes.service';

@Controller('votes')
export class VotesController {
  constructor(private readonly votesService: VotesService) {}

  @Post()
  @UseGuards(AuthGuard)
  vote(@Body() body: CreateVoteDto, @Req() request: AuthenticatedRequest) {
    return this.votesService.vote(body, request.user.id);
  }
}
