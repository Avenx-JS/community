import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import type { MediaDto } from './media-dto';
import { PROFILE_IMAGE_PRESETS } from './media-processing';
import { ApiFileUpload, MediaResponse } from './media.responses';
import {
  MediaService,
  type CommunityImageSlot,
  type UploadedFile as MediaFile,
} from './media.service';

const NORMALISED = (preset: { width: number; height: number }) =>
  `Normalised to ${preset.width}×${preset.height} WebP: oriented, cropped ` +
  'from the centre to fill, first frame only, EXIF and all other metadata ' +
  'removed. Replaces and releases the previous image.';

const IMAGE_ERRORS = {
  400: 'No file, another form field, or a file that does not decode.',
  413: 'The file exceeds MEDIA_MAX_BYTES.',
  415: 'Not an allowed image type by its content (videos are refused too).',
} as const;

// The fixed-size images of accounts and communities. Each is uploaded
// straight into its slot, so there is never a pending profile image.
@ApiTags('media')
@Controller()
export class ProfileMediaController {
  constructor(private readonly media: MediaService) {}

  @Put('users/me/avatar')
  @UseGuards(AuthGuard)
  @ApiFileUpload('The new avatar image.')
  @ApiOperation({
    summary: 'Set your avatar',
    description: NORMALISED(PROFILE_IMAGE_PRESETS.avatar),
  })
  @ApiAuthenticated()
  @ApiOkResponse({ type: MediaResponse })
  @ApiErrorResponses(IMAGE_ERRORS)
  setAvatar(
    @UploadedFile() file: MediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<MediaDto> {
    return this.media.setAvatar(file, request.user.id);
  }

  @Delete('users/me/avatar')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove your avatar',
    description: 'Releases it. Idempotent: 204 without an avatar too.',
  })
  @ApiAuthenticated()
  @ApiNoContentResponse({ description: 'No avatar is set.' })
  clearAvatar(@Req() request: AuthenticatedRequest): Promise<void> {
    return this.media.clearAvatar(request.user.id);
  }

  @Put('communities/:name/icon')
  @UseGuards(AuthGuard)
  @ApiFileUpload('The new community icon.')
  @ApiOperation({
    summary: "Set a community's icon",
    description: `The community's creator only. ${NORMALISED(PROFILE_IMAGE_PRESETS.community_icon)}`,
  })
  @ApiAuthenticated({ forbidden: 'Only the community creator may edit it.' })
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiOkResponse({ type: MediaResponse })
  @ApiErrorResponses({
    ...IMAGE_ERRORS,
    404: 'Community not found, deleted or suspended.',
  })
  setIcon(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @UploadedFile() file: MediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<MediaDto> {
    return this.setImage(name, 'icon', file, request);
  }

  @Delete('communities/:name/icon')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Remove a community's icon",
    description: "The community's creator only. Idempotent.",
  })
  @ApiAuthenticated({ forbidden: 'Only the community creator may edit it.' })
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiNoContentResponse({ description: 'No icon is set.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found, deleted or suspended.',
  })
  clearIcon(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.media.clearCommunityImage(name, 'icon', request.user.id);
  }

  @Put('communities/:name/banner')
  @UseGuards(AuthGuard)
  @ApiFileUpload('The new community banner.')
  @ApiOperation({
    summary: "Set a community's banner",
    description: `The community's creator only. ${NORMALISED(PROFILE_IMAGE_PRESETS.community_banner)}`,
  })
  @ApiAuthenticated({ forbidden: 'Only the community creator may edit it.' })
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiOkResponse({ type: MediaResponse })
  @ApiErrorResponses({
    ...IMAGE_ERRORS,
    404: 'Community not found, deleted or suspended.',
  })
  setBanner(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @UploadedFile() file: MediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<MediaDto> {
    return this.setImage(name, 'banner', file, request);
  }

  @Delete('communities/:name/banner')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Remove a community's banner",
    description: "The community's creator only. Idempotent.",
  })
  @ApiAuthenticated({ forbidden: 'Only the community creator may edit it.' })
  @ApiRouteParam('name', 'communityName', 'Community name.')
  @ApiNoContentResponse({ description: 'No banner is set.' })
  @ApiErrorResponses({
    400: 'Invalid community name.',
    404: 'Community not found, deleted or suspended.',
  })
  clearBanner(
    @Param('name', new SafeRouteParamPipe('communityName')) name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.media.clearCommunityImage(name, 'banner', request.user.id);
  }

  private setImage(
    name: string,
    slot: CommunityImageSlot,
    file: MediaFile | undefined,
    request: AuthenticatedRequest,
  ): Promise<MediaDto> {
    return this.media.setCommunityImage(name, slot, file, request.user.id);
  }
}
