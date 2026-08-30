import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createBridgeServer, PINNED_EXTENSION_ORIGIN } from './server';
import { SecretStore } from './secretStore';
import { IconService } from './iconService';
import { IconCache } from './iconCache';
import { FetchedResource, GetOptions } from './iconFetch';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 64]),
  Buffer.alloc(64),
]);
const PAGE = Buffer.from('<!doctype html><html><head></head><body></body></html>');

const PORT = 17421;
let server: ReturnType<typeof createBridgeServer>;
let secret: string;
let tempDir: string;
let fetched: string[] = [];

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-route-'));
  const secretStore = new SecretStore(path.join(tempDir, 'secret.key'));
  secret = secretStore.getSecret();

  const get = async (rawUrl: string, _options: GetOptions = {}): Promise<FetchedResource> => {
    fetched.push(rawUrl);
    const body = rawUrl.endsWith('.ico') ? PNG : PAGE;
    return { status: 200, headers: {}, body, finalUrl: rawUrl, truncated: false };
  };

  server = createBridgeServer({
    port: PORT,
    secretStore,
    launcher: () => undefined,
    iconService: new IconService(new IconCache(null), get),
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  fetched = [];
});

function post(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/icon/site',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
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
    req.write(payload);
    req.end();
  });
}

const authed = (body: unknown, headers: Record<string, string> = {}) =>
  post(body, { 'X-Bridge-Secret': secret, ...headers });

describe('POST /icon/site', () => {
  it('returns the icon for a template it can resolve', async () => {
    const res = await authed({ template: 'https://www.youtube.com/results?q={title}' });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('loaded');
    expect(res.json.hostname).toBe('www.youtube.com');
    expect(res.json.origin).toBe('https://www.youtube.com');
    expect(res.json.mime).toBe('image/png');
    expect(String(res.json.dataUri).startsWith('data:image/png;base64,')).toBe(true);
  });

  it('serves a second key on the same origin from cache, with no fetch', async () => {
    await authed({ template: 'https://www.example-cached.com/a?q={title}' });
    fetched = [];
    const res = await authed({ template: 'https://www.example-cached.com/b?q={title}' });
    expect(res.json.status).toBe('cached');
    expect(fetched).toHaveLength(0);
  });

  it('re-resolves only when refresh is asked for', async () => {
    await authed({ template: 'https://www.example-refresh.com/?q={title}' });
    fetched = [];
    await authed({ template: 'https://www.example-refresh.com/?q={title}', refresh: true });
    expect(fetched.length).toBeGreaterThan(0);
  });

  /** The template is caller-supplied, so this sits behind the same gate as /lookup/custom. */
  it('refuses an unauthenticated request', async () => {
    const res = await post({ template: 'https://www.youtube.com/' });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ success: false, error: 'unauthorized' });
    expect(fetched).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    const res = await post({ template: 'https://www.youtube.com/' }, { 'X-Bridge-Secret': 'nope' });
    expect(res.status).toBe(401);
    expect(fetched).toHaveLength(0);
  });

  it('refuses an origin that is not the pinned extension', async () => {
    const res = await authed({ template: 'https://www.youtube.com/' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(fetched).toHaveLength(0);
  });

  it('accepts the pinned extension origin', async () => {
    const res = await authed(
      { template: 'https://www.youtube.com/' },
      { Origin: PINNED_EXTENSION_ORIGIN }
    );
    expect(res.status).toBe(200);
  });

  /**
   * Opening a local URL from a key stays legal; making the service fetch one
   * does not. The route reports why, and never touches the network.
   */
  it('refuses to fetch local, private or dynamic destinations', async () => {
    const cases: Array<[string, string]> = [
      ['http://localhost:3000/panel', 'local_host'],
      ['http://127.0.0.1/x', 'local_host'],
      ['http://192.168.1.10/x', 'local_host'],
      ['http://169.254.169.254/latest/meta-data/', 'local_host'],
      ['https://{hostname}/search?q={title}', 'dynamic_host'],
      ['javascript:alert(1)', 'unsupported_scheme'],
      ['https://user:pass@example.com/', 'invalid_template'],
    ];
    for (const [template, expected] of cases) {
      const res = await authed({ template });
      expect(res.status).toBe(200);
      expect(res.json.status).toBe(expected);
      expect(res.json.dataUri).toBeUndefined();
    }
    expect(fetched).toHaveLength(0);
  });

  it('rejects a malformed body', async () => {
    const res = await authed({ notATemplate: true });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('empty_template');
  });

  it('rejects a non-string template', async () => {
    const res = await authed({ template: 42 });
    expect(res.status).toBe(400);
  });

  /** The body is buffered in memory and this service is long-running. */
  it('refuses an oversized body instead of buffering it', async () => {
    const res = await authed({ template: 'https://example.com/?q=' + 'x'.repeat(64 * 1024) });
    expect(res.status).toBe(413);
    expect(fetched).toHaveLength(0);
  });

  /** Well under the body cap, but still past the template authority's ceiling. */
  it('refuses a template longer than the template ceiling', async () => {
    const res = await authed({ template: 'https://example.com/?q=' + 'x'.repeat(4000) });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('invalid_template');
    expect(fetched).toHaveLength(0);
  });
});
