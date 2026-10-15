import { IsString, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(1, 255)
  identifier!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}
