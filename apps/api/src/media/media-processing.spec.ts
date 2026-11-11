import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';
import {
  normaliseProfileImage,
  processPostMedia,
  PROFILE_IMAGE_PRESETS,
  UndecodableMediaError,
} from './media-processing';

const MAX_PIXELS = 40_000_000;

// A 40×20 photo as a phone writes it: EXIF with a camera, a copyright and
// GPS-like text, and orientation 6 (rotate 90° clockwise to display).
async function phonePhoto(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 20, channels: 3, background: '#cc3300' },
  })
    .withExif({
      IFD0: {
        Make: 'PhoneMaker',
        Model: 'Secret Phone 9',
        Copyright: 'GPS 52.5200N 13.4050E',
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

describe('processPostMedia', () => {
  it('keeps the size and format, applies the orientation and drops all metadata', async () => {
    const input = await phonePhoto();
    const before = await sharp(input).metadata();
    expect(before).toMatchObject({ orientation: 6, width: 40, height: 20 });
    expect(before.exif).toBeDefined();

    const output = await processPostMedia(input, 'image/jpeg', MAX_PIXELS);

    expect(output).toMatchObject({
      mimeType: 'image/jpeg',
      // Rotated upright: 40×20 stored sideways is 20×40 to display.
      width: 20,
      height: 40,
    });
    const after = await sharp(output.body).metadata();
    expect(after).toMatchObject({ format: 'jpeg', width: 20, height: 40 });
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(output.body.includes(Buffer.from('Secret Phone'))).toBe(false);
    expect(output.body.includes(Buffer.from('52.5200N'))).toBe(false);
  });

  it.each(['png', 'webp', 'gif'] as const)(
    're-encodes a %s as itself',
    async (format) => {
      const input = await sharp({
        create: { width: 8, height: 6, channels: 4, background: '#00000080' },
      })
        .toFormat(format)
        .toBuffer();
      const output = await processPostMedia(
        input,
        `image/${format}`,
        MAX_PIXELS,
      );
      expect(output).toMatchObject({ width: 8, height: 6 });
      expect((await sharp(output.body).metadata()).format).toBe(format);
    },
  );

  it('keeps every frame of an animation, reporting one frame’s size', async () => {
    const frames = await Promise.all(
      ['#ff0000', '#00ff00', '#0000ff'].map((background) =>
        sharp({ create: { width: 10, height: 10, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const gif = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(3);

    const output = await processPostMedia(gif, 'image/gif', MAX_PIXELS);
    expect(output).toMatchObject({ width: 10, height: 10 });
    expect(
      (await sharp(output.body, { animated: true }).metadata()).pages,
    ).toBe(3);
  });

  it('stores a video as uploaded, without dimensions', async () => {
    const video = Buffer.from('not decoded');
    await expect(
      processPostMedia(video, 'video/mp4', MAX_PIXELS),
    ).resolves.toEqual({
      body: video,
      mimeType: 'video/mp4',
      width: null,
      height: null,
    });
  });

  it('refuses bytes that only start like an image', async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('this is not a PNG'),
    ]);
    await expect(
      processPostMedia(fake, 'image/png', MAX_PIXELS),
    ).rejects.toBeInstanceOf(UndecodableMediaError);
  });

  // A decompression bomb: few bytes, many pixels.
  it('refuses an image above the pixel limit before decoding it', async () => {
    const large = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(large.length).toBeLessThan(100_000);
    await expect(
      processPostMedia(large, 'image/png', 1_000_000),
    ).rejects.toBeInstanceOf(UndecodableMediaError);
  });
});

describe('normaliseProfileImage', () => {
  it.each(Object.entries(PROFILE_IMAGE_PRESETS))(
    'normalises a %s to its fixed WebP size without metadata',
    async (purpose, { width, height }) => {
      const output = await normaliseProfileImage(
        await phonePhoto(),
        purpose as keyof typeof PROFILE_IMAGE_PRESETS,
        MAX_PIXELS,
      );
      expect(output).toMatchObject({ mimeType: 'image/webp', width, height });
      const metadata = await sharp(output.body).metadata();
      expect(metadata).toMatchObject({ format: 'webp', width, height });
      expect(metadata.exif).toBeUndefined();
      expect(output.body.includes(Buffer.from('Secret Phone'))).toBe(false);
    },
  );

  it('refuses an undecodable file', async () => {
    await expect(
      normaliseProfileImage(
        Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        'avatar',
        MAX_PIXELS,
      ),
    ).rejects.toBeInstanceOf(UndecodableMediaError);
  });
});
