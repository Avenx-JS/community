import { Transform } from 'class-transformer';
import {
  IsIn,
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

// The content rule of a post type: any plain text for text posts; for link
// and media posts an HTTP(S) URL with a host, no credentials, no backslash
// and no control characters. The one copy of the rule: CreatePostDto applies
// it to the type in the body, PostsService.update to the stored type, since
// an edit cannot change (and so does not send) the type.
export function isValidPostContent(type: unknown, content: unknown): boolean {
  if (type === 'text' || (type !== 'link' && type !== 'media')) {
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
  /** Text body, or an HTTP(S) URL for link and media posts. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  @Validate(PostContentTypeConstraint)
  content!: string;

  @IsString()
  @Length(1, 36)
  @Matches(/^[A-Za-z0-9_-]+$/)
  community_id!: string;
}
