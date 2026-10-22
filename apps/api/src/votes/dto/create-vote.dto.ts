import { IsIn, IsString, Length } from 'class-validator';

export class CreateVoteDto {
  @IsIn(['post', 'comment'])
  target_type!: 'post' | 'comment';

  @IsString()
  @Length(1, 36)
  target_id!: string;

  @IsIn([-1, 1])
  value!: -1 | 1;
}
