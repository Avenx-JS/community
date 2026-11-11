import sharp from 'sharp';
import { kindOf, type MediaMimeType } from './media-sniff';

// The fixed shapes of profile images. Each is cropped to fill (cover, from
// the centre) and stored as WebP, whatever was uploaded.
export const PROFILE_IMAGE_PRESETS = {
  avatar: { width: 256, height: 256 },
  community_icon: { width: 256, height: 256 },
  community_banner: { width: 1536, height: 384 },
} as const;
export type ProfileImagePurpose = keyof typeof PROFILE_IMAGE_PRESETS;
export type MediaPurpose = 'post' | ProfileImagePurpose;

export interface ProcessedMedia {
  body: Buffer;
  mimeType: MediaMimeType;
  width: number | null;
  height: number | null;
}

// A file whose bytes look like an allowed type but do not decode as one.
export class UndecodableMediaError extends Error {}

const sharpOptions = (maxPixels: number, animated: boolean) => ({
  limitInputPixels: maxPixels,
  animated,
  // Refuse rather than render a truncated or corrupt image.
  failOn: 'error' as const,
});

async function readMetadata(body: Buffer, maxPixels: number) {
  try {
    return await sharp(body, sharpOptions(maxPixels, true)).metadata();
  } catch (error) {
    throw new UndecodableMediaError(
      error instanceof Error ? error.message : 'Unreadable image',
    );
  }
}

// A post's image keeps its format and size, but is decoded and re-encoded:
// that proves it is an image, applies and drops the EXIF orientation, and
// writes no metadata at all (sharp keeps none unless asked), so EXIF, GPS,
// XMP and ICC comments are gone. Animated GIF and WebP keep their frames.
// A video is stored as uploaded: re-encoding needs ffmpeg, so its container
// metadata is not stripped (see the README).
export async function processPostMedia(
  body: Buffer,
  mimeType: MediaMimeType,
  maxPixels: number,
): Promise<ProcessedMedia> {
  if (kindOf(mimeType) === 'video') {
    return { body, mimeType, width: null, height: null };
  }
  const metadata = await readMetadata(body, maxPixels);
  const animated = (metadata.pages ?? 1) > 1;
  try {
    let image = sharp(body, sharpOptions(maxPixels, animated));
    // Auto-orientation is per frame and not supported on animations, whose
    // formats (GIF, WebP) carry no EXIF orientation anyway.
    if (!animated) {
      image = image.rotate();
    }
    switch (mimeType) {
      case 'image/jpeg':
        image = image.jpeg({ quality: 85, mozjpeg: true });
        break;
      case 'image/png':
        image = image.png();
        break;
      case 'image/gif':
        image = image.gif();
        break;
      case 'image/webp':
        image = image.webp({ quality: 85 });
        break;
    }
    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    return {
      body: data,
      mimeType,
      width: info.width,
      // An animation reports the height of all frames stacked.
      height: animated ? (info.pageHeight ?? info.height) : info.height,
    };
  } catch (error) {
    throw new UndecodableMediaError(
      error instanceof Error ? error.message : 'Unreadable image',
    );
  }
}

// An avatar, icon or banner: oriented, cropped to its preset, first frame
// only, WebP, no metadata.
export async function normaliseProfileImage(
  body: Buffer,
  purpose: ProfileImagePurpose,
  maxPixels: number,
): Promise<ProcessedMedia> {
  await readMetadata(body, maxPixels);
  const { width, height } = PROFILE_IMAGE_PRESETS[purpose];
  try {
    const data = await sharp(body, sharpOptions(maxPixels, false))
      .rotate()
      .resize(width, height, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85 })
      .toBuffer();
    return { body: data, mimeType: 'image/webp', width, height };
  } catch (error) {
    throw new UndecodableMediaError(
      error instanceof Error ? error.message : 'Unreadable image',
    );
  }
}
