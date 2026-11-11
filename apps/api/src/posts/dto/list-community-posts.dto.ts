import { PostListingQueryDto } from './post-listing-query.dto';

// Query of GET /communities/:name/posts: ListPostsDto without community_id,
// which would contradict the path. The global ValidationPipe
// (forbidNonWhitelisted) therefore answers community_id with 400.
export class ListCommunityPostsDto extends PostListingQueryDto {}
