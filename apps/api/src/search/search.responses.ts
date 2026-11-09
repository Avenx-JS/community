import { ApiProperty } from '@nestjs/swagger';
import { CommunityResponse } from '../communities/communities.responses';
import { PostResponse } from '../posts/posts.responses';
import {
  UserCommentResponse,
  UserProfileResponse,
} from '../users/users.responses';
import type { SearchType } from './dto/search-query.dto';

// One envelope per type, so each documents its own item shape; type is echoed
// so a client can discriminate. Items reuse the shapes the rest of the API
// returns: the public profile (no id, no email), the community, the post, and
// the flat comment of GET /users/:username/comments.
abstract class SearchResultListResponse {
  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class UserSearchResultListResponse extends SearchResultListResponse {
  @ApiProperty({ enum: ['users'] })
  type!: Extract<SearchType, 'users'>;

  @ApiProperty({ type: [UserProfileResponse] })
  items!: UserProfileResponse[];
}

export class CommunitySearchResultListResponse extends SearchResultListResponse {
  @ApiProperty({ enum: ['communities'] })
  type!: Extract<SearchType, 'communities'>;

  @ApiProperty({ type: [CommunityResponse] })
  items!: CommunityResponse[];
}

export class PostSearchResultListResponse extends SearchResultListResponse {
  @ApiProperty({ enum: ['posts'] })
  type!: Extract<SearchType, 'posts'>;

  @ApiProperty({ type: [PostResponse] })
  items!: PostResponse[];
}

export class CommentSearchResultListResponse extends SearchResultListResponse {
  @ApiProperty({ enum: ['comments'] })
  type!: Extract<SearchType, 'comments'>;

  @ApiProperty({
    type: [UserCommentResponse],
    description: 'Flat comments, with no replies.',
  })
  items!: UserCommentResponse[];
}

export const SEARCH_RESULT_RESPONSES = [
  UserSearchResultListResponse,
  CommunitySearchResultListResponse,
  PostSearchResultListResponse,
  CommentSearchResultListResponse,
] as const;
