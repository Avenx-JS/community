import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, signRequest } from './aws-signature-v4';
import { LocalMediaStorage } from './local-media-storage';
import { assertStorageKey, storageKey } from './media-storage';
import { S3MediaStorage } from './s3-media-storage';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('storage keys', () => {
  it('are generated from the id, sharded by its first two characters', () => {
    expect(storageKey(ID, 'webp')).toBe(`0f/${ID}.webp`);
  });

  it.each([
    '../etc/passwd',
    `/0f/${ID}.webp`,
    `0f/../${ID}.webp`,
    `0f/${ID}.html`,
    `0f\\${ID}.webp`,
    'other-bucket/key.webp',
    '',
  ])('refuse %p', (key) => {
    expect(() => assertStorageKey(key)).toThrow('Invalid media storage key');
  });
});

describe('AWS Signature Version 4', () => {
  // The worked example "GET Object" from the Amazon S3 API reference
  // (Signature Version 4, header-based authentication).
  it('reproduces the documented signature', () => {
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { range: 'bytes=0-9' },
        payloadHash: sha256Hex(''),
      },
      {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
      },
      new Date('2013-05-24T00:00:00Z'),
    );
    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });
});

describe('S3MediaStorage', () => {
  const config = {
    endpoint: 'http://127.0.0.1:9000',
    region: 'eu-central-1',
    bucket: 'media',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    forcePathStyle: true,
  };
  const key = `0f/${ID}.webp`;
  const respond = (status: number, body = '') =>
    jest.fn(() => Promise.resolve(new Response(body || null, { status })));

  it('PUTs a signed object, path-style, with its type and length', async () => {
    const fetcher = respond(200);
    await new S3MediaStorage(config, fetcher).put(
      key,
      Buffer.from('bytes'),
      'image/webp',
    );
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`http://127.0.0.1:9000/media/${key}`);
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'content-type': 'image/webp',
      'content-length': '5',
      'x-amz-content-sha256': sha256Hex(Buffer.from('bytes')),
    });
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // fetch sets Host itself.
    expect(headers).not.toHaveProperty('host');
  });

  it('addresses a bucket virtual-hosted style when asked', () => {
    const storage = new S3MediaStorage({
      ...config,
      endpoint: 'https://s3.eu-central-1.amazonaws.com',
      forcePathStyle: false,
    });
    expect(String(storage.objectUrl(key))).toBe(
      `https://media.s3.eu-central-1.amazonaws.com/${key}`,
    );
  });

  it('reads an object, and a missing one as null', async () => {
    expect(
      await new S3MediaStorage(
        config,
        respond(200, 'data') as typeof fetch,
      ).get(key),
    ).toEqual(Buffer.from('data'));
    expect(
      await new S3MediaStorage(config, respond(404) as typeof fetch).get(key),
    ).toBeNull();
  });

  it('deletes idempotently', async () => {
    for (const status of [204, 404]) {
      await expect(
        new S3MediaStorage(config, respond(status) as typeof fetch).delete(key),
      ).resolves.toBeUndefined();
    }
  });

  // The error names the status and key only: never an S3 error body, which
  // can echo request details.
  it('fails with the status, without the response body', async () => {
    const storage = new S3MediaStorage(
      config,
      respond(403, '<Error>SignatureDoesNotMatch secret-ish</Error>'),
    );
    await expect(
      storage.put(key, Buffer.from('x'), 'image/webp'),
    ).rejects.toThrow(`S3 PUT ${key} failed with 403`);
    await expect(storage.get(key)).rejects.not.toThrow(/secret-ish/);
  });

  it('refuses a key outside the generated shape before any request', async () => {
    const fetcher = respond(200);
    await expect(
      new S3MediaStorage(config, fetcher as typeof fetch).get('../other'),
    ).rejects.toThrow('Invalid media storage key');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('LocalMediaStorage', () => {
  let root: string;
  let storage: LocalMediaStorage;
  const key = `0f/${ID}.png`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'media-storage-'));
    storage = new LocalMediaStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes, reads and deletes, leaving no temporary file', async () => {
    await storage.put(key, Buffer.from('png bytes'));
    expect(await storage.get(key)).toEqual(Buffer.from('png bytes'));
    expect(await readdir(join(root, '0f'))).toEqual([`${ID}.png`]);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    // Deleting again succeeds.
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('never leaves its directory', async () => {
    await expect(storage.get('../outside.png')).rejects.toThrow(
      'Invalid media storage key',
    );
    await expect(
      storage.put('../../etc/passwd', Buffer.from('x')),
    ).rejects.toThrow('Invalid media storage key');
  });
});
