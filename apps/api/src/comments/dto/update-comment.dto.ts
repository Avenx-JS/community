import { Transform } from 'class-transformer';
import { IsString, Length, Validate } from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

// Body of PATCH /comments/:id: CreateCommentDto's content, required, with
// its exact validators. parent_id is deliberately absent: re-parenting would
// move a subtree and could create a cycle, so the global ValidationPipe
// (forbidNonWhitelisted) rejects it, like post_id or author_id, with 400.
export class UpdateCommentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 16383)
  @Validate(PlainTextConstraint)
  content!: string;
}
