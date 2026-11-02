import {
  IsString,
  Length,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// A change to the same password would report success without changing
// anything; users submit it by accident.
@ValidatorConstraint({ name: 'newPasswordDiffersFromCurrent', async: false })
export class NewPasswordDiffersFromCurrentConstraint implements ValidatorConstraintInterface {
  validate(newPassword: unknown, args: ValidationArguments): boolean {
    const input = args.object as ChangePasswordDto;
    return newPassword !== input.current_password;
  }

  defaultMessage(): string {
    return 'new_password must differ from current_password';
  }
}

export class ChangePasswordDto {
  @IsString()
  @Length(12, 128)
  current_password!: string;

  @IsString()
  @Length(12, 128)
  @Validate(NewPasswordDiffersFromCurrentConstraint)
  new_password!: string;
}
