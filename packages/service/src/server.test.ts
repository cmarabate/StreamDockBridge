import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createBridgeServer, isAllowedOrigin, ALLOWED_EXTENSION_ORIGIN } from './server';
import { contextStore } from './contextStore';
import { SecretStore } from './secretStore';

describe('Bridge Server Pinned Origin & Security Tests', () => {
  let tmpSecretFile: string;
  let secretStore: SecretStore;
  let bridgeServer: ReturnType<typeof createBridgeServer>;
  let launchedUrls: string[] = [];
  const testPort = 17345;

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

  it('isAllowedOrigin validates pinned extension origin and denies unpinned origins', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin(ALLOWED_EXTENSION_ORIGIN)).toBe(true);
    expect(isAllowedOrigin('chrome-extension://unpinnedextensionid')).toBe(false);
    expect(isAllowedOrigin('http://localhost:8080')).toBe(false);
    expect(isAllowedOrigin('https://malicious-site.com')).toBe(false);
  });

  it('POST /auth/handshake provisions secret ONLY for pinned extension origin', async () => {
    const res = await request('POST', '/auth/handshake', { Origin: ALLOWED_EXTENSION_ORIGIN });
    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.secret).toBe(secretStore.getSecret());

    const rejectedRes = await request('POST', '/auth/handshake', { Origin: 'chrome-extension://wrongid' });
    expect(rejectedRes.statusCode).toBe(403);
    expect(rejectedRes.data.error).toBe('origin_forbidden');
  });

  it('Rejects CORS request from unauthorized web page origin', async () => {
    const res = await request('GET', '/context', { Origin: 'https://evil-site.com' });
    expect(res.statusCode).toBe(403);
    expect(res.data.error).toBe('origin_forbidden');
  });

  it('POST /context accepts authorized update from pinned extension origin', async () => {
    const secret = secretStore.getSecret();
    const res = await request('POST', '/context', {
      Origin: ALLOWED_EXTENSION_ORIGIN,
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
