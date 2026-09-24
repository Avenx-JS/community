import { Controller, Post, Body } from '@nestjs/common';

@Controller('votes')
export class VotesController {
  @Post()
  vote(@Body() body: any) {
    return { message: 'Not implemented' };
  }
}
