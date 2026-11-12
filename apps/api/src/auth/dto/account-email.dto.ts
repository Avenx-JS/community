import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  Validate,
} from 'class-validator';
import { SafeIdentifierConstraint } from '../../common/safe-text.constraint';

// POST /auth/email/verify.
export class VerifyEmailDto {
  /** The code from the email: either the verification or the change code. */
  @IsString()
  @Length(1, 128)
  @Validate(SafeIdentifierConstraint)
  token!: string;
}

// PATCH /users/me/email.
export class ChangeEmailDto {
  @IsEmail()
  @MaxLength(255)
  new_email!: string;

  /** Re-confirms the account owner: a stolen access token is not enough. */
  @IsString()
  @Length(12, 128)
  current_password!: string;
}
