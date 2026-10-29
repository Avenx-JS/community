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
