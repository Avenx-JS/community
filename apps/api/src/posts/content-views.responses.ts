import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserCommentResponse } from '../users/users.responses';
import type {
  RevisionDto,
  RevisionListDto,
  RevisionVersionDto,
} from './content-revisions.service';
import {
  OWN_LIST_SORTS,
  VOTED_TYPES,
  type OwnListSort,
  type VotedType,
} from './dto/own-content.dto';
import type { HiddenPostDto, HiddenPostListDto } from './hidden-posts.service';
import { PostResponse } from './posts.responses';
import type {
  SavedCommentDto,
  SavedCommentListDto,
} from './saved-comments.service';
import type { VotedItemDto, VotedListDto } from './vote-history.service';

class PageResponse {
  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Items currently listed: the same filters as items.',
  })
  total!: number;
}

export class HiddenPostResponse implements HiddenPostDto {
  @ApiProperty({ type: PostResponse })
  post!: PostResponse;

  @ApiProperty({ format: 'date-time', description: 'When the caller hid it.' })
  hidden_at!: string;
}

export class HiddenPostListResponse
  extends PageResponse
  implements HiddenPostListDto
{
  @ApiProperty({ type: [HiddenPostResponse] })
  items!: HiddenPostResponse[];

  @ApiProperty({ enum: OWN_LIST_SORTS })
  sort!: OwnListSort;
}

export class SavedCommentResponse implements SavedCommentDto {
  @ApiProperty({ type: UserCommentResponse })
  comment!: UserCommentResponse;

  @ApiProperty({
    format: 'date-time',
    description: 'When the caller saved it.',
  })
  saved_at!: string;
}

export class SavedCommentListResponse
  extends PageResponse
  implements SavedCommentListDto
{
  @ApiProperty({ type: [SavedCommentResponse] })
  items!: SavedCommentResponse[];

  @ApiProperty({ enum: OWN_LIST_SORTS })
  sort!: OwnListSort;
}

export class VotedItemResponse implements VotedItemDto {
  @ApiPropertyOptional({
    type: PostResponse,
    description: 'Set when type is posts.',
  })
  post?: PostResponse;

  @ApiPropertyOptional({
    type: UserCommentResponse,
    description: 'Set when type is comments.',
  })
  comment?: UserCommentResponse;

  @ApiProperty({ format: 'date-time', description: 'When the vote was cast.' })
  voted_at!: string;
}

export class VotedListResponse extends PageResponse implements VotedListDto {
  @ApiProperty({ enum: VOTED_TYPES })
  type!: VotedType;

  @ApiProperty({ type: [VotedItemResponse] })
  items!: VotedItemResponse[];
}

export class RevisionVersionResponse implements RevisionVersionDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The post title; null for comments.',
  })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true })
  content!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'When this version was written: the creation or an edit.',
  })
  version_at!: string;
}

export class CurrentVersionResponse extends RevisionVersionResponse {
  @ApiProperty({ description: 'Whether the content was ever edited.' })
  edited!: boolean;
}

export class RevisionResponse
  extends RevisionVersionResponse
  implements RevisionDto
{
  @ApiProperty({
    format: 'date-time',
    description: 'When the next edit replaced this version.',
  })
  replaced_at!: string;
}

export class RevisionListResponse
  extends PageResponse
  implements RevisionListDto
{
  @ApiProperty({
    type: CurrentVersionResponse,
    description: 'The version shown now; never one of items.',
  })
  current!: CurrentVersionResponse;

  @ApiProperty({
    type: [RevisionResponse],
    description: 'Earlier versions, most recently replaced first.',
  })
  items!: RevisionResponse[];

  @ApiProperty({
    description:
      'false when edits before history was kept (migration 039) left no ' +
      'stored versions: the oldest item is then not the original.',
  })
  complete!: boolean;
}
