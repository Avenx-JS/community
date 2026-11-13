import {
  createECDH,
  createPrivateKey,
  createCipheriv,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

// Web Push without a third-party library: message encryption (RFC 8291,
// aes128gcm per RFC 8188) and VAPID authentication (RFC 8292), on node:crypto.
// web-push-crypto.spec.ts checks the encryption against RFC 8291 Appendix A.

export const base64url = {
  encode: (data: Buffer): string => data.toString('base64url'),
  decode: (text: string): Buffer => Buffer.from(text, 'base64url'),
};

// An uncompressed P-256 point: 0x04, then X and Y.
export function isP256PublicKey(key: Buffer): boolean {
  if (key.length !== 65 || key[0] !== 0x04) {
    return false;
  }
  try {
    // Throws for a point that is not on the curve.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.alloc(32, 1));
    ecdh.computeSecret(key);
    return true;
  } catch {
    return false;
  }
}

export interface EncryptOptions {
  // Fixed only by tests: a fresh key pair and salt per message otherwise.
  serverPrivateKey?: Buffer;
  salt?: Buffer;
}

// RFC 8291 section 3.4: the body of a push message, one aes128gcm record.
// uaPublic is the subscription's p256dh, authSecret its auth.
export function encryptPushPayload(
  payload: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
  options: EncryptOptions = {},
): Buffer {
  const server = createECDH('prime256v1');
  if (options.serverPrivateKey) {
    server.setPrivateKey(options.serverPrivateKey);
  } else {
    server.generateKeys();
  }
  const asPublic = server.getPublicKey();
  const salt = options.salt ?? randomBytes(16);

  const ecdhSecret = server.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'ascii'),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32),
  );
  const cek = Buffer.from(
    hkdfSync(
      'sha256',
      ikm,
      salt,
      Buffer.from('Content-Encoding: aes128gcm\0'),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  // A single, final record: the 0x02 delimiter, no padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
    ciphertext,
  ]);
}

export interface VapidKeys {
  // base64url: the uncompressed P-256 public key (65 bytes) and the private
  // scalar (32 bytes), as every VAPID tool prints them.
  publicKey: string;
  privateKey: string;
  // mailto: or https: contact for the push service (RFC 8292 section 2.1).
  subject: string;
}

// RFC 8292: "vapid t=<JWT>, k=<public key>" for one push service origin. The
// JWT is ES256 over {aud, exp, sub}; exp at most 24 hours ahead.
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  ttlSeconds = 12 * 60 * 60,
): string {
  const publicKey = base64url.decode(keys.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: base64url.encode(publicKey.subarray(1, 33)),
      y: base64url.encode(publicKey.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const segment = (value: object) =>
    base64url.encode(Buffer.from(JSON.stringify(value)));
  const unsigned = `${segment({ typ: 'JWT', alg: 'ES256' })}.${segment({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + ttlSeconds,
    sub: keys.subject,
  })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${base64url.encode(signature)}, k=${keys.publicKey}`;
}

// A new VAPID key pair, for operators: printed by `npm run vapid:keys`
// (print-vapid-keys.ts).
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: base64url.encode(ecdh.getPublicKey()),
    privateKey: base64url.encode(ecdh.getPrivateKey()),
  };
}
