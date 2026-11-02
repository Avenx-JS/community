import { ApiHideProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  MaxLength,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  PlainTextConstraint,
  SafeIdentifierConstraint,
} from '../../common/safe-text.constraint';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

@ValidatorConstraint({ name: 'profileUpdateHasField', async: false })
export class ProfileUpdateHasFieldConstraint implements ValidatorConstraintInterface {
  validate(marker: unknown, args: ValidationArguments): boolean {
    const input = args.object as UpdateOwnProfileDto;
    return (
      marker === undefined &&
      (input.display_name !== undefined || input.bio !== undefined)
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return args.value === undefined
      ? 'at least one of display_name or bio must be provided'
      : `property ${args.property} should not exist`;
  }
}

// Every property not declared here (username, email, role, id, created_at,
// password_hash, ...) is rejected by the global ValidationPipe's
// forbidNonWhitelisted; that is what keeps them unsettable.
// The fields use @ValidateIf(!== undefined) rather than @IsOptional(), which
// would also wave through an explicit null; clearing is spelled "".
export class UpdateOwnProfileDto {
  /**
   * Single-line public name, at most 50 characters after trimming. An empty
   * string clears it. Omit to leave it unchanged.
   */
  @ValidateIf((input: UpdateOwnProfileDto) => input.display_name !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  @Validate(SafeIdentifierConstraint)
  display_name?: string;

  /**
   * Public plain-text description, at most 500 characters after trimming. An
   * empty string clears it. Omit to leave it unchanged.
   */
  @ValidateIf((input: UpdateOwnProfileDto) => input.bio !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @Validate(PlainTextConstraint)
  bio?: string;

  // Never sent by clients. Each field skips every check when absent, so the
  // at-least-one rule cannot live on either; it hangs off this always-absent
  // property instead, which class-validator always visits.
  @ApiHideProperty()
  @Validate(ProfileUpdateHasFieldConstraint)
  private readonly at_least_one_field?: never;
}
