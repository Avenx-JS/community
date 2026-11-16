export interface MediaStorage {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

const KEY_PATTERN = /^[0-9a-f]{2}\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/;

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

export function storageKey(id: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension.slice(1) : extension;
  const hex = (id.replace(/[^0-9a-fA-F]/g, '').slice(0, 2) || '00')
    .toLowerCase()
    .padStart(2, '0');
  return `${hex}/${id}.${ext}`;
}
