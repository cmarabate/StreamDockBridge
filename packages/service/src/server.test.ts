import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createBridgeServer, isAllowedOrigin } from './server';
import { contextStore } from './contextStore';
import { SecretStore } from './secretStore';

describe('Bridge Server Integration & Security Tests', () => {
  let tmpSecretFile: string;
  let secretStore: SecretStore;
  let bridgeServer: ReturnType<typeof createBridgeServer>;
  let launchedUrls: string[] = [];
  const testPort = 17340;

  beforeAll(async () => {
    tmpSecretFile = path.join(os.tmpdir(), `sdb-test-sec-${Date.now()}.key`);
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
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; data: any }> => {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${testPort}${pathname}`,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode || 500, headers: res.headers, data: JSON.parse(data) });
            } catch (e) {
              resolve({ statusCode: res.statusCode || 500, headers: res.headers, data: data });
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

  it('isAllowedOrigin helper validates chrome-extension and local origins while denying arbitrary web pages', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:17337')).toBe(true);
    expect(isAllowedOrigin('http://localhost:17337')).toBe(true);
    expect(isAllowedOrigin('https://malicious-site.com')).toBe(false);
    expect(isAllowedOrigin('http://evil.org')).toBe(false);
  });

  it('POST /auth/handshake provisions secret for extension origin', async () => {
    const res = await request('POST', '/auth/handshake', { Origin: 'chrome-extension://myextensionid' });
    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.secret).toBe(secretStore.getSecret());
    expect(res.headers['access-control-allow-origin']).toBe('chrome-extension://myextensionid');
  });

  it('Rejects CORS request from unauthorized web page origin', async () => {
    const res = await request('GET', '/context', { Origin: 'https://evil-site.com' });
    expect(res.statusCode).toBe(403);
    expect(res.data.error).toBe('origin_forbidden');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS preflight request from unauthorized web page returns 403', async () => {
    const res = await request('OPTIONS', '/context', { Origin: 'https://evil-site.com' });
    expect(res.statusCode).toBe(403);
  });

  it('POST /context rejects unauthorized updates and safely handles wrong-length tokens', async () => {
    const shortTokenRes = await request('POST', '/context', { 'X-Bridge-Secret': 'short' }, { rawTitle: 'Test' });
    expect(shortTokenRes.statusCode).toBe(401);
    expect(shortTokenRes.data.error).toBe('unauthorized');

    const longTokenRes = await request('POST', '/context', { 'X-Bridge-Secret': 'a'.repeat(200) }, { rawTitle: 'Test' });
    expect(longTokenRes.statusCode).toBe(401);
    expect(longTokenRes.data.error).toBe('unauthorized');
  });

  it('POST /context accepts authorized update from chrome-extension origin', async () => {
    const secret = secretStore.getSecret();
    const res = await request('POST', '/context', {
      Origin: 'chrome-extension://myextensionid',
      'X-Bridge-Secret': secret,
    }, {
      url: 'https://www.crunchyroll.com/series/G123/dandadan',
      rawTitle: 'Dandadan - Watch on Crunchyroll',
      tabId: 1,
      windowId: 1,
      timestamp: 1000,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.record.canonicalTitle).toBe('Dandadan');
  });
});
