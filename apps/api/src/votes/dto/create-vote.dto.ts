import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches } from 'class-validator';

export class CreateVoteDto {
  @IsIn(['post', 'comment'])
  target_type!: 'post' | 'comment';

  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  target_id!: string;

  @ApiProperty({ type: 'integer', enum: [-1, 1] })
  @IsIn([-1, 1])
  value!: -1 | 1;
}
