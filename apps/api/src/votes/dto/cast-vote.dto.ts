import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

// Body of PUT /posts/:id/vote and PUT /comments/:id/vote: the vote's whole
// state. The target comes from the path, so the body has nothing else; the
// global ValidationPipe (forbidNonWhitelisted) refuses any other property.
export class CastVoteDto {
  @ApiProperty({ type: 'integer', enum: [-1, 1] })
  @IsIn([-1, 1])
  value!: -1 | 1;
}
