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

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateJoinRequestDto {
  /** An optional note to the moderators, plain text, at most 500 characters. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @Validate(PlainTextConstraint)
  message?: string;
}

export class InviteModeratorDto {
  /** The member to invite. */
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;
}

// DELETE /communities/:name/moderators/invites: with username the creator
// revokes that invitation; without, the caller declines their own.
export class ModeratorInviteTargetDto {
  @IsOptional()
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username?: string;
}
