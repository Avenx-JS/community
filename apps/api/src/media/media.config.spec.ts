import { describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import { DEFAULT_ALLOWED_TYPES, readMediaConfig } from './media.config';

const S3 = {
  MEDIA_STORAGE: 's3',
  MEDIA_S3_ENDPOINT: 'http://127.0.0.1:9000/',
  MEDIA_S3_REGION: 'eu-central-1',
  MEDIA_S3_BUCKET: 'community-media',
  MEDIA_S3_ACCESS_KEY_ID: 'key',
  MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
};

describe('readMediaConfig', () => {
  it('defaults to a local directory and the safe limits', () => {
    expect(readMediaConfig({})).toEqual({
      driver: 'local',
      localDirectory: resolve('storage/media'),
      s3: undefined,
      publicBaseUrl: undefined,
      allowedTypes: DEFAULT_ALLOWED_TYPES,
      maxBytes: 10 * 1024 * 1024,
      maxPixels: 40_000_000,
      pendingMax: 20,
      pendingTtlHours: 24,
      sweepIntervalSeconds: 300,
    });
  });

  it('reads an S3-compatible backend, path-style by default', () => {
    expect(readMediaConfig(S3)).toMatchObject({
      driver: 's3',
      s3: {
        endpoint: 'http://127.0.0.1:9000',
        region: 'eu-central-1',
        bucket: 'community-media',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        forcePathStyle: true,
      },
    });
    expect(
      readMediaConfig({ ...S3, MEDIA_S3_FORCE_PATH_STYLE: 'false' }).s3
        ?.forcePathStyle,
    ).toBe(false);
  });

  // A misconfigured server must not start and fail at the first upload.
  it.each(Object.keys(S3).filter((name) => name !== 'MEDIA_STORAGE'))(
    'refuses S3 without %s',
    (name) => {
      expect(() => readMediaConfig({ ...S3, [name]: ' ' })).toThrow(name);
    },
  );

  it('narrows the allowed types, case-insensitively, to supported ones only', () => {
    expect(
      readMediaConfig({ MEDIA_ALLOWED_TYPES: 'image/PNG, image/webp' })
        .allowedTypes,
    ).toEqual(['image/png', 'image/webp']);
    expect(() =>
      readMediaConfig({ MEDIA_ALLOWED_TYPES: 'image/png,image/svg+xml' }),
    ).toThrow('image/svg+xml is not supported');
  });

  it.each([
    ['MEDIA_STORAGE', 'ftp'],
    ['MEDIA_MAX_BYTES', '100'],
    ['MEDIA_MAX_BYTES', '1.5'],
    ['MEDIA_MAX_PIXELS', '0'],
    ['MEDIA_PENDING_MAX', '1001'],
    ['MEDIA_PENDING_TTL_HOURS', '0'],
    ['MEDIA_SWEEP_INTERVAL_SECONDS', '-1'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => readMediaConfig({ [name]: value })).toThrow();
  });

  it('accepts a disabled sweep timer and a public base URL', () => {
    expect(
      readMediaConfig({
        MEDIA_SWEEP_INTERVAL_SECONDS: '0',
        MEDIA_PUBLIC_BASE_URL: 'https://cdn.example.com/media/',
      }),
    ).toMatchObject({
      sweepIntervalSeconds: 0,
      publicBaseUrl: 'https://cdn.example.com/media',
    });
  });
});
