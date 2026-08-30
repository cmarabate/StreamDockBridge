import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createBridgeServer } from './server';
import { contextStore, ContextRecord } from './contextStore';
import { SecretStore } from './secretStore';

/** The owner's real captured context from the physical canary. */
const PRIME_VIDEO: ContextRecord = {
  url: 'https://www.amazon.com/gp/video/detail/0QD2FDHVUZNOEJDT5JE9SSRBQX/ref=atv_plr_detail_play',
  hostname: 'www.amazon.com',
  rawTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
  documentTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
  ogTitle: '',
  twitterTitle: '',
  jsonLdTitle: '',
  jsonLdSeriesTitle: '',
  canonicalTitle: 'Gary and His Demons',
  tabId: 1,
  windowId: 1,
  timestamp: 1000,
};

describe('POST /lookup/custom', () => {
  let tmpSecretFile: string;
  let secretStore: SecretStore;
  let server: ReturnType<typeof createBridgeServer>;
  let launched: string[] = [];
  const testPort = 17347;

  beforeAll(async () => {
    tmpSecretFile = path.join(os.tmpdir(), `sdb-custom-${Date.now()}.key`);
    secretStore = new SecretStore(tmpSecretFile);
    server = createBridgeServer({
      port: testPort,
      host: '127.0.0.1',
      secretStore,
      launcher: (url: string) => launched.push(url),
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    if (fs.existsSync(tmpSecretFile)) fs.unlinkSync(tmpSecretFile);
  });

  beforeEach(() => {
    contextStore.clear();
    launched = [];
  });

  const request = (
    pathname: string,
    headers: Record<string, string> = {},
    body?: unknown
  ): Promise<{ statusCode: number; data: any }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${testPort}${pathname}`,
        { method: 'POST', headers },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode || 500, data: JSON.parse(data) });
            } catch (e) {
              resolve({ statusCode: res.statusCode || 500, data });
            }
          });
        }
      );
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  const authed = () => ({
    'Content-Type': 'application/json',
    'X-Bridge-Secret': secretStore.getSecret(),
  });

  const custom = (template: unknown, extra: Record<string, unknown> = {}) =>
    request('/lookup/custom', authed(), { template, ...extra });

  it('rejects an unauthenticated request and launches nothing', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await request('/lookup/custom', { 'Content-Type': 'application/json' }, {
      template: 'https://example.com/?q={title}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.data.error).toBe('unauthorized');
    expect(launched).toEqual([]);
  });

  it('rejects a disallowed origin before authentication', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await request(
      '/lookup/custom',
      { ...authed(), Origin: 'https://evil.example' },
      { template: 'https://example.com/?q={title}' }
    );
    expect(res.statusCode).toBe(403);
    expect(launched).toEqual([]);
  });

  it('resolves the product example against the real context', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await custom('https://www.youtube.com/results?search_query={title}+trailer');

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({
      success: true,
      action: 'custom',
      resolvedUrl: 'https://www.youtube.com/results?search_query=Gary%20and%20His%20Demons+trailer',
    });
    expect(launched).toEqual([res.data.resolvedUrl]);
  });

  it('resolves a second, different template against the same context', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await custom('https://www.rottentomatoes.com/search?search={title}');
    expect(res.data.resolvedUrl).toBe(
      'https://www.rottentomatoes.com/search?search=Gary%20and%20His%20Demons'
    );
  });

  it('ignores any context values the caller tries to supply', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await custom('https://example.com/?q={title}', {
      title: 'Attacker Title',
      canonicalTitle: 'Attacker Title',
      rawTitle: 'Attacker Raw',
      hostname: 'evil.example',
      url: 'https://evil.example/',
    });

    // Everything substituted came from the service's own context authority.
    expect(res.data.resolvedUrl).toBe('https://example.com/?q=Gary%20and%20His%20Demons');
    expect(res.data.resolvedUrl).not.toContain('Attacker');
    expect(res.data.resolvedUrl).not.toContain('evil.example');
  });

  it('refuses when there is no browser context', async () => {
    const res = await custom('https://example.com/?q={title}');
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('no_usable_context');
    expect(launched).toEqual([]);
  });

  it('refuses an empty or non-string template', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    expect((await custom('')).data.error).toBe('empty_template');
    expect((await custom(undefined)).data.error).toBe('empty_template');
    expect((await custom(42)).data.error).toBe('empty_template');
    expect(launched).toEqual([]);
  });

  it('refuses an unknown placeholder and launches nothing', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await custom('https://example.com/?q={foo}');
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('unknown_placeholder');
    expect(launched).toEqual([]);
  });

  it('refuses unsafe schemes and credential-bearing URLs', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    for (const [template, error] of [
      ['javascript:alert({title})', 'unsupported_scheme'],
      ['data:text/html,{title}', 'unsupported_scheme'],
      ['file:///C:/secret.txt', 'unsupported_scheme'],
      ['chrome://extensions', 'unsupported_scheme'],
      ['https://user:pass@example.com/?q={title}', 'credentials_not_allowed'],
    ] as Array<[string, string]>) {
      const res = await custom(template);
      expect(res.statusCode).toBe(400);
      expect(res.data.error).toBe(error);
    }
    expect(launched).toEqual([]);
  });

  it('accepts a static URL with no placeholders', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await custom('https://example.com/dashboard');
    expect(res.data.resolvedUrl).toBe('https://example.com/dashboard');
  });

  it('does not accept GET', async () => {
    contextStore.updateContext(PRIME_VIDEO);
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${testPort}/lookup/custom`,
        { method: 'GET', headers: authed() },
        (r) => resolve(r.statusCode || 500)
      );
      req.on('error', reject);
      req.end();
    });
    expect(res).toBe(404);
  });
});

/**
 * The built-in lookups now run through the shared template resolver. Their
 * destinations must be byte-identical to what shipped before, since the owner
 * has already physically exercised IMDb and the profile binds these UUIDs.
 */
describe('built-in lookup presets are unchanged', () => {
  let tmpSecretFile: string;
  let server: ReturnType<typeof createBridgeServer>;
  let launched: string[] = [];
  const testPort = 17348;

  beforeAll(async () => {
    tmpSecretFile = path.join(os.tmpdir(), `sdb-builtin-${Date.now()}.key`);
    server = createBridgeServer({
      port: testPort,
      host: '127.0.0.1',
      secretStore: new SecretStore(tmpSecretFile),
      launcher: (url: string) => launched.push(url),
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    if (fs.existsSync(tmpSecretFile)) fs.unlinkSync(tmpSecretFile);
  });

  beforeEach(() => {
    contextStore.clear();
    launched = [];
  });

  const post = (pathname: string): Promise<{ statusCode: number; data: any }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${testPort}${pathname}`,
        { method: 'POST' },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ statusCode: res.statusCode || 500, data: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end();
    });

  const expected: Array<[string, string]> = [
    ['imdb', 'https://www.imdb.com/find?q=Gary%20and%20His%20Demons'],
    ['cast', 'https://www.google.com/search?q=Gary%20and%20His%20Demons%20cast'],
    ['justwatch', 'https://www.justwatch.com/us/search?q=Gary%20and%20His%20Demons'],
    ['reddit', 'https://www.reddit.com/search/?q=Gary%20and%20His%20Demons'],
  ];

  for (const [action, url] of expected) {
    it(`${action} still resolves to its established destination`, async () => {
      contextStore.updateContext(PRIME_VIDEO);
      const res = await post(`/lookup/${action}`);

      expect(res.statusCode).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.action).toBe(action);
      expect(res.data.query).toBe('Gary and His Demons');
      expect(res.data.url).toBe(url);
      expect(res.data.launched).toBe(true);
      expect(launched).toEqual([url]);
    });
  }

  it('still reports no_usable_context with an empty store', async () => {
    for (const [action] of expected) {
      const res = await post(`/lookup/${action}`);
      expect(res.statusCode).toBe(400);
      expect(res.data.error).toBe('no_usable_context');
    }
    expect(launched).toEqual([]);
  });

  it('remains unauthenticated, as the installed plugin expects', async () => {
    // The shipped plugin sends no secret on these routes; requiring one would
    // break the keys the owner already has on the deck.
    contextStore.updateContext(PRIME_VIDEO);
    const res = await post('/lookup/imdb');
    expect(res.statusCode).toBe(200);
  });
});
