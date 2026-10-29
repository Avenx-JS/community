import { ApiProperty } from '@nestjs/swagger';
import type { CommentDto, CommentThreadDto } from './comments.service';

export class CommentResponse implements CommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  post_id!: string;

  @ApiProperty()
  author_id!: string;

  @ApiProperty({ type: String, nullable: true })
  parent_id!: string | null;

  @ApiProperty()
  content!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: () => [CommentResponse] })
  replies!: CommentResponse[];
}

export class CommentThreadResponse implements CommentThreadDto {
  @ApiProperty()
  post_id!: string;

  @ApiProperty({
    type: [CommentResponse],
    description: 'Top-level comments, oldest first, with nested replies.',
  })
  comments!: CommentResponse[];
}
