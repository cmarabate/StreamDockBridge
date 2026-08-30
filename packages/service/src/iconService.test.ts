import { IconService } from './iconService';
import { IconCache } from './iconCache';
import { FetchedResource, GetOptions, MAX_RESPONSE_BYTES } from './iconFetch';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 64]),
  Buffer.alloc(64),
]);

const PAGE = Buffer.from('<!doctype html><html><head></head><body></body></html>');

/**
 * A stand-in for the network that counts hits per URL, so "no refetch" can be
 * asserted rather than assumed.
 */
function counter(bodies: Record<string, Buffer> = {}) {
  const calls: string[] = [];
  let delay = 0;
  const get = async (rawUrl: string, _options: GetOptions = {}): Promise<FetchedResource> => {
    calls.push(rawUrl);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const body = bodies[rawUrl] ?? (rawUrl.endsWith('.ico') || rawUrl.endsWith('.png') ? PNG : PAGE);
    return { status: 200, headers: {}, body, finalUrl: rawUrl, truncated: false };
  };
  return {
    get,
    calls,
    setDelay(ms: number) {
      delay = ms;
    },
    countFor(fragment: string) {
      return calls.filter((c) => c.includes(fragment)).length;
    },
  };
}

const service = (net = counter()) => ({
  net,
  icons: new IconService(new IconCache(null), net.get),
});

/** A site whose page and both conventional fallbacks are all non-images. */
const nothingUsable = () => ({
  'https://example.com': PAGE,
  'https://example.com/apple-touch-icon.png': PAGE,
  'https://example.com/favicon.ico': PAGE,
});

const YOUTUBE = 'https://www.youtube.com/results?search_query={title}+trailer';
const YOUTUBE_OTHER_QUERY = 'https://www.youtube.com/results?search_query={title}+review';
const ROTTEN = 'https://www.rottentomatoes.com/search?search={title}';

describe('resolving the icon for a template', () => {
  it('fetches and reports the origin it derived', async () => {
    const { icons } = service();
    const outcome = await icons.resolve(YOUTUBE);
    expect(outcome.status).toBe('loaded');
    expect(outcome.hostname).toBe('www.youtube.com');
    expect(outcome.origin).toBe('https://www.youtube.com');
    expect(outcome.icon?.mime).toBe('image/png');
  });

  it('serves a second request for the same origin from cache', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE);
    const before = net.calls.length;
    const outcome = await icons.resolve(YOUTUBE);
    expect(outcome.status).toBe('cached');
    expect(net.calls.length).toBe(before);
  });

  /**
   * Editing the query, or pointing a second key at the same site, is not icon
   * work. Both resolve to the same origin, so neither touches the network.
   */
  it('does not fetch again when only the query differs', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE);
    const before = net.calls.length;
    const outcome = await icons.resolve(YOUTUBE_OTHER_QUERY);
    expect(outcome.status).toBe('cached');
    expect(net.calls.length).toBe(before);
  });

  it('does not fetch again when only the path differs', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE);
    const before = net.calls.length;
    expect((await icons.resolve('https://www.youtube.com/feed/{title}')).status).toBe('cached');
    expect(net.calls.length).toBe(before);
  });

  /**
   * The template is the only input, and it does not mention the media. A
   * different show simply cannot reach this code path — asserted here because
   * it is the central promise of the design.
   */
  it('is unaffected by which title the placeholders would resolve to', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE);
    const before = net.calls.length;
    await icons.resolve(YOUTUBE);
    await icons.resolve(YOUTUBE);
    expect(net.calls.length).toBe(before);
  });

  it('fetches again when the host changes', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE);
    const before = net.calls.length;
    const outcome = await icons.resolve(ROTTEN);
    expect(outcome.status).toBe('loaded');
    expect(outcome.hostname).toBe('www.rottentomatoes.com');
    expect(net.calls.length).toBeGreaterThan(before);
  });

  /** Six keys appearing at once on one site must cause one download, not six. */
  it('collapses concurrent requests for one origin into a single fetch', async () => {
    const net = counter();
    net.setDelay(20);
    const icons = new IconService(new IconCache(null), net.get);

    const outcomes = await Promise.all([
      icons.resolve(YOUTUBE),
      icons.resolve(YOUTUBE_OTHER_QUERY),
      icons.resolve('https://www.youtube.com/a/{title}'),
      icons.resolve('https://www.youtube.com/b/{title}'),
      icons.resolve('https://www.youtube.com/c/{title}'),
      icons.resolve('https://www.youtube.com/d/{title}'),
    ]);

    expect(outcomes.every((o) => o.status === 'loaded')).toBe(true);
    // One resolution's worth of traffic, not six. The exact count is whatever a
    // single resolve costs; what matters is that it did not multiply.
    const single = counter();
    await new IconService(new IconCache(null), single.get).resolve(YOUTUBE);
    expect(net.countFor('youtube.com')).toBe(single.countFor('youtube.com'));
  });

  it('keeps concurrent requests for different origins separate', async () => {
    const net = counter();
    net.setDelay(10);
    const icons = new IconService(new IconCache(null), net.get);
    const [a, b] = await Promise.all([icons.resolve(YOUTUBE), icons.resolve(ROTTEN)]);
    expect(a.hostname).toBe('www.youtube.com');
    expect(b.hostname).toBe('www.rottentomatoes.com');
  });
});

describe('refresh', () => {
  it('re-resolves the selected origin and leaves every other entry alone', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE);
    await icons.resolve(ROTTEN);
    const youtubeBefore = net.countFor('youtube.com');
    const rottenBefore = net.countFor('rottentomatoes.com');

    const outcome = await icons.resolve(YOUTUBE, { refresh: true });
    expect(outcome.status).toBe('loaded');
    expect(net.countFor('youtube.com')).toBeGreaterThan(youtubeBefore);
    expect(net.countFor('rottentomatoes.com')).toBe(rottenBefore);

    // The other origin is still cached, so it was not flushed.
    expect((await icons.resolve(ROTTEN)).status).toBe('cached');
  });

  /**
   * Refresh must not join an in-flight resolve. Joining returns the PRE-refresh
   * promise, whose completion re-installs the entry that was just invalidated —
   * the button appears to work and changes nothing.
   */
  it('does not silently no-op when a resolve is already in flight', async () => {
    const net = counter();
    net.setDelay(30);
    const icons = new IconService(new IconCache(null), net.get);

    const inFlight = icons.resolve(YOUTUBE);
    const refreshed = await icons.resolve(YOUTUBE, { refresh: true });
    await inFlight;

    expect(refreshed.status).toBe('loaded');
    // Two genuine resolutions happened, not one shared promise.
    expect(net.countFor('youtube.com')).toBeGreaterThan(2);
  });

  it('leaves the refreshed origin cached again afterwards', async () => {
    const { icons, net } = service();
    await icons.resolve(YOUTUBE, { refresh: true });
    const after = net.calls.length;
    expect((await icons.resolve(YOUTUBE)).status).toBe('cached');
    expect(net.calls.length).toBe(after);
  });
});

describe('what is not eligible for a server-side fetch', () => {
  /**
   * Opening http://localhost:3000 from a key stays legal. Making this service
   * fetch from it does not — two capabilities, two policies.
   */
  it('refuses local and private destinations without touching the network', async () => {
    const { icons, net } = service();
    for (const template of [
      'http://localhost:3000/panel',
      'http://127.0.0.1/x',
      'http://192.168.1.10/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
      'http://nas.local/x',
    ]) {
      const outcome = await icons.resolve(template);
      expect(outcome.status).toBe('local_host');
    }
    expect(net.calls).toHaveLength(0);
  });

  it('refuses a template whose host depends on the current page', async () => {
    const { icons, net } = service();
    expect((await icons.resolve('https://{hostname}/search?q={title}')).status).toBe('dynamic_host');
    expect((await icons.resolve('https://{title}.example.com/')).status).toBe('dynamic_host');
    expect(net.calls).toHaveLength(0);
  });

  it('refuses non-web schemes and unusable templates', async () => {
    const { icons, net } = service();
    expect((await icons.resolve('javascript:alert(1)')).status).toBe('unsupported_scheme');
    expect((await icons.resolve('file:///C:/x')).status).toBe('unsupported_scheme');
    expect((await icons.resolve('not a url')).status).toBe('invalid_template');
    expect((await icons.resolve('')).status).toBe('invalid_template');
    expect((await icons.resolve('https://user:pass@example.com/')).status).toBe('invalid_template');
    expect(net.calls).toHaveLength(0);
  });
});

describe('failure never escapes', () => {
  it('reports unavailable when the site offers nothing usable', async () => {
    const net = counter(nothingUsable());
    const icons = new IconService(new IconCache(null), net.get);
    expect((await icons.resolve('https://example.com/?q={title}')).status).toBe('unavailable');
  });

  it('reports unavailable rather than throwing when the network throws', async () => {
    const icons = new IconService(new IconCache(null), async () => {
      throw new Error('socket exploded');
    });
    await expect(icons.resolve(YOUTUBE)).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' })
    );
  });

  it('does not re-fetch a site that just failed', async () => {
    const net = counter(nothingUsable());
    const icons = new IconService(new IconCache(null), net.get);
    await icons.resolve('https://example.com/?q={title}');
    const before = net.calls.length;
    expect((await icons.resolve('https://example.com/other')).status).toBe('unavailable');
    expect(net.calls.length).toBe(before);
  });

  it('releases its in-flight slot after a failure, so a later refresh works', async () => {
    let fail = true;
    const net = counter();
    const icons = new IconService(new IconCache(null), async (url, options) => {
      if (fail) throw new Error('down');
      return net.get(url, options);
    });
    expect((await icons.resolve(YOUTUBE)).status).toBe('unavailable');
    fail = false;
    expect((await icons.resolve(YOUTUBE, { refresh: true })).status).toBe('loaded');
  });

  it('never returns an icon larger than the ceiling', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_RESPONSE_BYTES + 1)]);
    const net = counter({
      'https://example.com': PAGE,
      'https://example.com/apple-touch-icon.png': oversized,
      'https://example.com/favicon.ico': oversized,
    });
    const icons = new IconService(new IconCache(null), net.get);
    expect((await icons.resolve('https://example.com/?q={title}')).status).toBe('unavailable');
  });
});
