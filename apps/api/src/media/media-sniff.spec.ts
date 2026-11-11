import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';
import { kindOf, sniffMediaType } from './media-sniff';

const bytes = (...values: number[]) => Buffer.from(values);
const text = (value: string) => Buffer.from(value, 'latin1');
const pixel = () =>
  sharp({
    create: { width: 2, height: 2, channels: 3, background: '#336699' },
  });

describe('sniffMediaType', () => {
  it.each([
    ['image/jpeg', () => pixel().jpeg().toBuffer()],
    ['image/png', () => pixel().png().toBuffer()],
    ['image/gif', () => pixel().gif().toBuffer()],
    ['image/webp', () => pixel().webp().toBuffer()],
  ])('recognises a real %s by its bytes', async (type, make) => {
    expect(sniffMediaType(await make())).toBe(type);
  });

  it.each([
    [
      'video/mp4',
      Buffer.concat([bytes(0, 0, 0, 0x20), text('ftypisom'), Buffer.alloc(20)]),
    ],
    [
      'video/mp4',
      Buffer.concat([bytes(0, 0, 0, 0x18), text('ftypmp42'), Buffer.alloc(12)]),
    ],
    [
      'video/webm',
      Buffer.concat([
        bytes(0x1a, 0x45, 0xdf, 0xa3),
        Buffer.alloc(8),
        text('webm'),
        Buffer.alloc(20),
      ]),
    ],
  ])('recognises %s by its container header', (type, buffer) => {
    expect(sniffMediaType(buffer)).toBe(type);
  });

  // What a client claims is irrelevant: these are refused whatever their
  // Content-Type or filename said.
  it.each([
    ['an HTML page', text('<!doctype html><script>alert(1)</script>')],
    [
      'an SVG, which can carry script',
      text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    ],
    ['a Windows executable', Buffer.concat([text('MZ'), Buffer.alloc(64)])],
    ['a PDF', text('%PDF-1.7\n')],
    ['a ZIP', bytes(0x50, 0x4b, 0x03, 0x04, 0, 0)],
    [
      'QuickTime, not MP4',
      Buffer.concat([bytes(0, 0, 0, 0x14), text('ftypqt  '), Buffer.alloc(12)]),
    ],
    [
      'HEIC',
      Buffer.concat([bytes(0, 0, 0, 0x18), text('ftypheic'), Buffer.alloc(12)]),
    ],
    [
      'Matroska, not WebM',
      Buffer.concat([
        bytes(0x1a, 0x45, 0xdf, 0xa3),
        text('matroska'),
        Buffer.alloc(20),
      ]),
    ],
    [
      'RIFF that is not WebP (WAV)',
      Buffer.concat([text('RIFF'), bytes(0, 0, 0, 0), text('WAVE')]),
    ],
    ['a truncated JPEG marker', bytes(0xff, 0xd8)],
    ['nothing', Buffer.alloc(0)],
  ])('refuses %s', (_name, buffer) => {
    expect(sniffMediaType(buffer)).toBeNull();
  });

  it('classifies kinds', () => {
    expect(kindOf('image/webp')).toBe('image');
    expect(kindOf('video/mp4')).toBe('video');
  });
});
