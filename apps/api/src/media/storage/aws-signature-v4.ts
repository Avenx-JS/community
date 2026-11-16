import { createHash, createHmac } from 'node:crypto';

// AWS Signature Version 4 for S3 requests, header-based. Small and
// dependency-free on purpose: the API needs PUT, GET and DELETE of single
// objects, which do not justify the AWS SDK. aws-signature-v4.spec.ts checks
// it against the worked example in the S3 documentation, and it works with
// any S3-compatible server (MinIO, Ceph, R2, ...).

export interface SignableRequest {
  method: 'GET' | 'PUT' | 'DELETE';
  url: URL;
  headers: Record<string, string>;
  // Hex SHA-256 of the body ('' hashes to e3b0…).
  payloadHash: string;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

export const sha256Hex = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding as SigV4 requires: everything but unreserved characters,
// and '/' kept in paths.
export function uriEncode(value: string, keepSlash: boolean): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === '/')) {
        return char;
      }
      return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

// Returns the headers to send: the given ones plus x-amz-date,
// x-amz-content-sha256, host and Authorization.
export function signRequest(
  request: SignableRequest,
  credentials: Credentials,
  now: Date,
): Record<string, string> {
  const service = credentials.service ?? 's3';
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value.trim().replace(/\s+/g, ' '),
    ]),
  );
  const query = [...request.url.searchParams.entries()]
    .map(([name, value]) => [uriEncode(name, false), uriEncode(value, false)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [
    request.method,
    uriEncode(decodeURIComponent(request.url.pathname), true),
    query,
    names.map((name) => `${name}:${lower[name]}\n`).join(''),
    names.join(';'),
    request.payloadHash,
  ].join('\n');
  const scope = `${date}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonical),
  ].join('\n');
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${credentials.secretAccessKey}`, date),
        credentials.region,
      ),
      service,
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}
