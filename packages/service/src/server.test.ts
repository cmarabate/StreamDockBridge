import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createBridgeServer,
  isAllowedOrigin,
  ALLOWED_EXTENSION_ORIGIN,
  voiceCoordinator,
} from './server';
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
    voiceCoordinator.clear();
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

  it('correlates a real media command ACK before authorizing RESUME', async () => {
    const secret = secretStore.getSecret();
    const headers = {
      Origin: ALLOWED_EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
      'X-Bridge-Secret': secret,
    };
    const brave = {
      browserInstanceId: 'brave-media',
      browserFamily: 'brave',
      displayName: 'Brave',
      mode: 'MEDIA_BROWSER',
      connectionGeneration: 3,
    };
    const chrome = {
      browserInstanceId: 'chrome-work',
      browserFamily: 'chrome',
      displayName: 'Chrome',
      mode: 'WORK_BROWSER',
      connectionGeneration: 8,
    };

    expect(
      (
        await request('POST', '/context', headers, {
          source: brave,
          channel: 'media',
          observationSequence: 1,
          timestamp: Date.now(),
          url: 'https://example.test/show',
          hostname: 'example.test',
          rawTitle: 'Test Show',
          documentTitle: 'Test Show',
          playbackState: 'playing',
          documentGeneration: 'doc-live',
          tabId: 12,
          windowId: 2,
        })
      ).statusCode
    ).toBe(200);

    const start = await request('POST', '/voice/lifecycle', headers, {
      event: 'VOICE_INPUT_STARTED',
      source: chrome,
      tabId: 99,
      sessionId: 'voice-live',
      provider: 'chatgpt',
    });
    expect(start.data.actionTaken).toBe('voice_started_pause_pending');

    const pending = await request(
      'GET',
      '/media/commands?browserInstanceId=brave-media',
      headers
    );
    const pause = pending.data.commands[0];
    expect(pause).toMatchObject({ action: 'PAUSE', connectionGeneration: 3, tabId: 12 });

    const ack = await request('POST', '/media/commands/ack', headers, {
      commandId: pause.commandId,
      browserInstanceId: 'brave-media',
      connectionGeneration: 3,
      tabId: 12,
      action: 'PAUSE',
      outcome: 'CHANGED',
      initialPlayback: 'playing',
      finalPlayback: 'paused',
      documentGeneration: 'doc-live',
      mediaTargetId: 'media-live',
    });
    expect(ack.data.actionTaken).toBe('pause_ack_changed_resume_authorized');

    const status = await request('GET', '/voice/status', headers);
    expect(status.data.mediaAutoPause).toMatchObject({
      didPause: true,
      resumeAuthorized: true,
      initialPlayback: 'playing',
    });

    const end = await request('POST', '/voice/lifecycle', headers, {
      event: 'VOICE_INPUT_ENDED',
      source: chrome,
      tabId: 99,
      sessionId: 'voice-live',
      provider: 'chatgpt',
    });
    expect(end.data.actionTaken).toBe('voice_ended_media_resume_queued');
    const resume = await request(
      'GET',
      '/media/commands?browserInstanceId=brave-media',
      headers
    );
    expect(resume.data.commands[0]).toMatchObject({
      action: 'RESUME',
      expectedDocumentGeneration: 'doc-live',
      expectedMediaTargetId: 'media-live',
    });
  });

  it('keeps command acknowledgement authenticated and typed', async () => {
    const unauthorized = await request('POST', '/media/commands/ack', {
      Origin: ALLOWED_EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
    }, {});
    expect(unauthorized.statusCode).toBe(401);

    const invalid = await request('POST', '/media/commands/ack', {
      Origin: ALLOWED_EXTENSION_ORIGIN,
      'Content-Type': 'application/json',
      'X-Bridge-Secret': secretStore.getSecret(),
    }, { commandId: 'missing-fields' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.data.error).toBe('invalid_media_command_ack');
  });
});
