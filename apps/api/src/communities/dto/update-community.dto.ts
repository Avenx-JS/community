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
import { PlainTextConstraint } from '../../common/safe-text.constraint';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

@ValidatorConstraint({ name: 'communityUpdateHasField', async: false })
export class CommunityUpdateHasFieldConstraint implements ValidatorConstraintInterface {
  validate(marker: unknown, args: ValidationArguments): boolean {
    const input = args.object as UpdateCommunityDto;
    return marker === undefined && input.description !== undefined;
  }

  defaultMessage(args: ValidationArguments): string {
    return args.value === undefined
      ? 'description must be provided'
      : `property ${args.property} should not exist`;
  }
}

// Every property not declared here is rejected by the global ValidationPipe's
// forbidNonWhitelisted. That is what keeps these out:
// - name: the route key of every community route and its published identity;
//   renaming would break every stored link, and there is no redirect.
// - rules: published only through PUT /communities/:name/rules as immutable
//   versions; accepting them here would recreate the second source of truth
//   that dropping communities.rules removed.
// - creator_id, id, created_at, deleted_at: not client-settable.
// The field uses @ValidateIf(!== undefined) rather than @IsOptional(), which
// would also wave through an explicit null; clearing is spelled "".
export class UpdateCommunityDto {
  /**
   * Plain-text description, at most 16383 characters after trimming. An
   * empty string clears it.
   */
  @ValidateIf((input: UpdateCommunityDto) => input.description !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(16383)
  @Validate(PlainTextConstraint)
  description?: string;

  // Never sent by clients. The field skips every check when absent, so the
  // at-least-one rule hangs off this always-absent property instead, which
  // class-validator always visits.
  @ApiHideProperty()
  @Validate(CommunityUpdateHasFieldConstraint)
  private readonly at_least_one_field?: never;
}
