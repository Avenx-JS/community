import { ApiProperty } from '@nestjs/swagger';
import { PostResponse } from '../posts/posts.responses';
import type { PostDto } from '../posts/posts.service';
import type {
  Page,
  UserCommentDto,
  UserCommunityDto,
  UserCommunityRole,
} from './user-activity.service';
import type { OwnProfile, PlatformRole, UserProfile } from './users.service';

export class UserProfileResponse implements UserProfile {
  @ApiProperty()
  username!: string;

  @ApiProperty({ type: 'string', nullable: true, maxLength: 50 })
  display_name!: string | null;

  @ApiProperty({ type: 'string', nullable: true, maxLength: 500 })
  bio!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class OwnProfileResponse
  extends UserProfileResponse
  implements OwnProfile
{
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Returned by GET /users/me and nowhere else.' })
  email!: string;

  @ApiProperty({ enum: ['user', 'moderator', 'admin'] })
  role!: PlatformRole;
}

export class UserPostListResponse implements Page<PostDto> {
  @ApiProperty({
    type: [PostResponse],
    description: 'The same post type as GET /posts and GET /posts/:id.',
  })
  items!: PostResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

// Flat on purpose: not the recursive thread node of GET
// /posts/:postId/comments, which has a replies array.
export class UserCommentResponse implements UserCommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  post_id!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  edited_at!: string | null;

  @ApiProperty({ description: 'Title of the post the comment is on.' })
  post_title!: string;

  @ApiProperty({ description: 'Name of the community the post is in.' })
  community_name!: string;

  @ApiProperty({
    type: 'integer',
    description: 'Sum of all vote values on the comment; 0 without votes.',
  })
  score!: number;
}

export class UserCommentListResponse implements Page<UserCommentDto> {
  @ApiProperty({ type: [UserCommentResponse] })
  items!: UserCommentResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class UserCommunityResponse implements UserCommunityDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    enum: ['creator', 'moderator', 'contributor'],
    description:
      "The person's role in the community, never their platform role: " +
      'creator, moderator, or contributor (a visible post or comment there).',
  })
  role!: UserCommunityRole;
}

export class UserCommunityListResponse implements Page<UserCommunityDto> {
  @ApiProperty({ type: [UserCommunityResponse] })
  items!: UserCommunityResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}
