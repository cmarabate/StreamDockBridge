import * as dns from 'dns';
import {
  hopPolicyFailure,
  createBodyCollector,
  createPinnedLookup,
  safeGet,
  IconFetchError,
  FetchedResource,
  HopTransport,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
} from './iconFetch';

jest.mock('dns');

const mockedLookup = dns.lookup as unknown as jest.Mock;

function response(partial: Partial<FetchedResource>): FetchedResource {
  return {
    status: 200,
    headers: {},
    body: Buffer.alloc(0),
    finalUrl: 'https://example.com/',
    truncated: false,
    ...partial,
  };
}

describe('per-hop policy', () => {
  it('allows ordinary public web URLs', () => {
    expect(hopPolicyFailure(new URL('https://www.youtube.com/'))).toBeNull();
    expect(hopPolicyFailure(new URL('http://example.com/favicon.ico'))).toBeNull();
    expect(hopPolicyFailure(new URL('https://example.com:443/x'))).toBeNull();
    expect(hopPolicyFailure(new URL('http://example.com:80/x'))).toBeNull();
  });

  it('refuses non-http(s) schemes', () => {
    expect(hopPolicyFailure(new URL('ftp://example.com/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('file:///C:/x'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('data:text/plain,hi'))).toBe('blocked_host');
  });

  /** Credentials would be sent onward, and an icon never needs them. */
  it('refuses credential-bearing URLs', () => {
    expect(hopPolicyFailure(new URL('https://user:pass@example.com/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('https://user@example.com/'))).toBe('blocked_host');
  });

  it('refuses local and private destinations', () => {
    expect(hopPolicyFailure(new URL('http://localhost:80/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('http://127.0.0.1/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('http://192.168.1.1/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('http://169.254.169.254/latest/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('http://[::1]/'))).toBe('blocked_host');
    expect(hopPolicyFailure(new URL('http://nas.local/'))).toBe('blocked_host');
  });

  it('refuses ports other than 80 and 443', () => {
    expect(hopPolicyFailure(new URL('http://example.com:8080/'))).toBe('blocked_port');
    expect(hopPolicyFailure(new URL('https://example.com:8443/'))).toBe('blocked_port');
    expect(hopPolicyFailure(new URL('http://example.com:22/'))).toBe('blocked_port');
  });
});

describe('the response-size ceiling', () => {
  it('accepts a body under the ceiling', () => {
    const collector = createBodyCollector(100, false);
    expect(collector.push(Buffer.alloc(60, 1))).toBe(false);
    expect(collector.push(Buffer.alloc(40, 2))).toBe(false);
    expect(collector.overflowed).toBe(false);
    expect(collector.truncated).toBe(false);
    expect(collector.bytes).toBe(100);
  });

  it('rejects an oversized body when truncation is not allowed', () => {
    const collector = createBodyCollector(100, false);
    collector.push(Buffer.alloc(80));
    expect(collector.push(Buffer.alloc(40))).toBe(true);
    expect(collector.overflowed).toBe(true);
    expect(collector.truncated).toBe(false);
  });

  /**
   * HTML is truncated rather than rejected, because a real homepage routinely
   * exceeds any sane cap and the <head> we need sits at the very start. This is
   * exactly what stopped Rotten Tomatoes resolving before it was added.
   */
  it('keeps the exact prefix when truncation is allowed', () => {
    const collector = createBodyCollector(10, true);
    collector.push(Buffer.from('abcde'));
    expect(collector.push(Buffer.from('fghijklmno'))).toBe(true);
    expect(collector.truncated).toBe(true);
    expect(collector.overflowed).toBe(false);
    expect(collector.body().toString()).toBe('abcdefghij');
    expect(collector.bytes).toBe(10);
  });

  it('ignores anything pushed after it has stopped', () => {
    const collector = createBodyCollector(4, true);
    collector.push(Buffer.from('abcdef'));
    expect(collector.push(Buffer.from('zzzz'))).toBe(true);
    expect(collector.body().toString()).toBe('abcd');
  });
});

describe('pinned DNS resolution', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  const resolveWith = (addresses: Array<{ address: string; family: number }>) => {
    mockedLookup.mockImplementation((_host: string, _opts: any, cb: any) => cb(null, addresses));
  };

  it('returns a public address', (done) => {
    resolveWith([{ address: '142.250.187.206', family: 4 }]);
    createPinnedLookup()('example.com', { all: true } as any, ((err: any, result: any) => {
      expect(err).toBeNull();
      expect(result).toEqual([{ address: '142.250.187.206', family: 4 }]);
      done();
    }) as any);
  });

  /**
   * With autoSelectFamily (the default since Node 20) EVERY address returned
   * becomes a connection candidate, so validating only the first of several
   * would leave a hole. Exactly one approved address goes back.
   */
  it('returns only the approved address when several are offered', (done) => {
    resolveWith([
      { address: '127.0.0.1', family: 4 },
      { address: '192.168.1.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]);
    createPinnedLookup()('rebind.example', { all: true } as any, ((err: any, result: any) => {
      expect(err).toBeNull();
      expect(result).toHaveLength(1);
      expect(result[0].address).toBe('93.184.216.34');
      done();
    }) as any);
  });

  it('refuses when every offered address is ineligible', (done) => {
    resolveWith([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
      { address: '10.0.0.5', family: 4 },
    ]);
    createPinnedLookup()('internal.example', { all: true } as any, ((err: any) => {
      expect(err).toBeInstanceOf(IconFetchError);
      expect((err as IconFetchError).reason).toBe('blocked_address');
      done();
    }) as any);
  });

  it('refuses an IPv4-mapped loopback returned in hex', (done) => {
    resolveWith([{ address: '::ffff:7f00:1', family: 6 }]);
    createPinnedLookup()('mapped.example', { all: true } as any, ((err: any) => {
      expect((err as IconFetchError).reason).toBe('blocked_address');
      done();
    }) as any);
  });

  /** Node 22 passes { all: true } by default; the 3-arg form throws in that mode. */
  it('answers the single-address callback shape when all is not requested', (done) => {
    resolveWith([{ address: '93.184.216.34', family: 4 }]);
    createPinnedLookup()('example.com', {} as any, ((err: any, address: any, family: any) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      done();
    }) as any);
  });

  it('passes a resolution failure straight through', (done) => {
    const failure = new Error('ENOTFOUND');
    mockedLookup.mockImplementation((_host: string, _opts: any, cb: any) => cb(failure));
    createPinnedLookup()('nope.example', { all: true } as any, ((err: any) => {
      expect(err).toBe(failure);
      done();
    }) as any);
  });
});

describe('redirect handling', () => {
  const transportFor = (steps: Array<Partial<FetchedResource>>): { transport: HopTransport; seen: string[] } => {
    const seen: string[] = [];
    let index = 0;
    const transport: HopTransport = async (target) => {
      seen.push(target.toString());
      const step = steps[Math.min(index++, steps.length - 1)];
      return response({ ...step, finalUrl: target.toString() });
    };
    return { transport, seen };
  };

  it('follows a redirect and reports the final URL', async () => {
    const { transport, seen } = transportFor([
      { status: 302, headers: { location: 'https://example.com/final' } },
      { status: 200, body: Buffer.from('ok') },
    ]);
    const result = await safeGet('https://example.com/start', { transport });
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe('https://example.com/final');
    expect(seen).toEqual(['https://example.com/start', 'https://example.com/final']);
  });

  it('resolves a relative Location against the current hop', async () => {
    const { transport, seen } = transportFor([
      { status: 301, headers: { location: '/moved/here' } },
      { status: 200 },
    ]);
    await safeGet('https://example.com/a/b', { transport });
    expect(seen[1]).toBe('https://example.com/moved/here');
  });

  /**
   * The obvious bypass: a public host that redirects inward. The configured
   * origin earns its redirect target nothing — every hop is judged alone.
   */
  it('refuses a redirect into private space', async () => {
    const cases = [
      'http://127.0.0.1/admin',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
      'http://[::1]/',
    ];
    for (const target of cases) {
      const { transport, seen } = transportFor([
        { status: 302, headers: { location: target } },
        { status: 200, body: Buffer.from('SHOULD NOT BE REACHED') },
      ]);
      await expect(safeGet('https://example.com/', { transport })).rejects.toMatchObject({
        reason: 'blocked_host',
      });
      // The refusal happens BEFORE the socket, so the hop is never attempted.
      expect(seen).toEqual(['https://example.com/']);
    }
  });

  it('refuses a redirect to a non-web port or scheme', async () => {
    const { transport } = transportFor([{ status: 302, headers: { location: 'http://example.com:8080/' } }]);
    await expect(safeGet('https://example.com/', { transport })).rejects.toMatchObject({
      reason: 'blocked_port',
    });

    const { transport: t2 } = transportFor([{ status: 302, headers: { location: 'file:///C:/x' } }]);
    await expect(safeGet('https://example.com/', { transport: t2 })).rejects.toMatchObject({
      reason: 'blocked_host',
    });
  });

  it('refuses a redirect carrying credentials', async () => {
    const { transport } = transportFor([
      { status: 302, headers: { location: 'https://user:pass@example.com/' } },
    ]);
    await expect(safeGet('https://example.com/', { transport })).rejects.toMatchObject({
      reason: 'blocked_host',
    });
  });

  it('stops after the redirect limit', async () => {
    const { transport, seen } = transportFor([
      { status: 302, headers: { location: 'https://example.com/loop' } },
    ]);
    await expect(safeGet('https://example.com/', { transport })).rejects.toMatchObject({
      reason: 'too_many_redirects',
    });
    expect(seen).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('treats a redirect without a Location as the final response', async () => {
    const { transport } = transportFor([{ status: 302, headers: {} }]);
    const result = await safeGet('https://example.com/', { transport });
    expect(result.status).toBe(302);
  });

  it('refuses the very first URL when policy forbids it', async () => {
    const { transport, seen } = transportFor([{ status: 200 }]);
    await expect(safeGet('http://127.0.0.1:17337/context', { transport })).rejects.toMatchObject({
      reason: 'blocked_host',
    });
    expect(seen).toEqual([]);
  });

  it('refuses an unparseable URL', async () => {
    await expect(safeGet('not a url')).rejects.toMatchObject({ reason: 'network_error' });
  });

  it('defaults the body ceiling to the documented value', () => {
    expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);
  });
});

describe('timeouts', () => {
  /**
   * One budget covers the whole operation. Individually-fast redirects must not
   * be able to keep a request alive indefinitely by staying under the per-hop
   * timeout, which is what this asserts.
   */
  it('abandons a redirect chain once the total budget is spent', async () => {
    let hops = 0;
    const transport: HopTransport = async (target) => {
      hops++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return response({
        status: 302,
        headers: { location: `https://example.com/hop${hops}` },
        finalUrl: target.toString(),
      });
    };

    await expect(
      safeGet('https://example.com/', { transport, totalTimeoutMs: 40, redirectsLeft: 50 })
    ).rejects.toMatchObject({ reason: 'timeout' });
    // It stopped on the budget, well short of the redirect allowance.
    expect(hops).toBeLessThan(5);
  });

  it('propagates a per-hop timeout', async () => {
    const transport: HopTransport = async () => {
      throw new IconFetchError('timeout');
    };
    await expect(safeGet('https://example.com/', { transport })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('does not fire when the work finishes inside the budget', async () => {
    const transport: HopTransport = async (target) =>
      response({ status: 200, finalUrl: target.toString() });
    await expect(
      safeGet('https://example.com/', { transport, totalTimeoutMs: 5000 })
    ).resolves.toMatchObject({ status: 200 });
  });
});
