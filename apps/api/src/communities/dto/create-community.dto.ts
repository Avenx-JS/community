import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateCommunityDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 50)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16383)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16383)
  rules?: string;
}
