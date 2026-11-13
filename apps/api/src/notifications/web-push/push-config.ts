import { readPositiveInteger } from '../../common/read-positive-integer';
import { base64url, isP256PublicKey, type VapidKeys } from './web-push-crypto';

// The push services browsers subscribe with. The dispatcher POSTs to a
// subscription's endpoint, so endpoints are restricted to these hosts (or
// their subdomains): an endpoint is client input, and without the allowlist
// it would make the server send requests anywhere (SSRF).
export const DEFAULT_PUSH_ALLOWED_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

export interface PushConfig {
  vapid: VapidKeys | null;
  allowedHosts: string[];
  ttlSeconds: number;
  dispatchIntervalSeconds: number;
  batchSize: number;
  maxAgeSeconds: number;
  maxFailures: number;
  perAccount: number;
}

// Push is enabled when all three VAPID variables are set, disabled when none
// is; a partial or malformed set fails at startup rather than at the first
// push.
export function readPushConfig(
  env: NodeJS.ProcessEnv = process.env,
): PushConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  const set = [publicKey, privateKey, subject].filter(Boolean).length;
  if (set !== 0 && set !== 3) {
    throw new Error(
      'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together',
    );
  }
  let vapid: VapidKeys | null = null;
  if (set === 3) {
    if (!isP256PublicKey(base64url.decode(publicKey!))) {
      throw new Error(
        'VAPID_PUBLIC_KEY must be an uncompressed P-256 key, base64url',
      );
    }
    if (base64url.decode(privateKey!).length !== 32) {
      throw new Error(
        'VAPID_PRIVATE_KEY must be a 32-byte P-256 key, base64url',
      );
    }
    if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject!)) {
      throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
    }
    vapid = {
      publicKey: publicKey!,
      privateKey: privateKey!,
      subject: subject!,
    };
  }
  const hosts = env.PUSH_ALLOWED_HOSTS?.trim();
  return {
    vapid,
    allowedHosts: hosts
      ? hosts
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean)
      : DEFAULT_PUSH_ALLOWED_HOSTS,
    ttlSeconds: readPositiveInteger('PUSH_TTL_SECONDS', 86400),
    dispatchIntervalSeconds: readPositiveInteger(
      'PUSH_DISPATCH_INTERVAL_SECONDS',
      5,
    ),
    batchSize: readPositiveInteger('PUSH_DISPATCH_BATCH', 200),
    maxAgeSeconds: readPositiveInteger('PUSH_MAX_AGE_SECONDS', 3600),
    maxFailures: readPositiveInteger('PUSH_MAX_FAILURES', 5),
    perAccount: readPositiveInteger('PUSH_SUBSCRIPTIONS_PER_ACCOUNT', 10),
  };
}

// An endpoint the dispatcher may call: https, the default port, no
// credentials, and an allowed host or a subdomain of one.
export function isAllowedPushEndpoint(
  endpoint: string,
  allowedHosts: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return allowedHosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export const PUSH_CONFIG = Symbol('PUSH_CONFIG');

// The HTTP side of a push, replaceable in tests.
export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PushTransport {
  send(request: PushRequest): Promise<{ status: number }>;
}

export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

// No redirects: a push service never redirects, and following one would
// leave the allowlist.
export const fetchPushTransport: PushTransport = {
  async send({ endpoint, headers, body }) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status };
  },
};
