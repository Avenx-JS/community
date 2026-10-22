import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateCommentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 16383)
  content!: string;

  @IsOptional()
  @IsString()
  @Length(1, 36)
  parent_id?: string;
}
