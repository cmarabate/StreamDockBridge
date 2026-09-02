import {
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedAddress,
  isBlockedHostname,
  ipv6ToBytes,
  ALLOWED_PORTS,
} from './ipPolicy';

/**
 * Which resolved addresses the icon fetcher may connect to.
 *
 * Context URL may legally OPEN a local address in the browser. This service may
 * not make server-side requests to one. Everything below is the second policy.
 */

describe('IPv4 eligibility', () => {
  const blocked = [
    ['0.0.0.0', 'this network'],
    ['0.1.2.3', 'this network'],
    ['10.0.0.1', 'RFC1918'],
    ['10.255.255.255', 'RFC1918'],
    ['100.64.0.1', 'CGNAT, where Tailscale lives'],
    ['100.127.255.255', 'CGNAT'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback is a whole /8'],
    ['169.254.1.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'RFC1918'],
    ['172.31.255.255', 'RFC1918'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.5', 'TEST-NET-1'],
    ['192.88.99.1', 'deprecated 6to4 relay anycast'],
    ['192.168.1.1', 'RFC1918'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.5', 'TEST-NET-2'],
    ['203.0.113.5', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'SSDP multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ];

  it.each(blocked)('refuses %s (%s)', (address) => {
    expect(isBlockedIpv4(address as string)).toBe(true);
  });

  /**
   * Adjacent-but-public addresses. A policy that swallowed these would be
   * refusing real websites, so they are asserted as carefully as the blocks.
   */
  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.63.255.255', '100.128.0.1', '192.1.0.1', '223.255.255.255'];

  it.each(allowed)('allows the public address %s', (address) => {
    expect(isBlockedIpv4(address)).toBe(false);
  });

  it('refuses anything it cannot parse rather than assuming it is public', () => {
    expect(isBlockedIpv4('not-an-address')).toBe(true);
    expect(isBlockedIpv4('1.2.3')).toBe(true);
    expect(isBlockedIpv4('1.2.3.4.5')).toBe(true);
    expect(isBlockedIpv4('999.1.1.1')).toBe(true);
    expect(isBlockedIpv4('')).toBe(true);
  });
});

describe('IPv6 eligibility', () => {
  it('expands addresses to bytes, including a trailing dotted quad', () => {
    expect(ipv6ToBytes('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6ToBytes('::ffff:127.0.0.1')!.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    // The same address as the host actually renders it.
    expect(ipv6ToBytes('::ffff:7f00:1')).toEqual(ipv6ToBytes('::ffff:127.0.0.1'));
    expect(ipv6ToBytes('[::1]')).toEqual(ipv6ToBytes('::1'));
    expect(ipv6ToBytes('fe80::1%eth0')).toEqual(ipv6ToBytes('fe80::1'));
  });

  const blocked = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'Teredo'],
    ['3fff::1', 'documentation'],
    ['2001:2:0::1', 'benchmarking, RFC 5180'],
    ['2001:20::1', 'ORCHIDv2'],
    ['2001:2f::1', 'ORCHIDv2 upper bound'],
  ];

  it.each(blocked)('refuses %s (%s)', (address) => {
    expect(isBlockedIpv6(address as string)).toBe(true);
  });

  /**
   * The classes a dotted-quad string check would miss entirely. The host
   * renders IPv4-mapped addresses in HEX, so the embedded IPv4 has to be
   * unwrapped and re-judged rather than pattern-matched.
   */
  it('unwraps IPv4-mapped addresses and judges the embedded address', () => {
    expect(isBlockedIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpv6('::ffff:7f00:1')).toBe(true); // same, in hex
    expect(isBlockedIpv6('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedIpv6('::ffff:c0a8:101')).toBe(true); // same, in hex
    expect(isBlockedIpv6('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIpv6('::ffff:a9fe:a9fe')).toBe(true); // same, in hex
    expect(isBlockedIpv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('unwraps NAT64 64:ff9b::/96 embeddings', () => {
    expect(isBlockedIpv6('64:ff9b::127.0.0.1')).toBe(true);
    expect(isBlockedIpv6('64:ff9b::7f00:1')).toBe(true);
    expect(isBlockedIpv6('64:ff9b::192.168.0.1')).toBe(true);
    expect(isBlockedIpv6('64:ff9b::8.8.8.8')).toBe(false);
  });

  it('unwraps 6to4 2002::/16 embeddings', () => {
    expect(isBlockedIpv6('2002:7f00:0001::1')).toBe(true); // 127.0.0.1
    expect(isBlockedIpv6('2002:c0a8:0101::1')).toBe(true); // 192.168.1.1
    expect(isBlockedIpv6('2002:a9fe:a9fe::1')).toBe(true); // 169.254.169.254
    expect(isBlockedIpv6('2002:0808:0808::1')).toBe(false); // 8.8.8.8
  });

  /**
   * IPv6 is an allowlist, not a denylist: only global unicast is accepted. A
   * range overlooked that way becomes a false reject, never a bypass.
   */
  it('accepts only global unicast', () => {
    expect(isBlockedIpv6('2606:4700:4700::1111')).toBe(false); // Cloudflare
    expect(isBlockedIpv6('2a00:1450:4009::200e')).toBe(false); // Google
    expect(isBlockedIpv6('4000::1')).toBe(true); // outside 2000::/3
    expect(isBlockedIpv6('1000::1')).toBe(true);
  });

  it('refuses anything it cannot parse', () => {
    expect(isBlockedIpv6('gggg::1')).toBe(true);
    expect(isBlockedIpv6('1::2::3')).toBe(true);
    expect(isBlockedIpv6('')).toBe(true);
  });
});

describe('choosing the family', () => {
  it('judges by the declared family, then by shape', () => {
    expect(isBlockedAddress('127.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('::1', 6)).toBe(true);
    expect(isBlockedAddress('8.8.8.8', 4)).toBe(false);
    expect(isBlockedAddress('2606:4700::1111', 6)).toBe(false);
    // Family omitted: inferred from the text.
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('hostnames refused before any resolution', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'app.localhost',
    'printer.local',
    'db.internal',
    'thing.home.arpa',
    '127.0.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '[::1]',
    '::1',
  ])('refuses %s', (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it.each(['www.youtube.com', 'www.rottentomatoes.com', 'example.co.uk', '8.8.8.8'])(
    'allows %s',
    (host) => {
      expect(isBlockedHostname(host)).toBe(false);
    }
  );

  it('refuses an empty hostname', () => {
    expect(isBlockedHostname('')).toBe(true);
    expect(isBlockedHostname('   ')).toBe(true);
  });

  /**
   * The URL parser preserves repeated trailing dots, and stripping only ONE
   * left `localhost.` — which matched nothing below and went to the resolver.
   * On Windows a `.local` lookup puts an mDNS query on the wire, so this had to
   * be refused before resolution, not merely backstopped by the address gate.
   */
  it.each([
    'localhost..',
    'localhost...',
    'a.LOCALHOST..',
    'printer.local..',
    'db.internal..',
    'x.home.arpa..',
    '169.254.169.254..',
    '192.168.1.1..',
    '127.0.0.1...',
  ])('refuses %s despite repeated trailing dots', (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  /**
   * Load-bearing coupling: Node short-circuits DNS for an IP literal and never
   * calls our pinned lookup, so an IP-literal host is gated ONLY by the check
   * above. That is safe purely because the URL parser canonicalizes every
   * literal form into a dotted quad first. Asserted here so a parser change
   * cannot silently open a hole.
   */
  it('refuses every literal form the URL parser canonicalizes to loopback', () => {
    const forms = [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://127.0.0.1./',
      'http://①②⑦.0.0.1/',
      'http://127。0。0。1/',
    ];
    for (const raw of forms) {
      const { hostname } = new URL(raw);
      expect(hostname).toBe('127.0.0.1');
      expect(isBlockedHostname(hostname)).toBe(true);
    }
    // "0" is the unspecified address, which is also refused.
    expect(isBlockedHostname(new URL('http://0/').hostname)).toBe(true);
    // And the bracketed IPv6-mapped literal, which renders in hex.
    expect(isBlockedHostname(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe(true);
  });
});

describe('ports', () => {
  it('permits only the two web ports', () => {
    expect(ALLOWED_PORTS).toEqual([80, 443]);
  });
});
