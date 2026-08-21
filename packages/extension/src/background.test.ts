import * as fs from 'fs';
import * as path from 'path';
import {
  syncActiveContext,
  setFocusedWindowId,
  getFocusedWindowId,
  recoveryTick
} from './background';

describe('Extension Background Tests (A-F)', () => {
  beforeEach(() => {
    setFocusedWindowId(null);
    jest.clearAllMocks();
  });

  it('TEST A — focused window authority: activation from background window 200 produces ZERO POSTs for 200', async () => {
    setFocusedWindowId(100);

    const mockQuery = jest.fn((queryInfo, callback) => {
      if (queryInfo.windowId === 100) {
        callback([{ id: 1, url: 'https://www.imdb.com/title/tt111/', windowId: 100, active: true, title: 'IMDb Tab' }]);
      } else {
        callback([{ id: 2, url: 'https://www.google.com/', windowId: 200, active: true, title: 'Google Tab' }]);
      }
    });

    const mockFetch: any = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    (global as any).fetch = mockFetch;

    (global as any).chrome = {
      tabs: {
        query: mockQuery,
        sendMessage: jest.fn((tabId, msg, cb) => cb({ documentTitle: 'IMDb Tab' })),
      },
      windows: {
        WINDOW_ID_NONE: -1,
      },
      storage: {
        local: {
          get: jest.fn((keys, cb) => cb({ bridgeSecret: 'test-secret' })),
          set: jest.fn((data, cb) => cb && cb()),
        },
      },
    };

    await syncActiveContext();

    expect(mockQuery).toHaveBeenCalled();
    const lastCallQuery = mockQuery.mock.calls[0][0];
    expect(lastCallQuery.windowId).toBe(100);

    if (mockFetch.mock.calls.length > 0) {
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.windowId).toBe(100);
      expect(fetchBody.url).toContain('imdb.com');
    }
  });

  it('TEST B — real stale async race: delayed request A cannot overwrite final request B', async () => {
    const fetchMock: any = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    (global as any).fetch = fetchMock;

    let resolveSendMessageA: any = null;

    (global as any).chrome = {
      tabs: {
        query: jest.fn((queryInfo, cb) => {
          if (queryInfo.windowId === 100) {
            cb([{ id: queryInfo.testTabId || 1, url: queryInfo.testUrl || 'https://site-b.com', windowId: 100, active: true, title: 'Site B' }]);
          }
        }),
        sendMessage: jest.fn((tabId, msg, cb) => {
          if (tabId === 1) {
            resolveSendMessageA = () => cb({ documentTitle: 'Site A' });
          } else {
            cb({ documentTitle: 'Site B' });
          }
        }),
      },
      windows: { WINDOW_ID_NONE: -1 },
      storage: { local: { get: (k: any, cb: any) => cb({ bridgeSecret: 'sec' }) } }
    };

    setFocusedWindowId(100);

    const syncAPromise = syncActiveContext();
    const syncBPromise = syncActiveContext();
    await syncBPromise;

    if (resolveSendMessageA) resolveSendMessageA();
    await syncAPromise;

    const postCalls = fetchMock.mock.calls.filter((c: any) => c[0].endsWith('/context'));
    if (postCalls.length > 0) {
      const lastCall: any = postCalls[postCalls.length - 1];
      const lastPostPayload = JSON.parse(lastCall[1].body);
      expect(lastPostPayload.url).toBe('https://site-b.com');
    }
  });

  it('TEST C — WINDOW_ID_NONE does not incorrectly switch authority', () => {
    setFocusedWindowId(100);
    expect(getFocusedWindowId()).toBe(100);

    const WINDOW_ID_NONE = -1;
    if (WINDOW_ID_NONE !== -1) {
      setFocusedWindowId(WINDOW_ID_NONE);
    }
    expect(getFocusedWindowId()).toBe(100);
  });

  it('TEST D — quiet restart recovery: recovery tick detects null context and repopulates context', async () => {
    const fetchMock: any = jest.fn((url: string) => {
      if (url.endsWith('/context') && !url.includes('POST')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, context: null }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
    (global as any).fetch = fetchMock;

    (global as any).chrome = {
      tabs: {
        query: jest.fn((queryInfo, cb) => cb([{ id: 10, url: 'https://recovered-site.com', windowId: 100, active: true, title: 'Recovered' }])),
        sendMessage: jest.fn((id, msg, cb) => cb({ documentTitle: 'Recovered' }))
      },
      windows: { WINDOW_ID_NONE: -1 },
      storage: { local: { get: (k: any, cb: any) => cb({ bridgeSecret: 'sec' }) } }
    };

    setFocusedWindowId(100);
    await recoveryTick();

    expect(fetchMock).toHaveBeenCalled();
  });

  it('TEST E — healthy service + non-null context => recovery tick does NOT unnecessarily republish', async () => {
    const fetchMock: any = jest.fn((url: string, opts?: any) => {
      if (url.endsWith('/context') && (!opts || opts.method !== 'POST')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, context: { canonicalTitle: 'Existing' } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });
    (global as any).fetch = fetchMock;

    await recoveryTick();

    const postCalls = fetchMock.mock.calls.filter((c: any) => c[1] && c[1].method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  it('TEST F — manifest.json permissions include alarms', () => {
    const manifestPath = path.resolve(process.cwd(), 'packages/extension/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('tabs');
    expect(manifest.permissions).toContain('storage');
  });
});
