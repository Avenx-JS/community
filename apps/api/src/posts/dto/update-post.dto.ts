import { ApiHideProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Length,
  MaxLength,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

@ValidatorConstraint({ name: 'postUpdateHasField', async: false })
export class PostUpdateHasFieldConstraint implements ValidatorConstraintInterface {
  validate(marker: unknown, args: ValidationArguments): boolean {
    const input = args.object as UpdatePostDto;
    return (
      marker === undefined &&
      (input.title !== undefined || input.content !== undefined)
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return args.value === undefined
      ? 'at least one of title or content must be provided'
      : `property ${args.property} should not exist`;
  }
}

// Body of PATCH /posts/:id. Only title and content are editable; type,
// community_id, author_id, created_at and every other property are rejected
// by the global ValidationPipe's forbidNonWhitelisted. Each field carries
// CreatePostDto's validators except the type-dependent URL rule, which needs
// the stored type and so runs in PostsService.update (still a 400).
// @ValidateIf(!== undefined) rather than @IsOptional(), which would also wave
// through an explicit null.
export class UpdatePostDto {
  /** 1-300 characters after trimming. Omit to leave it unchanged. */
  @ValidateIf((input: UpdatePostDto) => input.title !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  @Validate(PlainTextConstraint)
  title?: string;

  /**
   * Text body, or for link and media posts an HTTP(S) URL (checked against
   * the post's stored type). At most 16,383 characters after trimming. Omit
   * to leave it unchanged.
   */
  @ValidateIf((input: UpdatePostDto) => input.content !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  content?: string;

  // Never sent by clients: both fields skip every check when absent, so the
  // at-least-one rule hangs off this always-absent property, as in
  // UpdateOwnProfileDto.
  @ApiHideProperty()
  @Validate(PostUpdateHasFieldConstraint)
  private readonly at_least_one_field?: never;
}
