import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Validate,
  ValidateNested,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CommunityRuleItemDto {
  /** Rule heading. Position is the item's index in `items`, never sent. */
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  @Validate(PlainTextConstraint)
  title!: string;

  /** Optional explanation; whitespace-only is stored as null. */
  @Transform(({ value }: { value: unknown }) => {
    const trimmed = trim({ value });
    return trimmed === '' ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @Validate(PlainTextConstraint)
  body?: string | null;
}

export class PublishCommunityRulesDto {
  /** The complete rule document, in display order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CommunityRuleItemDto)
  items!: CommunityRuleItemDto[];
}
