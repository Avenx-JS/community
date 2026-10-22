import { IsString, Length, Matches } from 'class-validator';

export class ManageModeratorDto {
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;
}
