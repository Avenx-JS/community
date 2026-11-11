import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { readMediaConfig, type MediaConfig } from './media.config';
import type { MediaKind, MediaMimeType } from './media-sniff';
import type { MediaPurpose } from './media-processing';
import { MEDIA_COLUMNS } from './media-sql';

export interface MediaRow extends RowDataPacket {
  id: string;
  uploader_id: string | null;
  purpose: MediaPurpose;
  kind: MediaKind;
  mime_type: MediaMimeType;
  size_bytes: number;
  width: number | null;
  height: number | null;
  storage_key: string;
  created_at: Date | string;
}

// What a client needs to show a file. Never the storage key or the
// uploader: the key is an internal address, and who uploaded a post's file
// is the post's author, already on the post.
export interface MediaDto {
  id: string;
  kind: MediaKind;
  mime_type: MediaMimeType;
  size_bytes: number;
  // null for a video, whose dimensions the API does not decode.
  width: number | null;
  height: number | null;
  url: string;
  created_at: string;
}

let cached: MediaConfig | undefined;
// The process's media configuration, read once on first use, for the
// mappers that run outside dependency injection (toPostDtos, profiles).
export function mediaConfig(): MediaConfig {
  cached ??= readMediaConfig();
  return cached;
}

// GET /media/:id/file, relative to the API origin, unless
// MEDIA_PUBLIC_BASE_URL serves the objects directly.
export function mediaUrl(
  row: Pick<MediaRow, 'id' | 'storage_key'>,
  config: MediaConfig = mediaConfig(),
): string {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl}/${row.storage_key}`
    : `/media/${row.id}/file`;
}

export function toMediaDto(row: MediaRow, config?: MediaConfig): MediaDto {
  return {
    id: row.id,
    kind: row.kind,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    url: mediaUrl(row, config),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export const mediaByIdsSql = (count: number) =>
  `SELECT ${MEDIA_COLUMNS} FROM media WHERE media.id IN (${Array.from({ length: count }, () => '?').join(', ')})`;

// The files of one page, as one statement over the page's ids (like the
// vote scores); a page without files issues none.
export async function loadMediaByIds(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, MediaDto>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) {
    return new Map();
  }
  const [rows] = await executor.execute<MediaRow[]>(
    mediaByIdsSql(unique.length),
    unique,
  );
  return new Map(rows.map((row) => [row.id, toMediaDto(row)]));
}
