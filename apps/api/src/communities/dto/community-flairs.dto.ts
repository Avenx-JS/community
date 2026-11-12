import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PlainTextConstraint } from '../../common/safe-text.constraint';

export const FLAIR_KINDS = ['post', 'user'] as const;
export type FlairKind = (typeof FLAIR_KINDS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// #rrggbb, stored lower case.
const COLOR = /^#[0-9a-fA-F]{6}$/;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class CreateFlairDto {
  /** post: assigned to posts. user: shown beside a member's name. */
  @ApiProperty({ enum: FLAIR_KINDS })
  @IsIn(FLAIR_KINDS)
  kind!: FlairKind;

  /** 1 to 64 characters, unique per community and kind. */
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  @Validate(PlainTextConstraint)
  text!: string;

  /** A #rrggbb colour, or null for none. */
  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @Transform(lower)
  @Matches(COLOR, { message: 'background_color must be #rrggbb' })
  background_color?: string | null;

  /** When true, only moderators may assign it. */
  @IsOptional()
  @IsBoolean()
  mod_only?: boolean;
}

@ValidatorConstraint({ name: 'flairUpdateHasField', async: false })
export class FlairUpdateHasFieldConstraint implements ValidatorConstraintInterface {
  validate(marker: unknown, args: ValidationArguments): boolean {
    const input = args.object as UpdateFlairDto;
    return (
      marker === undefined &&
      (input.text !== undefined ||
        input.background_color !== undefined ||
        input.mod_only !== undefined)
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return args.value === undefined
      ? 'At least one of text, background_color and mod_only must be provided'
      : `property ${args.property} should not exist`;
  }
}

// kind is fixed: a post flair never becomes a user flair.
export class UpdateFlairDto {
  @ValidateIf((input: UpdateFlairDto) => input.text !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  @Validate(PlainTextConstraint)
  text?: string;

  /** A #rrggbb colour; null clears it. */
  @ApiProperty({ type: String, nullable: true, required: false })
  @ValidateIf(
    (input: UpdateFlairDto) =>
      input.background_color !== undefined && input.background_color !== null,
  )
  @Transform(lower)
  @Matches(COLOR, { message: 'background_color must be #rrggbb' })
  background_color?: string | null;

  @ValidateIf((input: UpdateFlairDto) => input.mod_only !== undefined)
  @IsBoolean()
  mod_only?: boolean;

  @ApiHideProperty()
  @Validate(FlairUpdateHasFieldConstraint)
  private readonly at_least_one_field?: never;
}

export class ListFlairsDto {
  @ApiProperty({ enum: FLAIR_KINDS, required: false })
  @IsOptional()
  @IsIn(FLAIR_KINDS)
  kind?: FlairKind;
}

export class AssignFlairDto {
  /** One of the community's flairs of the matching kind. */
  @IsUUID()
  flair_id!: string;
}

// A member's flair: null clears it.
export class AssignUserFlairDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  @ValidateIf((input: AssignUserFlairDto) => input.flair_id !== null)
  @IsUUID()
  flair_id!: string | null;
}
