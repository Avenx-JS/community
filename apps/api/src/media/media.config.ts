import { resolve } from 'node:path';
import { SNIFFABLE_MEDIA_TYPES, type MediaMimeType } from './media-sniff';

export type MediaStorageDriver = 'local' | 's3';

export interface S3StorageConfig {
  // e.g. https://s3.eu-central-1.amazonaws.com or http://127.0.0.1:9000
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Path-style (endpoint/bucket/key) works with every S3-compatible server;
  // virtual-hosted style (bucket.endpoint/key) is AWS's default.
  forcePathStyle: boolean;
}

export interface MediaConfig {
  driver: MediaStorageDriver;
  localDirectory: string;
  s3?: S3StorageConfig;
  // When set, file URLs point here (a CDN or a public bucket) instead of
  // GET /media/:id/file, and the API no longer decides who may fetch a file.
  publicBaseUrl?: string;
  allowedTypes: readonly MediaMimeType[];
  maxBytes: number;
  // Decoded pixels an image may have: a guard against decompression bombs,
  // whose few compressed bytes expand to gigabytes.
  maxPixels: number;
  // Uploads not yet attached to a post, per account, and how long they wait
  // before the sweep releases them.
  pendingMax: number;
  pendingTtlHours: number;
  // Seconds between cleanup sweeps; 0 disables the timer.
  sweepIntervalSeconds: number;
}

export const DEFAULT_ALLOWED_TYPES: readonly MediaMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set when MEDIA_STORAGE=s3`);
  }
  return value;
}

export function readAllowedTypes(
  raw: string | undefined,
): readonly MediaMimeType[] {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ALLOWED_TYPES;
  }
  const types = raw
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
  for (const type of types) {
    if (!(SNIFFABLE_MEDIA_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `MEDIA_ALLOWED_TYPES: ${type} is not supported; choose from ${SNIFFABLE_MEDIA_TYPES.join(', ')}`,
      );
    }
  }
  return types as MediaMimeType[];
}

// Read once at startup, like every other limit (readPositiveInteger): a
// misconfigured server fails to start rather than at the first upload.
export function readMediaConfig(env = process.env): MediaConfig {
  const driver = (env.MEDIA_STORAGE ?? 'local').trim().toLowerCase();
  if (driver !== 'local' && driver !== 's3') {
    throw new Error('MEDIA_STORAGE must be local or s3');
  }
  const publicBaseUrl = env.MEDIA_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  return {
    driver,
    localDirectory: resolve(env.MEDIA_LOCAL_DIR?.trim() || 'storage/media'),
    s3:
      driver === 's3'
        ? {
            endpoint: required(env, 'MEDIA_S3_ENDPOINT').replace(/\/+$/, ''),
            region: required(env, 'MEDIA_S3_REGION'),
            bucket: required(env, 'MEDIA_S3_BUCKET'),
            accessKeyId: required(env, 'MEDIA_S3_ACCESS_KEY_ID'),
            secretAccessKey: required(env, 'MEDIA_S3_SECRET_ACCESS_KEY'),
            forcePathStyle:
              (env.MEDIA_S3_FORCE_PATH_STYLE ?? 'true').trim() !== 'false',
          }
        : undefined,
    publicBaseUrl: publicBaseUrl || undefined,
    allowedTypes: readAllowedTypes(env.MEDIA_ALLOWED_TYPES),
    // 1 KiB to 1 GiB; the default suits photos and short clips.
    maxBytes: readInteger(
      env,
      'MEDIA_MAX_BYTES',
      10 * 1024 * 1024,
      1024,
      2 ** 30,
    ),
    maxPixels: readInteger(env, 'MEDIA_MAX_PIXELS', 40_000_000, 1, 2 ** 30),
    pendingMax: readInteger(env, 'MEDIA_PENDING_MAX', 20, 1, 1000),
    pendingTtlHours: readInteger(env, 'MEDIA_PENDING_TTL_HOURS', 24, 1, 720),
    sweepIntervalSeconds: readInteger(
      env,
      'MEDIA_SWEEP_INTERVAL_SECONDS',
      300,
      0,
      86400,
    ),
  };
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export const MEDIA_CONFIG = Symbol('MEDIA_CONFIG');
