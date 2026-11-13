import { createHash, createHmac } from 'node:crypto';
import type { S3StorageConfig } from '../media.config';
import { assertValidKey, type MediaStorage } from './media-storage';

export class S3MediaStorage implements MediaStorage {
  constructor(private readonly config: S3StorageConfig) {}

  private getUrl(key: string): { url: URL; host: string; path: string } {
    const rawEndpoint = this.config.endpoint.replace(/\/+$/, '');
    const endpointUrl = new URL(rawEndpoint);

    if (this.config.forcePathStyle) {
      const path = `/${this.config.bucket}/${key}`;
      const url = new URL(path, endpointUrl);
      return { url, host: endpointUrl.host, path };
    }

    const host = `${this.config.bucket}.${endpointUrl.host}`;
    const path = `/${key}`;
    const url = new URL(`${endpointUrl.protocol}//${host}${path}`);
    return { url, host, path };
  }

  private sign(
    method: string,
    host: string,
    path: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    const sortedHeaderKeys = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort();

    const canonicalHeaders = sortedHeaderKeys
      .map((k) => `${k}:${headers[k].trim()}\n`)
      .join('');

    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      path,
      '', // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const canonicalRequestHash = createHash('sha256')
      .update(canonicalRequest)
      .digest('hex');

    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      canonicalRequestHash,
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${this.config.secretAccessKey}`)
      .update(dateStamp)
      .digest();
    const kRegion = createHmac('sha256', kDate)
      .update(this.config.region)
      .digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService)
      .update('aws4_request')
      .digest();

    const signature = createHmac('sha256', kSigning)
      .update(stringToSign)
      .digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      ...headers,
      authorization,
    };
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<void> {
    assertValidKey(key);
    const { url, host, path } = this.getUrl(key);
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const extraHeaders: Record<string, string> = {
      'content-type': mimeType,
      'x-amz-acl': 'private',
    };
    const signedHeaders = this.sign(
      'PUT',
      host,
      path,
      payloadHash,
      extraHeaders,
    );

    const response = await fetch(url.toString(), {
      method: 'PUT',
      headers: signedHeaders,
      body: new Uint8Array(body),
    });

    if (!response.ok) {
      throw new Error(
        `S3 PUT ${key} failed with status ${response.status} ${response.statusText}`,
      );
    }
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidKey(key);
    const { url, host, path } = this.getUrl(key);
    const payloadHash = createHash('sha256').update('').digest('hex');
    const signedHeaders = this.sign('GET', host, path, payloadHash);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: signedHeaders,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `S3 GET ${key} failed with status ${response.status} ${response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const { url, host, path } = this.getUrl(key);
    const payloadHash = createHash('sha256').update('').digest('hex');
    const signedHeaders = this.sign('DELETE', host, path, payloadHash);

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: signedHeaders,
    });

    // 204, 200, or 404 all count as successful delete
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `S3 DELETE ${key} failed with status ${response.status} ${response.statusText}`,
      );
    }
  }
}
