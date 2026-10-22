import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Validate,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

export class CreateCommunityDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 50)
  @Matches(/^[A-Za-z0-9_-]+$/)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  rules?: string;
}
