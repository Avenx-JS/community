import { describe, expect, it } from '@jest/globals';
import { clientOrigin, ipPrefix, userAgent } from './client-origin';

describe('ipPrefix', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['::ffff:198.51.100.9', '198.51.100.0/24'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3::/48'],
    ['2001:0db8:0000::1', '2001:db8:0::/48'],
    ['::1', '0:0:0::/48'],
  ])('keeps only the network of %s: %s', (ip, prefix) => {
    expect(ipPrefix(ip)).toBe(prefix);
  });

  it.each([undefined, null, '', 'unknown', '999.1.1.1', 'not-an-ip'])(
    'stores nothing for %p',
    (ip) => {
      expect(ipPrefix(ip)).toBeNull();
    },
  );

  // The point of the prefix: the host part is never kept.
  it('never contains the host part', () => {
    expect(ipPrefix('192.0.2.123')).not.toContain('123');
    expect(ipPrefix('2001:db8:1:2:3:4:5:6')).not.toMatch(/:2:3|:4:5/);
  });
});

describe('userAgent', () => {
  it('strips control characters and cuts to the column', () => {
    expect(userAgent('Mozilla/5.0\r\nX-Injected: 1')).toBe(
      'Mozilla/5.0X-Injected: 1',
    );
    expect(userAgent('x'.repeat(400))).toHaveLength(255);
    expect(userAgent(['first', 'second'])).toBe('first');
    expect(userAgent(undefined)).toBeNull();
    expect(userAgent('\u0007')).toBeNull();
  });

  it('reads a request without headers', () => {
    expect(clientOrigin({ ip: '203.0.113.5' })).toEqual({
      ipPrefix: '203.0.113.0/24',
      userAgent: null,
    });
  });
});
