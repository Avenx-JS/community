import { PostListingQueryDto } from './post-listing-query.dto';

// Query of GET /feed: the shared listing query. The subscriber is always the
// token's user, so no property can name another account.
export class ListFeedDto extends PostListingQueryDto {}
