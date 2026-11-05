import { ApiProperty } from '@nestjs/swagger';
import type { PostDto, PostListDto } from './posts.service';

export class PostResponse implements PostDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Text body, or the URL for link and media posts.',
  })
  content!: string | null;

  @ApiProperty({ enum: ['text', 'link', 'media'] })
  type!: 'text' | 'link' | 'media';

  @ApiProperty()
  author_id!: string;

  @ApiProperty()
  community_id!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When a community moderator pinned the post; null when not pinned. ' +
      "Orders the pinned posts at the top of the post's community listing.",
  })
  pinned_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'User ID of the moderator who pinned the post. Null when not pinned, ' +
      "and also on a pinned post once that moderator's account is deleted.",
  })
  pinned_by!: string | null;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the post; 0 without votes.',
  })
  score!: number;
}

export class PostListResponse implements PostListDto {
  @ApiProperty({ type: [PostResponse] })
  items!: PostResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ enum: ['new'] })
  sort!: 'new';
}
