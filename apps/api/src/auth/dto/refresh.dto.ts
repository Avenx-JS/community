import { IsString, Length } from 'class-validator';

export class RefreshDto {
  @IsString()
  @Length(43, 43)
  refreshToken!: string;
}
