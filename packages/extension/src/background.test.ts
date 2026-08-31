import * as fs from 'fs';
import * as path from 'path';

// background.ts registers its chrome event listeners synchronously at module
// top-level (required for MV3 service workers to wake reliably on events).
// That means the listeners bind to whichever `chrome` mock exists at require
// time, so each test must reset the module registry and re-require the
// module against a fresh mock rather than importing the module once.
let bg: typeof import('./background');

describe('Extension Background Unit Tests (Single Authority Rules A-G)', () => {
  let mockFetch: jest.Mock;
  let windowsGetAllCallback: (windows: any[]) => void;
  let lastFocusedCallback: (win: any) => void;
  let onFocusChangedCallback: (winId: number) => void;
  let onActivatedCallback: (activeInfo: any) => void;
  let onUpdatedCallback: (tabId: number, changeInfo: any, tab: any) => void;

  const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.resetModules();

    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;

    (global as any).chrome = {
      windows: {
        WINDOW_ID_NONE: -1,
        getLastFocused: jest.fn((opts, cb) => {
          lastFocusedCallback = cb;
        }),
        getAll: jest.fn((opts, cb) => {
          windowsGetAllCallback = cb;
        }),
        onFocusChanged: {
          addListener: jest.fn((cb) => {
            onFocusChangedCallback = cb;
          }),
        },
      },
      tabs: {
        sendMessage: jest.fn((tabId, msg, cb) => {
          cb({ documentTitle: 'Test Page Title' });
        }),
        onActivated: {
          addListener: jest.fn((cb) => {
            onActivatedCallback = cb;
          }),
        },
        onUpdated: {
          addListener: jest.fn((cb) => {
            onUpdatedCallback = cb;
          }),
        },
        onCreated: {
          addListener: jest.fn(),
        },
      },
      runtime: {
        lastError: undefined,
        sendMessage: jest.fn(),
        onStartup: {
          addListener: jest.fn(),
        },
        onInstalled: {
          addListener: jest.fn(),
        },
        onMessage: {
          addListener: jest.fn(),
        },
      },
      storage: {
        local: {
          get: jest.fn((keys, cb) => cb({})),
          set: jest.fn((data, cb) => cb && cb()),
          remove: jest.fn((keys, cb) => cb && cb()),
        },
      },
      alarms: {
        create: jest.fn(),
        onAlarm: {
          addListener: jest.fn(),
        },
      },
    };

    bg = require('./background');
    bg.clearCachedSecret();
    bg.setFocusedWindowId(null);
  });

  // TEST A: focusedWindowId = 100, active tab from window 200 => no publish
  it('TEST A — background window event: active tab from window 200 produces ZERO POSTs while window 100 is focused', async () => {
    bg.initExtension();
    lastFocusedCallback({ id: 100 });
    expect(bg.getFocusedWindowId()).toBe(100);

    onActivatedCallback({ tabId: 2, windowId: 200 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(bg.getFocusedWindowId()).toBe(100);
  });

  // TEST B: background window 200 onUpdated event => no publish, focusedWindowId remains 100
  it('TEST B — background window 200 onUpdated event produces NO publish and does NOT steal authority', async () => {
    bg.initExtension();
    lastFocusedCallback({ id: 100 });
    expect(bg.getFocusedWindowId()).toBe(100);

    onUpdatedCallback(5, { status: 'complete' }, { active: true, windowId: 200, url: 'http://example.com/bg' });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(bg.getFocusedWindowId()).toBe(100);
  });

  // TEST C: content-script metadata reply cannot change authority & PAGE_CONTEXT_UPDATE is not handled
  it('TEST C — content-script metadata reply cannot change authority & PAGE_CONTEXT_UPDATE is absent', async () => {
    bg.initExtension();
    lastFocusedCallback({ id: 100 });
    expect(bg.getFocusedWindowId()).toBe(100);

    /**
     * The worker does listen for runtime messages now — the options page tells
     * it the role changed. What must remain impossible is a CONTENT SCRIPT
     * reaching context authority, so the listener ignores anything with a
     * sender.tab, and ignores every action but its own.
     */
    const onMessageCalls = (global as any).chrome.runtime.onMessage.addListener.mock.calls;
    expect(onMessageCalls.length).toBe(1);
    const handler = onMessageCalls[0][0];

    const before = bg.getFocusedWindowId();
    const postsBefore = mockFetch.mock.calls.length;

    // A content script is identified by sender.tab and is refused outright.
    handler({ action: 'ROLE_CHANGED' }, { tab: { id: 5 } });
    handler({ action: 'PAGE_CONTEXT_UPDATE', url: 'https://evil.example' }, { tab: { id: 5 } });
    // And an unknown action from anywhere does nothing either.
    handler({ action: 'PAGE_CONTEXT_UPDATE', url: 'https://evil.example' }, {});

    expect(bg.getFocusedWindowId()).toBe(before);
    expect(mockFetch.mock.calls.length).toBe(postsBefore);
  });

  // TEST D: focused window change 100 -> 200 => only then does window 200 become authoritative
  it('TEST D — focused window change 100 -> 200: only window focus event switches authority', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret-123' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    bg.initExtension();
    lastFocusedCallback({ id: 100 });

    windowsGetAllCallback([
      {
        id: 100,
        focused: true,
        tabs: [{ id: 1, windowId: 100, active: true, title: 'Window 100 Page', url: 'http://example.com/page1' }],
      },
    ]);

    await flushPromises();
    await flushPromises();

    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    onFocusChangedCallback(200);

    windowsGetAllCallback([
      {
        id: 200,
        focused: true,
        tabs: [{ id: 2, windowId: 200, active: true, title: 'Window 200 Page', url: 'http://example.com/page2' }],
      },
    ]);

    await flushPromises();
    await flushPromises();

    expect(bg.getFocusedWindowId()).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Window 200 Page'),
      })
    );
  });

  // TEST E: WINDOW_ID_NONE (-1) preserves previous focused window authority
  it('TEST E — WINDOW_ID_NONE: focus change event with -1 preserves previous focused window authority', async () => {
    bg.initExtension();
    lastFocusedCallback({ id: 100 });
    expect(bg.getFocusedWindowId()).toBe(100);

    onFocusChangedCallback(-1);

    expect(bg.getFocusedWindowId()).toBe(100);
    expect(bg.isFocusedWindow(100)).toBe(true);
  });

  // TEST F: stale async A/B => exactly one B POST
  it('TEST F — stale async guard: stale older async metadata payload does NOT overwrite newer payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    bg.setFocusedWindowId(100);

    let resolveSlowSendMessage: (val: any) => void;
    (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
      if (tabId === 1) {
        resolveSlowSendMessage = cb;
      } else {
        cb({ documentTitle: 'Fast Page Title' });
      }
    });

    bg.syncActiveContext();
    const slowGetAllCb = windowsGetAllCallback;

    bg.syncActiveContext();
    const fastGetAllCb = windowsGetAllCallback;

    fastGetAllCb([
      {
        id: 100,
        focused: true,
        tabs: [{ id: 2, windowId: 100, active: true, title: 'Fast Tab', url: 'http://example.com/fast' }],
      },
    ]);

    await flushPromises();
    await flushPromises();

    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    slowGetAllCb([
      {
        id: 100,
        focused: true,
        tabs: [{ id: 1, windowId: 100, active: true, title: 'Slow Tab', url: 'http://example.com/slow' }],
      },
    ]);

    resolveSlowSendMessage!({ documentTitle: 'Slow Page Title' });

    await flushPromises();
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({
        body: expect.stringContaining('Slow Tab'),
      })
    );
  });

  // TEST G: manifest permissions do NOT contain activeTab
  it('TEST G — manifest assertion: permissions do NOT contain activeTab', () => {
    const manifestPath = path.resolve(__dirname, '../manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.permissions).not.toContain('activeTab');
    expect(manifest.permissions).toEqual(['tabs', 'storage', 'alarms']);
  });

  // TEST H: recoveryTick with null context republishes via the focused tab
  it('TEST H — recoveryTick: null context triggers focused-tab republish', async () => {
    bg.setFocusedWindowId(100);
    const getAllMock = (global as any).chrome.windows.getAll as jest.Mock;
    getAllMock.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, context: null }),
    });

    await bg.recoveryTick();

    expect(getAllMock).toHaveBeenCalledTimes(1);
  });

  // TEST I: recoveryTick with an existing context is a no-op
  it('TEST I — recoveryTick: existing context is a no-op (no republish)', async () => {
    bg.setFocusedWindowId(100);
    const getAllMock = (global as any).chrome.windows.getAll as jest.Mock;
    getAllMock.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, context: { canonicalTitle: 'Existing Show' } }),
    });

    await bg.recoveryTick();

    expect(getAllMock).not.toHaveBeenCalled();
  });
});
