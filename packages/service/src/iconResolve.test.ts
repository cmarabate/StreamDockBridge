import {
  resolveSiteIcon,
  rankIconCandidates,
  extractLinkTags,
  sniffMime,
  pngDimensions,
  MAX_HTML_BYTES,
  MAX_ICON_DIMENSION,
  RESOLVE_BUDGET_MS,
} from './iconResolve';
import { FetchedResource, GetOptions, IconFetchError, MAX_RESPONSE_BYTES } from './iconFetch';

/** Real magic bytes, so the sniffer is tested against what sites actually serve. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 64]), // 64x64
  Buffer.alloc(64),
]);
/**
 * Real headers, not stubs. Every accepted format must carry readable
 * dimensions or it is refused, so a fixture without them would be testing the
 * refusal rather than the acceptance.
 */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0'),
  Buffer.alloc(9),
  // SOF0: precision 8, height 64, width 64, 3 components.
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03]),
  Buffer.alloc(9),
]);

/** A one-entry 32x32 ICO directory with a BMP payload. */
const ICO = (() => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 32;
  entry[1] = 32;
  entry.writeUInt32LE(64, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, Buffer.alloc(64)]);
})();

/** VP8X container declaring a 64x64 canvas. */
const WEBP = (() => {
  const body = Buffer.alloc(40);
  body.write('RIFF', 0);
  body.write('WEBP', 8);
  body.write('VP8X', 12);
  body.writeUInt32LE(10, 16);
  body[24] = 63; // width - 1
  body[27] = 63; // height - 1
  return body;
})();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML_ONLY = Buffer.from('<!doctype html><html><body>not an image</body></html>');

function bigPng(width: number, height: number): Buffer {
  const png = Buffer.from(PNG);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

interface Route {
  status?: number;
  body?: Buffer;
  throws?: IconFetchError;
}

/** A stand-in for the network that records exactly what was asked for. */
function getterFor(routes: Record<string, Route>) {
  const asked: string[] = [];
  const get = async (rawUrl: string, options: GetOptions = {}): Promise<FetchedResource> => {
    asked.push(rawUrl);
    const route = routes[rawUrl];
    if (!route) throw new IconFetchError('network_error');
    if (route.throws) throw route.throws;
    const body = route.body ?? Buffer.alloc(0);
    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
    return {
      status: route.status ?? 200,
      headers: {},
      body: options.allowTruncation ? body.subarray(0, maxBytes) : body,
      finalUrl: rawUrl,
      truncated: options.allowTruncation === true && body.length > maxBytes,
    };
  };
  return { get, asked };
}

const page = (head: string) => Buffer.from(`<!doctype html><html><head>${head}</head><body></body></html>`);

describe('sniffing what the bytes actually are', () => {
  it('recognises the types the host can display', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(ICO)).toBe('image/x-icon');
    expect(sniffMime(WEBP)).toBe('image/webp');
  });

  /**
   * The host's decoder accepts SVG, but it is XML handed straight to a renderer
   * — entity expansion, external references, embedded script. Around 1% of
   * sites offer only SVG, which is a poor trade for that surface.
   */
  it('refuses SVG even though the host would accept it', () => {
    expect(sniffMime(SVG)).toBeNull();
  });

  it('refuses anything that is not a recognised image', () => {
    expect(sniffMime(HTML_ONLY)).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
    expect(sniffMime(Buffer.from([0x89, 0x50]))).toBeNull();
    // RIFF without the WEBP fourcc is some other container.
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]))).toBeNull();
  });

  it('reads declared PNG dimensions without decoding', () => {
    expect(pngDimensions(PNG)).toEqual({ width: 64, height: 64 });
    expect(pngDimensions(bigPng(30000, 30000))).toEqual({ width: 30000, height: 30000 });
    expect(pngDimensions(JPEG)).toBeNull();
    expect(pngDimensions(Buffer.alloc(4))).toBeNull();
  });
});

describe('ranking declared icons', () => {
  it('prefers the smallest size that still covers the key', () => {
    const ranked = rankIconCandidates(
      '<link rel="icon" sizes="16x16" href="/a.png">' +
        '<link rel="icon" sizes="144x144" href="/b.png">' +
        '<link rel="icon" sizes="512x512" href="/c.png">'
    );
    expect(ranked[0].href).toBe('/b.png');
  });

  it('falls back to the largest below the key size', () => {
    const ranked = rankIconCandidates(
      '<link rel="icon" sizes="16x16" href="/small.png">' +
        '<link rel="icon" sizes="64x64" href="/mid.png">'
    );
    expect(ranked[0].href).toBe('/mid.png');
  });

  it('accepts every icon rel form sites really use', () => {
    expect(rankIconCandidates('<link rel="icon" href="/a.ico">')[0].href).toBe('/a.ico');
    expect(rankIconCandidates('<link rel="shortcut icon" href="/b.ico">')[0].href).toBe('/b.ico');
    expect(rankIconCandidates('<link rel="apple-touch-icon" href="/c.png">')[0].href).toBe('/c.png');
    expect(rankIconCandidates("<link rel='ICON' href='/d.png'>")[0].href).toBe('/d.png');
    expect(rankIconCandidates('<link rel=icon href="/e.png">')[0].href).toBe('/e.png');
  });

  it('prefers an unsized apple-touch-icon over an unsized plain icon', () => {
    const ranked = rankIconCandidates(
      '<link rel="icon" href="/plain.png"><link rel="apple-touch-icon" href="/touch.png">'
    );
    expect(ranked[0].href).toBe('/touch.png');
  });

  /**
   * `/<link\b[^>]*>/g` is quadratic here: every `<link` start scans to
   * end-of-string before failing. On 192 KB of hostile input that measured at
   * ~4 seconds of blocked event loop, and this service is single-threaded, so
   * it would stall keyDown launches and context updates too.
   */
  it('does not stall on a body of unterminated link tags', () => {
    const hostile = '<link'.repeat(Math.ceil((192 * 1024) / 5));
    const started = Date.now();
    const tags = extractLinkTags(hostile);
    const elapsed = Date.now() - started;

    expect(tags).toHaveLength(0);
    expect(elapsed).toBeLessThan(250);
  });

  it('bounds how many tags and how much of each it will take', () => {
    const many = '<link rel="icon" href="/a.png">'.repeat(500);
    expect(extractLinkTags(many).length).toBeLessThanOrEqual(100);

    // A single absurdly long tag is skipped rather than carried around.
    const huge = `<link rel="icon" ${'x'.repeat(8192)} href="/a.png">`;
    expect(extractLinkTags(huge)).toHaveLength(0);
  });

  it('does not treat a longer element name as a link tag', () => {
    expect(extractLinkTags('<linkable href="/a.png">')).toHaveLength(0);
    expect(extractLinkTags('<link href="/a.png">')).toHaveLength(1);
    expect(extractLinkTags('<link/>')).toHaveLength(1);
  });

  it('ignores rels and types that would render as a blob', () => {
    expect(rankIconCandidates('<link rel="mask-icon" href="/m.svg">')).toHaveLength(0);
    expect(rankIconCandidates('<link rel="icon" type="image/svg+xml" href="/s.svg">')).toHaveLength(0);
    expect(rankIconCandidates('<link rel="stylesheet" href="/x.css">')).toHaveLength(0);
    expect(rankIconCandidates('<link rel="icon">')).toHaveLength(0);
  });
});

describe('resolving a site icon', () => {
  it('uses a declared rel=icon', async () => {
    const { get, asked } = getterFor({
      'https://example.com': { body: page('<link rel="icon" href="https://example.com/icon.png">') },
      'https://example.com/icon.png': { body: PNG },
    });
    const result = await resolveSiteIcon('https://example.com', get);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.icon.mime).toBe('image/png');
      expect(result.icon.dataUri.startsWith('data:image/png;base64,')).toBe(true);
    }
    expect(asked).toContain('https://example.com/icon.png');
  });

  it('uses rel="shortcut icon"', async () => {
    const { get } = getterFor({
      'https://example.com': { body: page('<link rel="shortcut icon" href="/short.ico">') },
      'https://example.com/short.ico': { body: ICO },
    });
    const result = await resolveSiteIcon('https://example.com', get);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.icon.sourceUrl).toBe('https://example.com/short.ico');
  });

  it('uses an apple-touch-icon', async () => {
    const { get } = getterFor({
      'https://example.com': { body: page('<link rel="apple-touch-icon" href="/touch.png">') },
      'https://example.com/touch.png': { body: PNG },
    });
    const result = await resolveSiteIcon('https://example.com', get);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.icon.sourceUrl).toBe('https://example.com/touch.png');
  });

  it('resolves relative and root-relative hrefs against the page', async () => {
    const { get, asked } = getterFor({
      'https://example.com': { body: page('<link rel="icon" href="assets/i.png">') },
      'https://example.com/assets/i.png': { body: PNG },
    });
    const result = await resolveSiteIcon('https://example.com', get);
    expect(result).toMatchObject({ ok: true });
    expect(asked).toContain('https://example.com/assets/i.png');
  });

  /** /favicon.ico is conventional, not required — but it is all some sites offer. */
  it('falls back to /favicon.ico when nothing is declared', async () => {
    const { get, asked } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: ICO },
    });
    const result = await resolveSiteIcon('https://example.com', get);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.icon.mime).toBe('image/x-icon');
    expect(asked).toEqual(['https://example.com', 'https://example.com/favicon.ico']);
  });

  it('falls back to /favicon.ico when the page itself cannot be read', async () => {
    const { get } = getterFor({
      'https://example.com': { throws: new IconFetchError('response_too_large') },
      'https://example.com/favicon.ico': { body: ICO },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toMatchObject({ ok: true });
  });

  /**
   * ICO goes through untouched. The host's decoder table accepts image/x-icon,
   * so decoding it here would add an image parser for no gain at all.
   */
  it('passes ICO bytes through without decoding them', async () => {
    const { get } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: ICO },
    });
    const result = await resolveSiteIcon('https://example.com', get);
    if (!result.ok) throw new Error('expected an icon');
    expect(result.icon.dataUri).toBe(`data:image/x-icon;base64,${ICO.toString('base64')}`);
    expect(result.icon.bytes).toBe(ICO.length);
  });

  it('accepts JPEG and WEBP as well as PNG', async () => {
    for (const [body, mime] of [
      [JPEG, 'image/jpeg'],
      [WEBP, 'image/webp'],
      [PNG, 'image/png'],
    ] as Array<[Buffer, string]>) {
      const { get } = getterFor({
        'https://example.com': { body: page('') },
        'https://example.com/favicon.ico': { body },
      });
      const result = await resolveSiteIcon('https://example.com', get);
      if (!result.ok) throw new Error(`expected an icon for ${mime}`);
      expect(result.icon.mime).toBe(mime);
    }
  });

  /** Content-Type is not trusted: many /favicon.ico responses are really PNG. */
  it('refuses bytes that are not a supported image, whatever the URL says', async () => {
    const { get } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: HTML_ONLY },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_image',
    });
  });

  /**
   * All four accepted formats carry their size in a header. A file whose header
   * cannot be read is either malformed or crafted to defeat this check while a
   * more lenient decoder resyncs and honours the real value, so it is refused.
   */
  it('refuses an image whose declared dimensions cannot be read', async () => {
    const headerless = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const { get } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: headerless },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_image',
    });
  });

  it('refuses an SVG served as the favicon', async () => {
    const { get } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: SVG },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'unsupported_image',
    });
  });

  /**
   * A ~10 KB PNG can declare 30000x30000 and demand gigabytes from whatever
   * decodes it — and the thing that decodes it is the host.
   */
  it('refuses a small PNG that declares enormous dimensions', async () => {
    const { get } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: bigPng(30000, 30000) },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'image_too_large',
    });
    expect(MAX_ICON_DIMENSION).toBe(1024);
  });

  it('refuses an image over the byte ceiling', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_RESPONSE_BYTES + 1)]);
    const { get } = getterFor({
      'https://example.com': { body: page('') },
      'https://example.com/favicon.ico': { body: oversized },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'image_too_large',
    });
  });

  it('reads the page under a bounded prefix and keeps the head', async () => {
    // A head, then far more body than the cap allows.
    const filler = 'x'.repeat(MAX_HTML_BYTES * 2);
    const html = Buffer.from(
      `<!doctype html><html><head><link rel="icon" href="/i.png"></head><body>${filler}</body></html>`
    );
    const seenOptions: GetOptions[] = [];
    const routes: Record<string, Route> = {
      'https://example.com': { body: html },
      'https://example.com/i.png': { body: PNG },
    };
    const get = async (rawUrl: string, options: GetOptions = {}): Promise<FetchedResource> => {
      seenOptions.push(options);
      const route = routes[rawUrl];
      if (!route) throw new IconFetchError('network_error');
      const body = route.body!;
      const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
      return {
        status: 200,
        headers: {},
        body: options.allowTruncation ? body.subarray(0, maxBytes) : body,
        finalUrl: rawUrl,
        truncated: options.allowTruncation === true && body.length > maxBytes,
      };
    };

    await expect(resolveSiteIcon('https://example.com', get)).resolves.toMatchObject({ ok: true });
    // HTML truncates; the image must not.
    expect(seenOptions[0]).toMatchObject({ maxBytes: MAX_HTML_BYTES, allowTruncation: true });
    expect(seenOptions[1].maxBytes).toBeUndefined();
    expect(seenOptions[1].allowTruncation).toBeUndefined();
    // Every hop draws on one whole-resolution budget, not a fresh one each time.
    expect(seenOptions[0].totalTimeoutMs).toBeLessThanOrEqual(RESOLVE_BUDGET_MS);
    expect(seenOptions[1].totalTimeoutMs).toBeLessThanOrEqual(seenOptions[0].totalTimeoutMs!);
  });

  /**
   * A page declaring an ineligible href is a broken page, not an attack, so it
   * must skip to the next candidate. Only a REDIRECT into private space ends
   * the attempt — and that distinction only holds because the candidate URL is
   * judged before it is requested.
   */
  it('skips an ineligible declared href and still reaches the fallback', async () => {
    const { get, asked } = getterFor({
      'https://example.com': {
        body: page(
          '<link rel="icon" sizes="180x180" href="http://127.0.0.1/secret.png">' +
            '<link rel="icon" sizes="181x181" href="ftp://example.com/x.png">' +
            '<link rel="icon" sizes="182x182" href="http://example.com:8080/x.png">'
        ),
      },
      'https://example.com/favicon.ico': { body: PNG },
    });

    await expect(resolveSiteIcon('https://example.com', get)).resolves.toMatchObject({ ok: true });
    // None of the ineligible candidates was ever requested.
    expect(asked).toEqual(['https://example.com', 'https://example.com/favicon.ico']);
  });

  /** A redirect into private space ends the attempt rather than trying on. */
  it('stops when a candidate redirects somewhere ineligible', async () => {
    const { get, asked } = getterFor({
      'https://example.com': { body: page('<link rel="icon" href="/a.png">') },
      'https://example.com/a.png': { throws: new IconFetchError('blocked_host') },
      'https://example.com/favicon.ico': { body: PNG },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'fetch_failed',
    });
    expect(asked).not.toContain('https://example.com/favicon.ico');
  });

  it('tries the next candidate when one merely fails', async () => {
    const { get } = getterFor({
      'https://example.com': {
        body: page('<link rel="icon" sizes="144x144" href="/a.png"><link rel="icon" href="/b.png">'),
      },
      'https://example.com/a.png': { throws: new IconFetchError('timeout') },
      'https://example.com/b.png': { body: PNG },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toMatchObject({ ok: true });
  });

  it('reports failure when nothing can be fetched at all', async () => {
    const { get } = getterFor({});
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'fetch_failed',
    });
  });

  it('ignores a non-2xx page and a non-2xx icon', async () => {
    const { get } = getterFor({
      'https://example.com': { status: 500, body: page('<link rel="icon" href="/a.png">') },
      'https://example.com/favicon.ico': { status: 404, body: PNG },
    });
    await expect(resolveSiteIcon('https://example.com', get)).resolves.toEqual({
      ok: false,
      reason: 'fetch_failed',
    });
  });

  it('never tries more than a handful of candidates', async () => {
    const links = Array.from({ length: 20 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join('');
    const routes: Record<string, Route> = { 'https://example.com': { body: page(links) } };
    const { get, asked } = getterFor(routes);
    await resolveSiteIcon('https://example.com', get);
    // One page read plus a bounded number of candidates.
    expect(asked.length).toBeLessThanOrEqual(6);
  });
});
