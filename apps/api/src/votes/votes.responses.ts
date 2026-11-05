import { ApiProperty } from '@nestjs/swagger';
import type {
  VoteResponseDto,
  VoteScoreDto,
  VoteStateDto,
} from './votes.service';

export class VoteStateResponse implements VoteStateDto {
  @ApiProperty({
    type: 'integer',
    enum: [-1, 1],
    nullable: true,
    description: "The caller's own vote; null when they have not voted.",
  })
  value!: -1 | 1 | null;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the target.',
  })
  score!: number;
}

export class VoteScoreResponse implements VoteScoreDto {
  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the target after the withdrawal.',
  })
  score!: number;
}

export class VoteResponse implements VoteResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  user_id!: string;

  @ApiProperty({ enum: ['post', 'comment'] })
  target_type!: 'post' | 'comment';

  @ApiProperty()
  target_id!: string;

  @ApiProperty({ type: 'integer', enum: [-1, 1] })
  value!: -1 | 1;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the target after this vote.',
  })
  score!: number;
}
