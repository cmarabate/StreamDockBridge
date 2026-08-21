import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createBridgeServer } from './server';
import { contextStore } from './contextStore';
import { SecretStore } from './secretStore';

describe('Bridge Server Integration Tests', () => {
  let tmpSecretFile: string;
  let secretStore: SecretStore;
  let bridgeServer: ReturnType<typeof createBridgeServer>;
  let launchedUrls: string[] = [];
  const testPort = 17338;

  beforeAll(async () => {
    tmpSecretFile = path.join(os.tmpdir(), `sdb-test-secret-${Date.now()}.key`);
    secretStore = new SecretStore(tmpSecretFile);

    const mockLauncher = async (url: string) => {
      launchedUrls.push(url);
      return true;
    };

    bridgeServer = createBridgeServer({
      port: testPort,
      host: '127.0.0.1',
      secretStore,
      launcher: mockLauncher,
    });

    await bridgeServer.start();
  });

  afterAll(async () => {
    await bridgeServer.stop();
    if (fs.existsSync(tmpSecretFile)) {
      fs.unlinkSync(tmpSecretFile);
    }
  });

  beforeEach(() => {
    contextStore.clear();
    launchedUrls = [];
  });

  const request = (
    method: string,
    pathname: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ statusCode: number; data: any }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${testPort}${pathname}`,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode || 500, data: JSON.parse(data) });
            } catch (e) {
              resolve({ statusCode: res.statusCode || 500, data: data });
            }
          });
        }
      );
      req.on('error', reject);
      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  };

  it('GET /health returns status ok', async () => {
    const res = await request('GET', '/health');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ status: 'ok', service: 'StreamDockBridge' });
  });

  it('POST /context rejects unauthorized context updates', async () => {
    const res = await request('POST', '/context', {}, { rawTitle: 'Fake Title' });
    expect(res.statusCode).toBe(401);
    expect(res.data.success).toBe(false);
    expect(res.data.error).toBe('unauthorized');
  });

  it('POST /context accepts authorized context updates and calculates canonical title', async () => {
    const secret = secretStore.getSecret();
    const res = await request('POST', '/context', { 'X-Bridge-Secret': secret }, {
      url: 'https://www.crunchyroll.com/series/G123/dandadan',
      hostname: 'www.crunchyroll.com',
      rawTitle: 'Dandadan - Watch on Crunchyroll',
      ogTitle: 'Dandadan - Watch on Crunchyroll',
      jsonLdTitle: 'Dandadan',
      tabId: 10,
      windowId: 1,
      timestamp: 1000,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.record.canonicalTitle).toBe('Dandadan');
    expect(contextStore.getContext()?.canonicalTitle).toBe('Dandadan');
  });

  it('POST /context rejects out-of-order stale updates', async () => {
    const secret = secretStore.getSecret();
    await request('POST', '/context', { 'X-Bridge-Secret': secret }, {
      rawTitle: 'Newer Tab',
      timestamp: 2000,
    });
    const staleRes = await request('POST', '/context', { 'X-Bridge-Secret': secret }, {
      rawTitle: 'Older Tab',
      timestamp: 1000,
    });

    expect(staleRes.data.updated).toBe(false);
    expect(contextStore.getContext()?.rawTitle).toBe('Newer Tab');
  });

  it('Action endpoints return structured error when no context exists', async () => {
    const actions = ['imdb', 'cast', 'justwatch', 'reddit'];
    for (const act of actions) {
      const res = await request('POST', `/lookup/${act}`);
      expect(res.statusCode).toBe(400);
      expect(res.data).toEqual({ success: false, error: 'no_usable_context' });
      expect(launchedUrls.length).toBe(0);
    }
  });

  it('GET on action endpoints returns 405 Method Not Allowed', async () => {
    const res = await request('GET', '/lookup/imdb');
    expect(res.statusCode).toBe(405);
    expect(res.data).toEqual({ success: false, error: 'method_not_allowed' });
  });

  it('Action endpoints correctly encode queries and launch browser', async () => {
    const secret = secretStore.getSecret();
    await request('POST', '/context', { 'X-Bridge-Secret': secret }, {
      rawTitle: 'Dandadan (TV Series 2024– ) - IMDb',
      timestamp: 5000,
    });

    // IMDb
    let res = await request('POST', '/lookup/imdb');
    expect(res.statusCode).toBe(200);
    expect(res.data.query).toBe('Dandadan');
    expect(launchedUrls[0]).toBe('https://www.imdb.com/find/?q=Dandadan');

    // Cast
    res = await request('POST', '/lookup/cast');
    expect(res.statusCode).toBe(200);
    expect(launchedUrls[1]).toBe('https://www.google.com/search?q=Dandadan%20cast');

    // JustWatch
    res = await request('POST', '/lookup/justwatch');
    expect(res.statusCode).toBe(200);
    expect(launchedUrls[2]).toBe('https://www.justwatch.com/us/search?q=Dandadan');

    // Reddit
    res = await request('POST', '/lookup/reddit');
    expect(res.statusCode).toBe(200);
    expect(launchedUrls[3]).toBe('https://www.reddit.com/search/?q=Dandadan');
  });
});
