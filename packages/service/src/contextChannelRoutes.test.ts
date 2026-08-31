import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createBridgeServer } from './server';
import { SecretStore } from './secretStore';
import { contextChannels, BrowserMode } from './contextChannels';

/**
 * The multi-browser promise, proved over real HTTP rather than against the
 * store directly: Brave publishing media and Chrome publishing page/project at
 * the same time, neither disturbing the other.
 */

const PORT = 17431;
let server: ReturnType<typeof createBridgeServer>;
let secret: string;
let tempDir: string;
let launched: string[] = [];

const BRAVE = 'brave-instance-aaaa';
const CHROME = 'chrome-instance-bbbb';

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-chan-'));
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

function request(
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

const authed = (method: string, pathname: string, body?: unknown) =>
  request(method, pathname, body, { 'X-Bridge-Secret': secret });

function sourceBody(
  browserInstanceId: string,
  mode: BrowserMode,
  extra: Record<string, unknown> = {},
  generation = 1
) {
  return {
    source: {
      browserInstanceId,
      browserFamily: browserInstanceId.startsWith('brave') ? 'brave' : 'chrome',
      displayName: browserInstanceId.startsWith('brave') ? 'Brave Personal' : 'Chrome Personal',
      mode,
      connectionGeneration: generation,
    },
    ...extra,
  };
}

let seq = 0;
const pageObservation = (
  id: string,
  mode: BrowserMode,
  channel: string,
  title: string,
  url: string
) =>
  sourceBody(id, mode, {
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

describe('two browsers on one service', () => {
  it('lets Brave own media and Chrome own page at the same time', async () => {
    const brave = await authed(
      'POST',
      '/context',
      pageObservation(BRAVE, 'MEDIA_BROWSER', 'media', 'Brickleberry', 'https://www.disneyplus.com/x')
    );
    const chrome = await authed(
      'POST',
      '/context',
      pageObservation(CHROME, 'WORK_BROWSER', 'page', 'GitHub', 'https://github.com/cmarabate/x')
    );

    expect(brave.json).toMatchObject({ success: true, updated: true, channel: 'media' });
    expect(chrome.json).toMatchObject({ success: true, updated: true, channel: 'page' });

    const contexts = await request('GET', '/contexts');
    expect(contexts.json.contexts.media.owner.browserInstanceId).toBe(BRAVE);
    expect(contexts.json.contexts.media.value.canonicalTitle).toBe('Brickleberry');
    expect(contexts.json.contexts.page.owner.browserInstanceId).toBe(CHROME);
    expect(contexts.json.contexts.page.value.rawTitle).toBe('GitHub');
  });

  /** The regression that motivated all of this. */
  it('does not let Chrome browsing overwrite the media a key will read', async () => {
    await authed(
      'POST',
      '/context',
      pageObservation(BRAVE, 'MEDIA_BROWSER', 'media', 'Brickleberry', 'https://www.disneyplus.com/x')
    );

    for (let i = 0; i < 5; i++) {
      await authed(
        'POST',
        '/context',
        pageObservation(CHROME, 'WORK_BROWSER', 'page', `Work ${i}`, `https://example.com/${i}`)
      );
    }

    // The legacy view — what every existing media key resolves against.
    const legacy = await request('GET', '/context');
    expect(legacy.json.context.canonicalTitle).toBe('Brickleberry');

    // And an actual media lookup opens the right destination.
    const lookup = await authed('POST', '/lookup/custom', {
      template: 'https://www.youtube.com/results?search_query={title}+trailer',
    });
    expect(lookup.json.success).toBe(true);
    expect(lookup.json.resolvedUrl).toBe(
      'https://www.youtube.com/results?search_query=Brickleberry+trailer'
    );
  });

  it('refuses a channel the publishing browser is not configured for', async () => {
    const refused = await authed(
      'POST',
      '/context',
      pageObservation(CHROME, 'WORK_BROWSER', 'media', 'Shopping', 'https://example.com/buy')
    );
    expect(refused.json).toMatchObject({
      success: true,
      updated: false,
      reason: 'mode_forbids_channel',
    });

    const contexts = await request('GET', '/contexts');
    expect(contexts.json.contexts.media).toBeNull();
  });

  it('reports both installations as distinct sources', async () => {
    await authed(
      'POST',
      '/context',
      pageObservation(BRAVE, 'MEDIA_BROWSER', 'media', 'Show', 'https://example.com/a')
    );
    await authed(
      'POST',
      '/context',
      pageObservation(CHROME, 'WORK_BROWSER', 'page', 'Work', 'https://example.com/b')
    );

    const sources = await request('GET', '/sources');
    const ids = sources.json.sources.map((s: any) => s.browserInstanceId).sort();
    expect(ids).toEqual([BRAVE, CHROME].sort());
    // No secret ever appears in an inspection response.
    expect(JSON.stringify(sources.json)).not.toContain(secret);
  });
});

describe('contextMode on a Context URL key', () => {
  beforeEach(async () => {
    await authed(
      'POST',
      '/context',
      pageObservation(BRAVE, 'MEDIA_BROWSER', 'media', 'Brickleberry', 'https://www.disneyplus.com/x')
    );
    await authed(
      'POST',
      '/context',
      pageObservation(CHROME, 'WORK_BROWSER', 'page', 'Pull Requests', 'https://github.com/a/b/pulls')
    );
  });

  /** A key written before channels existed carries no contextMode. */
  it('defaults to the media-then-page view, matching the old behaviour', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://www.google.com/search?q={title}',
    });
    expect(res.json.resolvedUrl).toBe('https://www.google.com/search?q=Brickleberry');
  });

  it('reads the media channel when asked for media', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://www.google.com/search?q={title}',
      contextMode: 'media',
    });
    expect(res.json.resolvedUrl).toBe('https://www.google.com/search?q=Brickleberry');
  });

  it('reads the page channel when asked for page', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://www.google.com/search?q={hostname}',
      contextMode: 'page',
    });
    expect(res.json.resolvedUrl).toBe('https://www.google.com/search?q=github.com');
  });

  it('refuses a project template rather than opening the wrong thing', async () => {
    const res = await authed('POST', '/lookup/custom', {
      template: 'https://github.com/{title}',
      contextMode: 'project',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('project_context_unsupported');
    expect(launched).toHaveLength(0);
  });
});

describe('sources going away', () => {
  it('releases a browser\'s channels when it says goodbye', async () => {
    await authed(
      'POST',
      '/context',
      pageObservation(BRAVE, 'MEDIA_BROWSER', 'media', 'Show', 'https://example.com/a')
    );
    await authed(
      'POST',
      '/context',
      pageObservation(CHROME, 'WORK_BROWSER', 'page', 'Work', 'https://example.com/b')
    );

    const bye = await authed('POST', '/sources/disconnect', { browserInstanceId: BRAVE });
    expect(bye.json).toEqual({ success: true });

    const contexts = await request('GET', '/contexts');
    expect(contexts.json.contexts.media).toBeNull();
    // The other browser is unaffected.
    expect(contexts.json.contexts.page.owner.browserInstanceId).toBe(CHROME);
  });

  it('requires the secret to disconnect a source', async () => {
    const res = await request('POST', '/sources/disconnect', { browserInstanceId: BRAVE });
    expect(res.status).toBe(401);
  });
});

describe('backward compatibility', () => {
  /** An extension built before channels sends no source at all. */
  it('accepts a legacy post and serves it as the media context', async () => {
    const res = await authed('POST', '/context', {
      url: 'https://www.amazon.com/x',
      hostname: 'www.amazon.com',
      documentTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
      tabId: 3,
      windowId: 4,
      timestamp: Date.now(),
    });
    expect(res.json).toMatchObject({ success: true, updated: true });

    const legacy = await request('GET', '/context');
    expect(legacy.json.context.canonicalTitle).toBe('Gary and His Demons');
  });

  /**
   * A client-supplied timestamp far in the future would otherwise wedge the
   * legacy store: every later honest post looks older and is rejected forever.
   */
  it('clamps a future timestamp to the server clock', async () => {
    await authed('POST', '/context', {
      url: 'https://example.com/first',
      hostname: 'example.com',
      documentTitle: 'First',
      timestamp: Date.now() + 1_000_000_000,
    });

    const later = await authed('POST', '/context', {
      url: 'https://example.com/second',
      hostname: 'example.com',
      documentTitle: 'Second',
      timestamp: Date.now(),
    });

    expect(later.json.updated).toBe(true);
    const legacy = await request('GET', '/context');
    expect(legacy.json.context.canonicalTitle).toBe('Second');
  });
});
