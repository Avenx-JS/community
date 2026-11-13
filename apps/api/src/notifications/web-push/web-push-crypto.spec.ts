import { describe, expect, it } from '@jest/globals';
import { createPublicKey, verify } from 'node:crypto';
import {
  base64url,
  encryptPushPayload,
  generateVapidKeys,
  isP256PublicKey,
  vapidAuthorization,
} from './web-push-crypto';

// RFC 8291 Appendix A: a complete worked example of a push message.
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg' +
    'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVB' +
    'St2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPushPayload', () => {
  it('produces exactly the body of RFC 8291 Appendix A', () => {
    const body = encryptPushPayload(
      Buffer.from(RFC8291.plaintext),
      base64url.decode(RFC8291.uaPublic),
      base64url.decode(RFC8291.authSecret),
      {
        serverPrivateKey: base64url.decode(RFC8291.asPrivate),
        salt: base64url.decode(RFC8291.salt),
      },
    );
    expect(base64url.encode(body)).toBe(RFC8291.body);
  });

  it('uses a fresh key pair and salt for every message', () => {
    const encrypt = () =>
      encryptPushPayload(
        Buffer.from('x'),
        base64url.decode(RFC8291.uaPublic),
        base64url.decode(RFC8291.authSecret),
      );
    const [a, b] = [encrypt(), encrypt()];
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });
});

describe('isP256PublicKey', () => {
  it('accepts an uncompressed point on the curve and nothing else', () => {
    expect(isP256PublicKey(base64url.decode(RFC8291.uaPublic))).toBe(true);
    const off = base64url.decode(RFC8291.uaPublic);
    off[64] ^= 0xff;
    expect(isP256PublicKey(off)).toBe(false);
    expect(isP256PublicKey(Buffer.alloc(65, 4))).toBe(false);
    expect(isP256PublicKey(Buffer.alloc(33, 2))).toBe(false);
  });
});

describe('vapidAuthorization', () => {
  it('signs an ES256 JWT for the endpoint origin that the public key verifies', () => {
    const keys = { ...generateVapidKeys(), subject: 'mailto:ops@example.org' };
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc?x=1',
      keys,
      1_700_000_000,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(base64url.decode(head).toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    expect(JSON.parse(base64url.decode(claims).toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_700_000_000 + 12 * 60 * 60,
      sub: 'mailto:ops@example.org',
    });

    const publicKey = base64url.decode(keys.publicKey);
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: base64url.encode(publicKey.subarray(1, 33)),
        y: base64url.encode(publicKey.subarray(33, 65)),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key, dsaEncoding: 'ieee-p1363' },
        base64url.decode(signature),
      ),
    ).toBe(true);
  });
});
