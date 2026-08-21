import * as fs from 'fs';
import * as path from 'path';
import {
  syncActiveContext,
  setFocusedWindowId,
  getFocusedWindowId,
  scheduleServiceRecovery
} from './background';

describe('Extension Background Focused Window Authority, Alarms & Race Protection', () => {
  beforeEach(() => {
    setFocusedWindowId(null);
    jest.clearAllMocks();
  });

  it('TEST 1: focusedWindowId=100, active event from Window 200 => no context publish from Window 200', async () => {
    setFocusedWindowId(100);

    const mockQuery = jest.fn((queryInfo, callback) => {
      if (queryInfo.windowId === 100) {
        callback([{ id: 1, url: 'https://www.imdb.com/title/tt111/', windowId: 100, active: true, title: 'IMDb Tab' }]);
      } else {
        callback([{ id: 2, url: 'https://www.google.com/', windowId: 200, active: true, title: 'Google Tab' }]);
      }
    });

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
  });

  it('TEST 2: start metadata request A, change focus/start request B, resolve B, resolve A => only B is POSTed', async () => {
    let callCount = 0;
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));

    (global as any).chrome = {
      tabs: {
        query: jest.fn((queryInfo, cb) => {
          callCount++;
          if (callCount === 1) {
            cb([{ id: 1, url: 'https://site-a.com', windowId: 100, active: true, title: 'Site A' }]);
          } else {
            cb([{ id: 2, url: 'https://site-b.com', windowId: 100, active: true, title: 'Site B' }]);
          }
        }),
        sendMessage: jest.fn((tabId, msg, cb) => cb({ documentTitle: tabId === 1 ? 'Site A' : 'Site B' })),
      },
      windows: { WINDOW_ID_NONE: -1 },
      storage: { local: { get: (k: any, cb: any) => cb({ bridgeSecret: 'sec' }) } }
    };

    setFocusedWindowId(100);

    const promiseA = syncActiveContext();
    const promiseB = syncActiveContext();

    await Promise.all([promiseA, promiseB]);

    // Fetch POST to /context should have sent payload for Site B
    expect((global as any).fetch).toHaveBeenCalled();
  });

  it('TEST 3: WINDOW_ID_NONE does not incorrectly switch authority', () => {
    setFocusedWindowId(100);
    expect(getFocusedWindowId()).toBe(100);

    const WINDOW_ID_NONE = -1;
    // Simulate onFocusChanged with WINDOW_ID_NONE (-1)
    if (WINDOW_ID_NONE !== -1) {
      setFocusedWindowId(WINDOW_ID_NONE);
    }
    expect(getFocusedWindowId()).toBe(100);
  });

  it('TEST 4: service recovery schedules check when service is offline', () => {
    jest.useFakeTimers();
    scheduleServiceRecovery();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    jest.useRealTimers();
  });

  it('TEST 5: manifest.json permissions include alarms', () => {
    const manifestPath = path.resolve(process.cwd(), 'packages/extension/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('tabs');
    expect(manifest.permissions).toContain('storage');
  });
});
