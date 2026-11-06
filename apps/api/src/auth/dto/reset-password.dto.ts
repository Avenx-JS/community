import { IsString, Length, Validate } from 'class-validator';
import { SafeIdentifierConstraint } from '../../common/safe-text.constraint';

export class ResetPasswordDto {
  /** The reset token from the email. */
  @IsString()
  @Length(1, 128)
  @Validate(SafeIdentifierConstraint)
  token!: string;

  @IsString()
  @Length(12, 128)
  new_password!: string;
}
