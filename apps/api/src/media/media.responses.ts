import { ApiProperty } from '@nestjs/swagger';
import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { mediaConfig, type MediaDto } from './media-dto';
import {
  SNIFFABLE_MEDIA_TYPES,
  type MediaKind,
  type MediaMimeType,
} from './media-sniff';

export class MediaResponse implements MediaDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['image', 'video'] })
  kind!: MediaKind;

  @ApiProperty({
    enum: SNIFFABLE_MEDIA_TYPES,
    description:
      'The type the server detected from the content (profile images are ' +
      'always image/webp), never the one the client sent.',
  })
  mime_type!: MediaMimeType;

  @ApiProperty({ type: 'integer', description: 'Size of the stored file.' })
  size_bytes!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Pixels; null for a video.',
  })
  width!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Pixels; null for a video.',
  })
  height!: number | null;

  @ApiProperty({
    description:
      'Where to fetch the file: GET /media/{id}/file, relative to the API, ' +
      'or a public storage URL when the server is configured for one.',
  })
  url!: string;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

// One file in a multipart/form-data field named file, read into memory
// (multer keeps files in memory when no destination is set), up
// to MEDIA_MAX_BYTES and no further: multer stops reading at the limit and
// the route answers 413. No other part is accepted.
export function ApiFileUpload(description: string) {
  return applyDecorators(
    UseInterceptors(
      FileInterceptor('file', {
        limits: {
          fileSize: mediaConfig().maxBytes,
          files: 1,
          fields: 0,
        },
      }),
    ),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary', description },
        },
      },
    }),
  );
}
