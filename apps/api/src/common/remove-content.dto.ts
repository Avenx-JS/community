import { Transform } from 'class-transformer';
import { IsString, Length, Validate, ValidateIf } from 'class-validator';
import { PlainTextConstraint } from './safe-text.constraint';

// Body of POST /posts/:id/remove and POST /comments/:id/remove, both
// optional. The reason follows LiftRestrictionDto's text rules (trimmed,
// 1-2,000 characters of plain text). It is optional by decision, not by
// default: a moderator clearing obvious spam should not have to type, and
// removal_reason is nullable. It is moderator-facing only: stored on the
// row and in the moderation log, never sent to the author's inbox.
// @ValidateIf(!== undefined) rather than @IsOptional(), so an explicit null
// or an empty string is a 400 rather than silently "no reason".
export class RemoveContentDto {
  /** Why the content was removed; shown only to moderators. */
  @ValidateIf((input: RemoveContentDto) => input.reason !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 2000)
  @Validate(PlainTextConstraint)
  reason?: string;
}
