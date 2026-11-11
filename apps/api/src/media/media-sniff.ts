// The media type a file really is, read from its first bytes. The
// Content-Type and the filename a client sends are never trusted: anyone can
// label an HTML page or an executable image/png. Only these signatures are
// recognised, so a file that matches none is refused whatever it claims.
export const SNIFFABLE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;
export type MediaMimeType = (typeof SNIFFABLE_MEDIA_TYPES)[number];
export type MediaKind = 'image' | 'video';

export const kindOf = (type: MediaMimeType): MediaKind =>
  type.startsWith('image/') ? 'image' : 'video';

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, index) => buffer[offset + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

// ISO base media (MP4) major brands we accept. QuickTime ('qt  '), 3GP and
// HEIF share the box format but are not MP4 for a browser.
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
]);

export function sniffMediaType(buffer: Buffer): MediaMimeType | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (
    startsWith(buffer, ascii('GIF87a')) ||
    startsWith(buffer, ascii('GIF89a'))
  ) {
    return 'image/gif';
  }
  if (
    startsWith(buffer, ascii('RIFF')) &&
    startsWith(buffer, ascii('WEBP'), 8)
  ) {
    return 'image/webp';
  }
  // An MP4 starts with its ftyp box: a 4-byte size, 'ftyp', the major brand.
  if (startsWith(buffer, ascii('ftyp'), 4) && buffer.length >= 12) {
    const brand = buffer.subarray(8, 12).toString('latin1');
    return MP4_BRANDS.has(brand) ? 'video/mp4' : null;
  }
  // EBML header; a WebM declares the doctype "webm" within its first bytes.
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return buffer.subarray(0, 64).includes(Buffer.from('webm'))
      ? 'video/webm'
      : null;
  }
  return null;
}

export const EXTENSIONS: Record<MediaMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
