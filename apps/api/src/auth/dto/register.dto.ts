import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}
