import type { S3StorageConfig } from '../media.config';
import { sha256Hex, signRequest } from './aws-signature-v4';
import { assertStorageKey, type MediaStorage } from './media-storage';

// The HTTP side, replaceable in tests.
export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;

// S3 or any S3-compatible server (MinIO, Ceph, R2), signed with
// aws-signature-v4.ts: PUT, GET and DELETE of single objects, no SDK.
// Errors name the method, key and status only, never the response body,
// which can echo request details.
export class S3MediaStorage implements MediaStorage {
  constructor(
    private readonly config: S3StorageConfig,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}

  // Path-style (endpoint/bucket/key) or virtual-hosted (bucket.endpoint/key).
  objectUrl(key: string): URL {
    const endpoint = new URL(this.config.endpoint.replace(/\/+$/, ''));
    const base = endpoint.pathname.replace(/\/+$/, '');
    if (this.config.forcePathStyle) {
      return new URL(`${endpoint.origin}${base}/${this.config.bucket}/${key}`);
    }
    return new URL(
      `${endpoint.protocol}//${this.config.bucket}.${endpoint.host}${base}/${key}`,
    );
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<void> {
    const response = await this.send('PUT', key, body, {
      'content-type': mimeType,
      'content-length': String(body.length),
    });
    this.assertOk('PUT', key, response);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.send('GET', key);
    if (response.status === 404) {
      return null;
    }
    this.assertOk('GET', key, response);
    return Buffer.from(await response.arrayBuffer());
  }

  // Idempotent: a missing object is already deleted.
  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key);
    if (response.status === 404) {
      return;
    }
    this.assertOk('DELETE', key, response);
  }

  private send(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    body?: Buffer,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    assertStorageKey(key);
    const url = this.objectUrl(key);
    const signed = signRequest(
      { method, url, headers, payloadHash: sha256Hex(body ?? '') },
      {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        region: this.config.region,
      },
      new Date(),
    );
    // fetch sets Host itself, from the URL that was signed.
    const { host: _host, ...sent } = signed;
    void _host;
    return this.fetcher(url, {
      method,
      headers: sent,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  private assertOk(method: string, key: string, response: Response): void {
    if (!response.ok) {
      throw new Error(`S3 ${method} ${key} failed with ${response.status}`);
    }
  }
}
