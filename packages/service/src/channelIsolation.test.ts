import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createBridgeServer, resolveContextChannel, NO_CONTEXT_ERROR } from './server';
import { SecretStore } from './secretStore';
import { contextChannels, BrowserMode, SOURCE_TTL_MS } from './contextChannels';
import { CONTEXT_URL_PRESETS } from './contextUrlPresets';

/**
 * The failure this file exists to prevent.
 *
 * Regular Show was playing in Brave. Chrome was in front, showing a Supabase
 * admin page. The owner pressed ReelGood and it searched the SUPABASE page
 * title, because a media key with no media quietly fell through to whatever
 * the page channel happened to hold.
 *
 * A media key must read media, and must fail when there is none.
 */

const PORT = 17439;
let server: ReturnType<typeof createBridgeServer>;
let secret: string;
let tempDir: string;
let launched: string[] = [];

const BRAVE = 'brave-real-instance';
const CHROME = 'chrome-real-instance';

const REGULAR_SHOW = {
  title: 'Regular Show',
  url: 'https://www.hulu.com/watch/abc-def',
};
const SUPABASE = {
  title: 'Emails | Authentication | Chrisyphus Ecosystem | cmarabate | Supabase',
  url: 'https://supabase.com/dashboard/project/abc/auth/templates',
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-iso-'));
  const secretStore = new SecretStore(path.join(tempDir, 'secret.key'));
  secret = secretStore.getSecret();
  server = createBridgeServer({
    port: PORT,
    secretStore,
    launcher: (url) => launched.push(url),
    iconService: { resolve: async () => ({ status: 'local_host' }) } as never,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  contextChannels.clear();
  launched = [];
});

function call(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: any = null;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, json: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const authed = (m: string, p: string, b?: unknown) =>
  call(m, p, b, { 'X-Bridge-Secret': secret });

let seq = 0;
function publish(id: string, mode: BrowserMode, channel: string, title: string, url: string) {
  return authed('POST', '/context', {
    source: {
      browserInstanceId: id,
      browserFamily: id.startsWith('brave') ? 'brave' : 'chrome',
      displayName: id.startsWith('brave') ? 'Brave Personal' : 'Chrome Personal',
      mode,
      connectionGeneration: 1,
    },
    channel,
    observationSequence: ++seq,
    documentTitle: title,
    rawTitle: title,
    url,
    hostname: new URL(url).hostname,
    tabId: 1,
    windowId: 1,
    timestamp: Date.now(),
  });
}

const REELGOOD = 'https://reelgood.com/search?q={title}';

describe('the owner\'s exact failure scenario', () => {
  it('searches Regular Show, not the Supabase page Chrome is showing', async () => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);

    const res = await authed('POST', '/lookup/custom', { template: REELGOOD });

    expect(res.json.success).toBe(true);
    expect(res.json.resolvedUrl).toBe('https://reelgood.com/search?q=Regular%20Show');
    // Nothing from the work browser can appear in a media search.
    for (const word of ['Supabase', 'Emails', 'Authentication', 'Chrisyphus', 'cmarabate']) {
      expect(res.json.resolvedUrl).not.toContain(word);
    }
  });

  /**
   * The critical regression. With media absent and a perfectly good page
   * sitting there, the key must refuse rather than search it.
   */
  it('fails closed when there is no media, even though Page has something', async () => {
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);

    const res = await authed('POST', '/lookup/custom', { template: REELGOOD });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('no_media_context');
    expect(launched).toEqual([]);
  });

  it('still fails closed after the media owner disconnects', async () => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);
    await authed('POST', '/sources/disconnect', { browserInstanceId: BRAVE });

    const res = await authed('POST', '/lookup/custom', { template: REELGOOD });
    expect(res.json.error).toBe('no_media_context');
    expect(launched).toEqual([]);
  });

  /** Every migrated media key, not just ReelGood. */
  it.each([
    ['IMDb', 'https://www.imdb.com/find?q={title}'],
    ['CAST', 'https://www.google.com/search?q={title}%20cast'],
    ['JustWatch', 'https://www.justwatch.com/us/search?q={title}'],
    ['Reddit', 'https://www.reddit.com/search/?q={title}'],
    ['Trailer', 'https://www.youtube.com/results?search_query={title}+trailer'],
    ['Rotten Tomatoes', 'https://www.rottentomatoes.com/search?search={title}'],
  ])('%s reads media and never the page', async (_name, template) => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);

    const res = await authed('POST', '/lookup/custom', { template });
    expect(res.json.resolvedUrl).toContain('Regular%20Show');
    expect(res.json.resolvedUrl).not.toContain('Supabase');
  });

  it('built-in legacy routes read media too', async () => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);

    for (const route of ['imdb', 'cast', 'justwatch', 'reddit']) {
      const res = await call('POST', `/lookup/${route}`, {});
      expect(res.json.url).toContain('Regular%20Show');
      expect(res.json.url).not.toContain('Supabase');
    }
  });
});

describe('strict channel selection', () => {
  beforeEach(async () => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);
  });

  it('contextMode media reads only media', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://x.example/?q={title}',
      contextMode: 'media',
    });
    expect(res.json.resolvedUrl).toContain('Regular%20Show');
  });

  it('contextMode page reads only page', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://x.example/?q={hostname}',
      contextMode: 'page',
    });
    expect(res.json.resolvedUrl).toBe('https://x.example/?q=supabase.com');
  });

  it('contextMode page fails closed when only media exists', async () => {
    contextChannels.clear();
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);

    const res = await authed('POST', '/lookup/custom', {
      template: 'https://x.example/?q={title}',
      contextMode: 'page',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('no_page_context');
  });

  it('contextMode project refuses rather than borrowing another channel', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://github.com/{title}',
      contextMode: 'project',
    });
    expect(res.status).toBe(400);
    expect(launched).toEqual([]);
  });
});

describe('auto infers from configuration, never from what has data', () => {
  it('sends every media preset to the media channel', () => {
    for (const preset of CONTEXT_URL_PRESETS.filter((p) => p.group === 'Media')) {
      expect(resolveContextChannel('auto', preset.urlTemplate)).toBe('media');
    }
  });

  it('sends every this-page preset to the page channel', () => {
    for (const preset of CONTEXT_URL_PRESETS.filter((p) => p.group === 'This page')) {
      expect(resolveContextChannel('auto', preset.urlTemplate)).toBe('page');
    }
  });

  /**
   * Every Context URL key that existed before channels did was a media search,
   * so an unrecognised template defaults to media. It fails closed from there
   * rather than reaching for the page.
   */
  it('defaults an unrecognised template to media', () => {
    expect(resolveContextChannel('auto', 'https://example.com/?q={title}')).toBe('media');
    expect(resolveContextChannel('auto', '')).toBe('media');
  });

  it('always obeys an explicit mode', () => {
    const mediaPreset = CONTEXT_URL_PRESETS.find((p) => p.id === 'imdb')!.urlTemplate;
    expect(resolveContextChannel('page', mediaPreset)).toBe('page');
    expect(resolveContextChannel('project', mediaPreset)).toBe('project');
    expect(resolveContextChannel('media', mediaPreset)).toBe('media');
  });

  it('names the missing channel in its error', () => {
    expect(NO_CONTEXT_ERROR.media).toBe('no_media_context');
    expect(NO_CONTEXT_ERROR.page).toBe('no_page_context');
    expect(NO_CONTEXT_ERROR.project).toBe('no_project_context');
  });
});

describe('liveness is not content', () => {
  /**
   * A browser playing one episode for an hour publishes nothing new. Its media
   * must not be released underneath it.
   */
  it('keeps media alive across the TTL while the browser heartbeats', async () => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);

    const heartbeat = () =>
      authed('POST', '/sources/heartbeat', {
        source: {
          browserInstanceId: BRAVE,
          browserFamily: 'brave',
          displayName: 'Brave Personal',
          mode: 'MEDIA_BROWSER',
          connectionGeneration: 1,
        },
      });

    // Several TTL windows pass with no new observation, only heartbeats.
    for (let i = 0; i < 4; i++) {
      const res = await heartbeat();
      expect(res.json.success).toBe(true);
      expect(res.json.owned).toContain('media');
    }

    const res = await authed('POST', '/lookup/custom', { template: REELGOOD });
    expect(res.json.resolvedUrl).toContain('Regular%20Show');
  });

  it('tells a browser which channels it still owns, so it can notice a restart', async () => {
    const res = await authed('POST', '/sources/heartbeat', {
      source: {
        browserInstanceId: BRAVE,
        browserFamily: 'brave',
        displayName: 'Brave Personal',
        mode: 'MEDIA_BROWSER',
        connectionGeneration: 1,
      },
    });
    // The service was cleared, so it holds nothing for this browser.
    expect(res.json.owned).toEqual([]);
  });

  it('requires the secret to heartbeat', async () => {
    const res = await call('POST', '/sources/heartbeat', { source: { browserInstanceId: BRAVE } });
    expect(res.status).toBe(401);
  });

  it('expires a source that stops heartbeating altogether', () => {
    // Proven against the store directly, where the clock can be moved.
    const t0 = 1_000_000;
    contextChannels.clear();
    contextChannels.observe(
      {
        source: {
          browserInstanceId: BRAVE,
          browserFamily: 'brave',
          displayName: 'Brave',
          mode: 'MEDIA_BROWSER',
          connectionGeneration: 1,
        },
        channel: 'media',
        payload: {
          url: REGULAR_SHOW.url,
          hostname: 'www.hulu.com',
          rawTitle: REGULAR_SHOW.title,
          documentTitle: REGULAR_SHOW.title,
          ogTitle: '',
          twitterTitle: '',
          jsonLdTitle: '',
          jsonLdSeriesTitle: '',
          canonicalTitle: REGULAR_SHOW.title,
          tabId: 1,
          windowId: 1,
          timestamp: t0,
        },
        tabId: 1,
        windowId: 1,
        observationSequence: 1,
        observedAt: t0,
      },
      t0
    );

    expect(contextChannels.getRecord('media', t0 + SOURCE_TTL_MS - 1)).not.toBeNull();
    expect(contextChannels.getRecord('media', t0 + SOURCE_TTL_MS + 1)).toBeNull();
  });
});

describe('cross-channel contamination', () => {
  it('cannot be caused by any amount of Chrome page activity', async () => {
    await publish(BRAVE, 'MEDIA_BROWSER', 'media', REGULAR_SHOW.title, REGULAR_SHOW.url);

    for (let i = 0; i < 20; i++) {
      await publish(CHROME, 'WORK_BROWSER', 'page', `${SUPABASE.title} ${i}`, `${SUPABASE.url}?i=${i}`);
    }

    const res = await authed('POST', '/lookup/custom', { template: REELGOOD });
    expect(res.json.resolvedUrl).toBe('https://reelgood.com/search?q=Regular%20Show');
  });

  it('cannot be caused by Brave media activity disturbing the page', async () => {
    await publish(CHROME, 'WORK_BROWSER', 'page', SUPABASE.title, SUPABASE.url);
    for (let i = 0; i < 10; i++) {
      await publish(BRAVE, 'MEDIA_BROWSER', 'media', `Episode ${i}`, `https://www.hulu.com/watch/${i}`);
    }

    const res = await authed('POST', '/lookup/custom', {
      template: 'https://x.example/?q={hostname}',
      contextMode: 'page',
    });
    expect(res.json.resolvedUrl).toBe('https://x.example/?q=supabase.com');
  });
});
