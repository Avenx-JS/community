import { Controller, Delete, Param } from '@nestjs/common';

@Controller('comments')
export class CommentsController {
  @Delete(':id')
  remove(@Param('id') id: string) {
    return { message: 'Not implemented' };
  }
}
