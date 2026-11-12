import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MediaResponse } from '../media/media.responses';
import { AssignedFlairResponse } from '../communities/community-settings.responses';
import type { PostDto, PostListDto } from './posts.service';
import type { SavedPostDto, SavedPostListDto } from './saved-posts.service';
import {
  SAVED_POST_SORTS,
  type SavedPostSort,
} from './dto/list-saved-posts.dto';
import {
  POST_LIST_SORTS,
  POST_TOP_WINDOWS,
  type PostListSort,
  type PostTopWindow,
} from './dto/post-listing-query.dto';

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
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      "When the author last changed the post's title or content; null if " +
      'never edited.',
  })
  edited_at!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When a moderator closed the post to new comments; null if open.',
  })
  locked_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Who locked the post. Also null on a locked post once that moderator's " +
      'account is deleted.',
  })
  locked_by!: string | null;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the post; 0 without votes.',
  })
  score!: number;

  @ApiProperty({
    description:
      'Caller-dependent: true when the authenticated caller has saved this ' +
      'post (POST /posts/{id}/save), false otherwise and always false for an ' +
      'anonymous caller. Saves are private; no response carries a save count.',
  })
  saved!: boolean;

  @ApiProperty({
    type: MediaResponse,
    nullable: true,
    description:
      "A media post's uploaded file (POST /media); null on text and link " +
      'posts and on media posts created before uploads existed, whose ' +
      'content is still their URL.',
  })
  media!: MediaResponse | null;

  @ApiProperty({
    type: AssignedFlairResponse,
    nullable: true,
    description: 'The post flair (PUT /posts/{id}/flair); null when none.',
  })
  flair!: AssignedFlairResponse | null;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'Present only on a removed post, and only for its reviewers (community ' +
      'creator, community moderators, platform admins); everyone else gets ' +
      '404 for a removed post.',
  })
  removed?: true;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Reviewers only: when the post was removed.',
  })
  removed_at?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "Reviewers only: who removed it; null once that moderator's account " +
      'is deleted.',
  })
  removed_by?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Reviewers only: the optional removal reason.',
  })
  removal_reason?: string | null;
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

  @ApiProperty({ enum: POST_LIST_SORTS })
  sort!: PostListSort;

  @ApiPropertyOptional({
    enum: POST_TOP_WINDOWS,
    description: 'With sort=top only: the window that was ranked.',
  })
  time?: PostTopWindow;
}

// An item of GET /users/me/saved-posts: the one post shape, reused, with
// the save timestamp beside it (as GET /subscriptions pairs a community with
// subscribed_at).
export class SavedPostResponse implements SavedPostDto {
  @ApiProperty({
    type: PostResponse,
    description: 'saved is always true here.',
  })
  post!: PostResponse;

  @ApiProperty({
    format: 'date-time',
    description: 'When the caller saved the post; the listing order key.',
  })
  saved_at!: string;
}

export class SavedPostListResponse implements SavedPostListDto {
  @ApiProperty({ type: [SavedPostResponse] })
  items!: SavedPostResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Saved posts that are currently listed: the same filters as items.',
  })
  total!: number;

  @ApiProperty({ enum: SAVED_POST_SORTS })
  sort!: SavedPostSort;
}
