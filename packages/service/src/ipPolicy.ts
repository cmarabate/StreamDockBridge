/**
 * Which resolved addresses the icon fetcher may connect to.
 *
 * Context URL deliberately lets the owner OPEN a local URL in their browser.
 * That does not authorize this service to make server-side requests to private
 * or internal addresses on their behalf — those are different capabilities with
 * different policies, and this module is the second one.
 *
 * Everything here operates on the canonical textual forms `dns.lookup` returns
 * ("127.0.0.1", "::1", "::ffff:7f00:1"), not on arbitrary user text, so no
 * general-purpose address parser is needed. The URL parser has already
 * normalized the classic decimal/octal/hex literal evasions by this point.
 */

/** IPv4 blocks that are not globally reachable, per the IANA special-purpose registry. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT — also where Tailscale lives
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata at 169.254.169.254
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast — in a separate registry, and the class most often missed
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
];

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function inV4Block(value: number, base: string, bits: number): boolean {
  const baseValue = parseIpv4(base);
  if (baseValue === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isBlockedIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return true; // unparseable is not provably public
  return BLOCKED_V4.some(([base, bits]) => inV4Block(value, base, bits));
}

/** Expand a textual IPv6 address (one `::` allowed) to its 16 bytes. */
export function ipv6ToBytes(address: string): number[] | null {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // A zone index ("%eth0") is not part of the address.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text) return null;

  // A trailing dotted quad (::ffff:127.0.0.1, 64:ff9b::1.2.3.4) becomes two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = toGroups(halves[0]);
  const tailGroups = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tailGroups === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tailGroups];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function bytesToIpv4(bytes: number[], offset: number): string {
  return bytes.slice(offset, offset + 4).join('.');
}

/**
 * IPv6 uses an allowlist rather than a denylist: only global unicast (2000::/3)
 * is accepted, minus the documentation and IPv4-embedding ranges inside it.
 * A block overlooked that way becomes a false reject, never a bypass.
 */
export function isBlockedIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (bytes === null) return true;

  const first = bytes[0];
  const second = bytes[1];

  // IPv4-mapped ::ffff:0:0/96 — note the host renders this in HEX, so a
  // dotted-quad string check would miss it entirely. Unwrap and re-judge.
  const mappedPrefix = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mappedPrefix) return isBlockedIpv4(bytesToIpv4(bytes, 12));

  // NAT64 64:ff9b::/96 embeds IPv4 too.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isBlockedIpv4(bytesToIpv4(bytes, 12));
  }

  // 2002::/16 6to4 embeds IPv4 in bytes 2..5.
  if (first === 0x20 && second === 0x02) return isBlockedIpv4(bytesToIpv4(bytes, 2));

  // 2001::/32 Teredo embeds an IPv4 server; treat the whole range as ineligible.
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  // 2001:2::/48 benchmarking (RFC 5180)
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02 && bytes[4] === 0x00) {
    return true;
  }
  // 2001:20::/28 ORCHIDv2 — not routable
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x20) return true;
  // 2001:db8::/32 documentation
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  // 3fff::/20 documentation
  if (first === 0x3f && (second & 0xf0) === 0xf0) return true;

  // Global unicast only: 2000::/3.
  return (first & 0xe0) !== 0x20;
}

/** True when this resolved address must not be connected to. */
export function isBlockedAddress(address: string, family?: number): boolean {
  const text = String(address || '').trim();
  if (!text) return true;
  if (family === 4 || (!text.includes(':') && text.includes('.'))) return isBlockedIpv4(text);
  return isBlockedIpv6(text);
}

/** Hostnames that never denote a public site, refused before any resolution. */
export function isBlockedHostname(hostname: string): boolean {
  /**
   * ALL trailing dots, not one. `localhost..` survives the URL parser intact,
   * and stripping a single dot leaves `localhost.`, which matches none of the
   * checks below — the name would then be sent to the resolver, which on
   * Windows puts a `.local` query on the wire.
   */
  const host = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // mDNS and common internal suffixes.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  // A bare IP literal can be judged immediately.
  if (host.startsWith('[') || host.includes(':')) return isBlockedIpv6(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host);
  return false;
}

export const ALLOWED_PORTS = [80, 443];
