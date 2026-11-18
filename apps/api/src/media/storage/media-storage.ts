import { EXTENSIONS } from '../media-sniff';

export interface MediaStorage {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

// The only keys the API ever generates: <first two characters of the id>/
// <id>.<extension>, the id a UUID, the extension one media-sniff produces.
// Every driver refuses anything else before touching the disk or the
// network, so a key can never climb out of the directory, address another
// bucket, or name a file type the API would not serve (.html).
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_PATTERN = new RegExp(
  `^([0-9a-f]{2})/(${UUID})\\.(${Object.values(EXTENSIONS).join('|')})$`,
);

export function assertStorageKey(key: string): void {
  const match = KEY_PATTERN.exec(key);
  if (!match || !match[2].startsWith(match[1])) {
    throw new Error('Invalid media storage key');
  }
}

// Sharded by the id's first two characters, so no directory grows without
// bound.
export function storageKey(id: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension.slice(1) : extension;
  const key = `${id.slice(0, 2)}/${id}.${ext}`;
  assertStorageKey(key);
  return key;
}
