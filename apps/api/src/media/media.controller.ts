import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard';
import {
  OptionalAuthGuard,
  type OptionallyAuthenticatedRequest,
} from '../auth/optional-auth.guard';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import type { MediaDto } from './media-dto';
import { ApiFileUpload, MediaResponse } from './media.responses';
import { MediaService, type UploadedFile as MediaFile } from './media.service';

const UPLOAD_ERRORS = {
  400: 'No file, another form field, or a file that does not decode as the type it is.',
  413: 'The file exceeds MEDIA_MAX_BYTES.',
  415: "The file's content is not one of MEDIA_ALLOWED_TYPES, whatever its Content-Type says.",
} as const;

const VISIBILITY =
  'Visible while the content using it is: a listed post (not removed, its ' +
  'community neither deleted nor suspended), an existing account, a visible ' +
  'community; and to its uploader until it is released. Otherwise, and once ' +
  'released, 404.';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiFileUpload('An image or video for a post.')
  @ApiOperation({
    summary: 'Upload an image or video for a post',
    description:
      'Multipart form with one field, file. The type is detected from the ' +
      "file's content. Images are re-encoded: orientation applied, EXIF and " +
      'all other metadata removed, size kept. Videos are stored as uploaded. ' +
      'The file stays yours and unattached until POST /posts uses its ' +
      'media_id; unattached uploads are released after ' +
      'MEDIA_PENDING_TTL_HOURS, and at most MEDIA_PENDING_MAX may wait.',
  })
  @ApiAuthenticated()
  @ApiCreatedResponse({ type: MediaResponse })
  @ApiErrorResponses({
    ...UPLOAD_ERRORS,
    409: 'You already have MEDIA_PENDING_MAX unattached uploads.',
  })
  upload(
    @UploadedFile() file: MediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<MediaDto> {
    return this.media.upload(file, request.user.id);
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Get media metadata',
    description: `Type, size and dimensions, and the URL to fetch it. ${VISIBILITY}`,
  })
  @ApiRouteParam('id', 'id', 'Media ID.')
  @ApiOkResponse({ type: MediaResponse })
  @ApiErrorResponses({ 400: 'Invalid media ID.', 404: 'Media not found.' })
  findOne(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request?: OptionallyAuthenticatedRequest,
  ): Promise<MediaDto> {
    return this.media.findVisible(id, request?.user?.id);
  }

  @Get(':id/file')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Download a media file',
    description: `The stored bytes, with their detected type. ${VISIBILITY}`,
  })
  @ApiRouteParam('id', 'id', 'Media ID.')
  @ApiProduces(...['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
  @ApiProduces('video/mp4', 'video/webm')
  @ApiOkResponse({
    description: 'The file.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiErrorResponses({ 400: 'Invalid media ID.', 404: 'Media not found.' })
  async file(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Res() response: Response,
    @Req() request?: OptionallyAuthenticatedRequest,
  ): Promise<void> {
    const { body, mimeType } = await this.media.readFile(id, request?.user?.id);
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', mimeType);
    response.setHeader('Content-Length', String(body.length));
    // The type is the one the server detected; a browser must not guess
    // another, and nothing in the file may run as a page.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    response.setHeader('Content-Disposition', 'inline');
    // Short and private: visibility follows the content, which can be
    // removed at any time.
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.end(body);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete your upload',
    description:
      'Only your own upload, and only while no post uses it; another ' +
      "account's file is 404. To release a post's file, delete the post.",
  })
  @ApiAuthenticated()
  @ApiRouteParam('id', 'id', 'Media ID.')
  @ApiNoContentResponse({ description: 'The upload is released.' })
  @ApiErrorResponses({
    400: 'Invalid media ID.',
    404: 'Media not found, not yours, or already released.',
    409: 'A post uses it, or it is a profile image.',
  })
  remove(
    @Param('id', new SafeRouteParamPipe('id')) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.media.deleteUpload(id, request.user.id);
  }
}
