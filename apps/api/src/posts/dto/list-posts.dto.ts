import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { PostListingQueryDto } from './post-listing-query.dto';

export class ListPostsDto extends PostListingQueryDto {
  @ApiPropertyOptional({
    description:
      'Only posts of this community. GET /communities/:name/posts is the ' +
      'same listing addressed by name.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  community_id?: string;
}
