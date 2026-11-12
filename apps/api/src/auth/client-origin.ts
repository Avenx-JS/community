import { isIPv4, isIPv6 } from 'node:net';

// Where a session came from, coarsely: enough for an account owner to tell
// "my laptop at home" from "a network I have never used", never a full
// address. The full IP is not stored at all, so it cannot leak through the
// session list, a backup or a data export.
export interface ClientOrigin {
  ipPrefix: string | null;
  userAgent: string | null;
}

export const USER_AGENT_MAX = 255;

// IPv4 keeps its /24 (a.b.c.0/24), IPv6 its /48, a typical site prefix. An
// IPv4-mapped IPv6 address (::ffff:a.b.c.d, as Node reports IPv4 clients on a
// dual-stack socket) is treated as the IPv4 address it carries.
export function ipPrefix(ip: string | undefined | null): string | null {
  if (!ip) {
    return null;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;
  if (isIPv4(address)) {
    const [a, b, c] = address.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIPv6(address)) {
    const groups = expandIPv6(address);
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

function expandIPv6(address: string): string[] {
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''));
}

// The client's own User-Agent header, without control characters and cut
// to the column width. It is the caller's own information about their own
// device, shown only to them.
export function userAgent(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, USER_AGENT_MAX) : null;
}

export function clientOrigin(request: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}): ClientOrigin {
  return {
    ipPrefix: ipPrefix(request.ip ?? request.socket?.remoteAddress),
    userAgent: userAgent(request.headers?.['user-agent']),
  };
}
