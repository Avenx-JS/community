import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

// Query of GET /communities/:name/posts: ListPostsDto without community_id,
// which would contradict the path. The global ValidationPipe
// (forbidNonWhitelisted) therefore answers community_id with 400.
export class ListCommunityPostsDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: ['new'] })
  @IsOptional()
  @IsIn(['new'])
  sort?: 'new';
}
