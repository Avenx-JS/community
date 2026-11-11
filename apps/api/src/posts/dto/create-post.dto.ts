import { Transform } from 'class-transformer';
import {
  IsIn,
  ValidateIf,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  hasControlCharacters,
  PlainTextConstraint,
} from '../../common/safe-text.constraint';

export type PostType = 'text' | 'link' | 'media';

export const POST_CONTENT_URL_MESSAGE =
  'content must be an HTTP or HTTPS URL for link and media posts';

// The content rule of a post: any plain text for a text post and for the
// caption of a media post with an uploaded file; for a link post an HTTP(S)
// URL with a host, no credentials, no backslash and no control characters.
// A media post created before uploads existed (migration 035) has no file
// and keeps its URL as content, so editing it keeps the URL rule: hasFile
// says which kind of media post it is. The one copy of the rule:
// CreatePostDto applies it to the type in the body, PostsService.update to
// the stored type and file, since an edit cannot change either.
export function isValidPostContent(
  type: unknown,
  content: unknown,
  hasFile = type === 'media',
): boolean {
  if (type !== 'link' && (type !== 'media' || hasFile)) {
    return true;
  }
  if (typeof content !== 'string') {
    return true;
  }

  try {
    if (
      hasControlCharacters(content, false) ||
      content.includes('\\') ||
      content !== content.trim()
    ) {
      return false;
    }
    const url = new URL(content);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: 'postContentType', async: false })
class PostContentTypeConstraint implements ValidatorConstraintInterface {
  validate(content: unknown, args: ValidationArguments): boolean {
    return isValidPostContent((args.object as CreatePostDto).type, content);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an HTTP or HTTPS URL for link and media posts`;
  }
}

// media_id belongs to media posts and only to them.
@ValidatorConstraint({ name: 'postMediaType', async: false })
class MediaIdOnlyForMediaConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (args.object as CreatePostDto).type === 'media';
  }

  defaultMessage(): string {
    return 'media_id applies only to media posts';
  }
}

export class CreatePostDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 300)
  @Validate(PlainTextConstraint)
  title!: string;

  @IsIn(['text', 'link', 'media'])
  type!: 'text' | 'link' | 'media';

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  /**
   * Text body, the HTTP(S) URL of a link post, or the optional caption of a
   * media post. Required for text and link posts.
   */
  @ValidateIf(
    (input: CreatePostDto) =>
      input.type !== 'media' || input.content !== undefined,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  @Validate(PostContentTypeConstraint)
  content?: string;

  /**
   * Required for a media post, refused on any other: the id of your own
   * upload from POST /media that no post uses yet. A media post no longer
   * takes a URL; a link post does.
   */
  @ValidateIf(
    (input: CreatePostDto) =>
      input.type === 'media' || input.media_id !== undefined,
  )
  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  @Validate(MediaIdOnlyForMediaConstraint)
  media_id?: string;

  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  community_id!: string;
}
