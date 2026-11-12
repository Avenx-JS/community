import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';
import {
  COMMUNITY_VISIBILITIES,
  type CommunityVisibility,
} from '../../common/community-visibility';

export const COMMUNITY_POST_TYPES = ['text', 'link', 'media'] as const;
export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

@ValidatorConstraint({ name: 'communityUpdateHasField', async: false })
export class CommunityUpdateHasFieldConstraint implements ValidatorConstraintInterface {
  validate(marker: unknown, args: ValidationArguments): boolean {
    const input = args.object as UpdateCommunityDto;
    return (
      marker === undefined &&
      (input.description !== undefined ||
        input.visibility !== undefined ||
        input.nsfw !== undefined ||
        input.allowed_post_types !== undefined)
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return args.value === undefined
      ? 'At least one of description, visibility, nsfw and allowed_post_types must be provided'
      : `property ${args.property} should not exist`;
  }
}

// Every property not declared here is rejected by the global ValidationPipe's
// forbidNonWhitelisted. That is what keeps these out:
// - name: the route key of every community route and its published identity;
//   renaming would break every stored link, and there is no redirect.
// - rules: published only through PUT /communities/:name/rules as immutable
//   versions; accepting them here would recreate the second source of truth
//   that dropping communities.rules removed.
// - creator_id, id, created_at, deleted_at: not client-settable.
// The field uses @ValidateIf(!== undefined) rather than @IsOptional(), which
// would also wave through an explicit null; clearing is spelled "".
export class UpdateCommunityDto {
  /**
   * Plain-text description, at most 16383 characters after trimming. An
   * empty string clears it.
   */
  @ValidateIf((input: UpdateCommunityDto) => input.description !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  description?: string;

  /**
   * public: anyone reads and joins. restricted: anyone reads, only members
   * post, joining is by request. private: only members see its posts,
   * comments, moderators and stats, joining is by request. Takes effect on
   * the next request: making a community private hides it from non-members
   * at once.
   */
  @ApiProperty({ enum: COMMUNITY_VISIBILITIES, required: false })
  @ValidateIf((input: UpdateCommunityDto) => input.visibility !== undefined)
  @IsIn(COMMUNITY_VISIBILITIES)
  visibility?: CommunityVisibility;

  /**
   * Marks the community not safe for work: its posts then appear in
   * GET /posts, GET /feed, search and user profiles only for viewers whose
   * show_nsfw preference is on.
   */
  @ValidateIf((input: UpdateCommunityDto) => input.nsfw !== undefined)
  @IsBoolean()
  nsfw?: boolean;

  /** The post types POST /posts accepts here, at least one. */
  @ApiProperty({
    enum: COMMUNITY_POST_TYPES,
    isArray: true,
    required: false,
  })
  @ValidateIf(
    (input: UpdateCommunityDto) => input.allowed_post_types !== undefined,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(COMMUNITY_POST_TYPES, { each: true })
  allowed_post_types?: CommunityPostType[];

  // Never sent by clients. The field skips every check when absent, so the
  // at-least-one rule hangs off this always-absent property instead, which
  // class-validator always visits.
  @ApiHideProperty()
  @Validate(CommunityUpdateHasFieldConstraint)
  private readonly at_least_one_field?: never;
}
