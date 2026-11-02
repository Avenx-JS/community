import { IsString, Length } from 'class-validator';

export class DeleteOwnAccountDto {
  /**
   * The account's current password, bounded as for login. A valid access
   * token alone is not enough to delete an account.
   */
  @IsString()
  @Length(12, 128)
  password!: string;
}
