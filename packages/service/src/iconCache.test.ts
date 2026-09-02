import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  IconCache,
  IconCacheHit,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  SUCCESS_TTL_MS,
  FAILURE_TTL_MS,
  MAX_DATA_URI_LENGTH,
  CACHE_VERSION,
} from './iconCache';

const icon = (bytes = 64, mime = 'image/png'): IconCacheHit => ({
  dataUri: `data:${mime};base64,${Buffer.alloc(bytes).toString('base64')}`,
  mime,
  bytes,
  sourceUrl: 'https://example.com/favicon.ico',
});

let tempDirs: string[] = [];
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-cache-'));
  tempDirs.push(dir);
  return path.join(dir, 'iconCache.json');
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('storing and reusing icons', () => {
  it('returns a stored icon and reports a miss for anything else', () => {
    const cache = new IconCache(null);
    cache.set('https://example.com', icon());
    expect(cache.get('https://example.com')).toMatchObject({ state: 'hit' });
    expect(cache.get('https://other.com')).toEqual({ state: 'miss' });
  });

  /**
   * The key's icon belongs to the SITE. Two keys differing only in query share
   * one entry, which is what makes a second key free and a title change inert.
   */
  it('shares one entry across every key on the same origin', () => {
    const cache = new IconCache(null);
    cache.set('https://www.youtube.com', icon());
    expect(cache.get('https://www.youtube.com')).toMatchObject({ state: 'hit' });
    expect(cache.get('https://www.youtube.com')).toMatchObject({ state: 'hit' });
    expect(cache.size()).toBe(1);
  });

  /**
   * A site with no usable icon is remembered too, briefly. Without this, every
   * willAppear re-fetches it — exactly the redundant network to be avoided.
   */
  it('remembers a failure so it is not retried immediately', () => {
    const cache = new IconCache(null);
    cache.setFailure('https://example.com', 'unsupported_image');
    expect(cache.get('https://example.com')).toEqual({
      state: 'failed',
      failure: 'unsupported_image',
    });
  });

  it('expires a stored icon after its lifetime', () => {
    const cache = new IconCache(null);
    const t0 = 1_000_000;
    cache.set('https://example.com', icon(), t0);
    expect(cache.get('https://example.com', t0 + SUCCESS_TTL_MS - 1)).toMatchObject({ state: 'hit' });
    expect(cache.get('https://example.com', t0 + SUCCESS_TTL_MS + 1)).toEqual({ state: 'miss' });
  });

  it('expires a remembered failure far sooner than a success', () => {
    const cache = new IconCache(null);
    const t0 = 1_000_000;
    cache.setFailure('https://example.com', 'fetch_failed', t0);
    expect(cache.get('https://example.com', t0 + FAILURE_TTL_MS - 1)).toMatchObject({ state: 'failed' });
    expect(cache.get('https://example.com', t0 + FAILURE_TTL_MS + 1)).toEqual({ state: 'miss' });
    expect(FAILURE_TTL_MS).toBeLessThan(SUCCESS_TTL_MS);
  });

  /** Refresh drops one origin. It must never flush everything else. */
  it('invalidates exactly one origin', () => {
    const cache = new IconCache(null);
    cache.set('https://a.com', icon());
    cache.set('https://b.com', icon());
    cache.invalidate('https://a.com');
    expect(cache.get('https://a.com')).toEqual({ state: 'miss' });
    expect(cache.get('https://b.com')).toMatchObject({ state: 'hit' });
  });
});

describe('bounds', () => {
  it('evicts least-recently-used once the entry count is exceeded', () => {
    const cache = new IconCache(null);
    for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`https://site${i}.com`, icon(16));
    expect(cache.size()).toBe(MAX_ENTRIES);

    // Touch the oldest so it is no longer the eviction candidate.
    expect(cache.get('https://site0.com')).toMatchObject({ state: 'hit' });
    cache.set('https://newcomer.com', icon(16));

    expect(cache.size()).toBe(MAX_ENTRIES);
    expect(cache.get('https://site0.com')).toMatchObject({ state: 'hit' });
    expect(cache.get('https://site1.com')).toEqual({ state: 'miss' });
    expect(cache.get('https://newcomer.com')).toMatchObject({ state: 'hit' });
  });

  it('evicts once the total byte ceiling is exceeded', () => {
    const cache = new IconCache(null);
    const chunk = Math.floor(MAX_TOTAL_BYTES / 4);
    for (let i = 0; i < 6; i++) cache.set(`https://site${i}.com`, icon(chunk));
    expect(cache.totalBytes()).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(cache.size()).toBeLessThan(6);
  });

  it('refuses to store an entry larger than the per-entry ceiling', () => {
    const cache = new IconCache(null);
    expect(cache.set('https://example.com', icon(MAX_ENTRY_BYTES + 1))).toBe(false);
    expect(cache.get('https://example.com')).toEqual({ state: 'miss' });
  });

  it('cannot grow without bound under sustained writes', () => {
    const cache = new IconCache(null);
    for (let i = 0; i < MAX_ENTRIES * 10; i++) cache.set(`https://site${i}.com`, icon(16));
    expect(cache.size()).toBe(MAX_ENTRIES);
    expect(cache.totalBytes()).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });
});

describe('surviving a restart', () => {
  it('reloads stored icons from disk', () => {
    const file = tempFile();
    const first = new IconCache(file);
    first.set('https://www.youtube.com', icon());

    const second = new IconCache(file);
    const hit = second.get('https://www.youtube.com');
    expect(hit).toMatchObject({ state: 'hit' });
    if (hit.state === 'hit') expect(hit.icon.mime).toBe('image/png');
  });

  /** A failing site is given another chance after a restart. */
  it('does not persist remembered failures', () => {
    const file = tempFile();
    const first = new IconCache(file);
    first.setFailure('https://example.com', 'unsupported_image');
    expect(new IconCache(file).get('https://example.com')).toEqual({ state: 'miss' });
  });

  it('drops entries that expired while the service was down', () => {
    const file = tempFile();
    const cache = new IconCache(file);
    cache.set('https://example.com', icon(), Date.now() - SUCCESS_TTL_MS - 1000);
    expect(new IconCache(file).get('https://example.com')).toEqual({ state: 'miss' });
  });

  /**
   * This file feeds data URIs onward to the host's image decoder, so anything
   * that does not look exactly like one this service wrote is dropped.
   */
  it('refuses malformed entries on disk rather than trusting them', () => {
    const file = tempFile();
    const now = Date.now();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CACHE_VERSION,
        entries: [
          { origin: 'https://a.com', icon: { dataUri: 'javascript:alert(1)', mime: 'image/png', bytes: 4 }, fetchedAt: now },
          { origin: 'https://b.com', icon: { dataUri: 'data:image/svg+xml;base64,AAAA', mime: 'image/svg+xml', bytes: 4 }, fetchedAt: now },
          { origin: 'https://c.com', icon: { dataUri: 'data:image/png;base64,AAAA', mime: 'image/png', bytes: MAX_ENTRY_BYTES + 1 }, fetchedAt: now },
          { origin: 'https://d.com', icon: { dataUri: 'data:image/png;base64,<script>', mime: 'image/png', bytes: 4 }, fetchedAt: now },
          { icon: { dataUri: 'data:image/png;base64,AAAA', mime: 'image/png', bytes: 4 }, fetchedAt: now },
          { origin: 'https://ok.com', icon: { dataUri: 'data:image/png;base64,AAAA', mime: 'image/png', bytes: 4, sourceUrl: 'https://ok.com/f.ico' }, fetchedAt: now },
        ],
      })
    );

    const cache = new IconCache(file);
    expect(cache.get('https://a.com')).toEqual({ state: 'miss' });
    expect(cache.get('https://b.com')).toEqual({ state: 'miss' });
    expect(cache.get('https://c.com')).toEqual({ state: 'miss' });
    expect(cache.get('https://d.com')).toEqual({ state: 'miss' });
    expect(cache.get('https://ok.com')).toMatchObject({ state: 'hit' });
    expect(cache.size()).toBe(1);
  });

  /**
   * The size guard has to be on the STRING, not on the entry's self-declared
   * `bytes`. An entry claiming `bytes: 1` beside a huge data URI otherwise
   * passes every other guard and is handed to the host's decoder.
   */
  it('refuses an entry whose data URI is huge but claims to be tiny', () => {
    const file = tempFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CACHE_VERSION,
        entries: [
          {
            origin: 'https://liar.com',
            icon: {
              dataUri: 'data:image/png;base64,' + 'A'.repeat(MAX_DATA_URI_LENGTH),
              mime: 'image/png',
              bytes: 1,
            },
            fetchedAt: Date.now(),
          },
        ],
      })
    );
    expect(new IconCache(file).get('https://liar.com')).toEqual({ state: 'miss' });
  });

  /** `$` also matches immediately before a trailing newline. */
  it('refuses a data URI carrying a smuggled newline', () => {
    const file = tempFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: CACHE_VERSION,
        entries: [
          {
            origin: 'https://nl.com',
            icon: { dataUri: 'data:image/png;base64,AAAA\n', mime: 'image/png', bytes: 4 },
            fetchedAt: Date.now(),
          },
        ],
      })
    );
    expect(new IconCache(file).get('https://nl.com')).toEqual({ state: 'miss' });
  });

  it('starts empty rather than failing when the file is corrupt', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'this is not json');
    expect(() => new IconCache(file)).not.toThrow();
    expect(new IconCache(file).size()).toBe(0);
  });

  it('works with no file at all', () => {
    const cache = new IconCache(null);
    cache.set('https://example.com', icon());
    expect(cache.get('https://example.com')).toMatchObject({ state: 'hit' });
  });
});
