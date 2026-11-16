import { IsString, Length, Matches } from 'class-validator';

// Body of POST /communities/:name/transfer.
export class TransferCommunityDto {
  /**
   * The new owner: a current moderator of the community. The rules of
   * ManageModeratorDto.
   */
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;

  /**
   * The community's name exactly as in the route, as confirmation, as
   * DELETE /communities/:name asks: handing a community away cannot be undone
   * by the one who did it.
   */
  @IsString()
  @Length(1, 50)
  confirm_name!: string;
}
