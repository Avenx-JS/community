import { IsString, Length } from 'class-validator';

export class DeleteCommunityDto {
  /**
   * The community's name exactly as in the route, as confirmation. A valid
   * access token and the route alone are not enough to delete a community.
   */
  @IsString()
  @Length(1, 50)
  name!: string;
}
