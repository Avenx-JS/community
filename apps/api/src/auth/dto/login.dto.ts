import { IsString, Length, Validate } from 'class-validator';
import { SafeIdentifierConstraint } from '../../common/safe-text.constraint';

export class LoginDto {
  /** Username or email address. */
  @IsString()
  @Length(1, 255)
  @Validate(SafeIdentifierConstraint)
  identifier!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}
