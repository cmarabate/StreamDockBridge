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
        session: {
          _data: {} as Record<string, unknown>,
          get: jest.fn(function (this: any, keys, cb) {
            cb(this._data);
          }),
          set: jest.fn(function (this: any, data, cb) {
            Object.assign(this._data, data);
            cb && cb();
          }),
          remove: jest.fn(function (this: any, keys, cb) {
            const all = keys as string | string[];
            const k = Array.isArray(all) ? all : [all];
            for (const key of k) delete this._data[key];
            cb && cb();
          }),
        },
      },
      scripting: {
        executeScript: jest.fn(async () => [{ result: undefined }]),
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

  // TEST G: manifest permissions contain scripting and do NOT contain activeTab
  it('TEST G — manifest assertion: permissions contain scripting and do NOT contain activeTab', () => {
    const manifestPath = path.resolve(__dirname, '../manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.permissions).not.toContain('activeTab');
    expect(manifest.permissions).toEqual(['tabs', 'storage', 'alarms', 'scripting']);
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

  describe('Extension Reload & Content Script Bootstrap Recovery', () => {
    it('isScriptableUrl validates http/https schemes and rejects privileged/restricted URLs', () => {
      expect(bg.isScriptableUrl('https://www.disneyplus.com/play/123')).toBe(true);
      expect(bg.isScriptableUrl('http://127.0.0.1:3000')).toBe(true);
      expect(bg.isScriptableUrl('http://localhost:8080')).toBe(true);

      expect(bg.isScriptableUrl('chrome://settings')).toBe(false);
      expect(bg.isScriptableUrl('brave://settings')).toBe(false);
      expect(bg.isScriptableUrl('edge://extensions')).toBe(false);
      expect(bg.isScriptableUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
      expect(bg.isScriptableUrl('chrome-extension://abcdef/options.html')).toBe(false);
      expect(bg.isScriptableUrl('about:blank')).toBe(false);
      expect(bg.isScriptableUrl('file:///C:/video.mp4')).toBe(false);
      expect(bg.isScriptableUrl('https://chromewebstore.google.com/detail/123')).toBe(false);
      expect(bg.isScriptableUrl('https://chrome.google.com/webstore/detail/123')).toBe(false);
      expect(bg.isScriptableUrl('')).toBe(false);
      expect(bg.isScriptableUrl(undefined)).toBe(false);
      expect(bg.isScriptableUrl(null)).toBe(false);
    });

    it('requestMetadata recovers via chrome.scripting.executeScript when content script was severed', async () => {
      const executeScriptMock = (global as any).chrome.scripting.executeScript as jest.Mock;
      executeScriptMock.mockClear();

      let attempts = 0;
      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        attempts++;
        if (attempts === 1) {
          // First attempt fails (orphaned content script / no receiver)
          (global as any).chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
          cb(undefined);
          (global as any).chrome.runtime.lastError = undefined;
        } else {
          // After programmatic injection, second attempt succeeds
          cb({ documentTitle: 'Regular Show | Disney+', hasVideo: true });
        }
      });

      const meta = await bg.requestMetadata(101, 'https://www.disneyplus.com/play/123');

      expect(executeScriptMock).toHaveBeenCalledTimes(1);
      expect(executeScriptMock).toHaveBeenCalledWith({
        target: { tabId: 101 },
        files: ['dist/content.js'],
      });
      expect(meta).toEqual({
        documentTitle: 'Regular Show | Disney+',
        hasVideo: true,
      });
    });

    it('requestMetadata does NOT execute script on privileged chrome:// or brave:// URLs', async () => {
      const executeScriptMock = (global as any).chrome.scripting.executeScript as jest.Mock;
      executeScriptMock.mockClear();

      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        (global as any).chrome.runtime.lastError = { message: 'No receiver' };
        cb(undefined);
        (global as any).chrome.runtime.lastError = undefined;
      });

      const meta = await bg.requestMetadata(202, 'brave://settings');

      expect(executeScriptMock).not.toHaveBeenCalled();
      expect(meta).toBeNull();
    });

    it('rebuildMediaTabs reacquires media from open tabs after reload and orders by lastAccessed', async () => {
      const executeScriptMock = (global as any).chrome.scripting.executeScript as jest.Mock;
      executeScriptMock.mockClear();

      // Tab query returns 3 open tabs:
      // Tab 101: Media tab, lastAccessed: 1000 (older)
      // Tab 102: Media tab, lastAccessed: 2000 (newer)
      // Tab 103: Privileged brave:// tab
      (global as any).chrome.tabs.query = jest.fn((queryInfo, cb) => {
        cb([
          { id: 101, windowId: 1, active: false, url: 'https://disneyplus.com/play/101', lastAccessed: 1000 },
          { id: 102, windowId: 1, active: false, url: 'https://disneyplus.com/play/102', lastAccessed: 2000 },
          { id: 103, windowId: 1, active: false, url: 'brave://rewards', lastAccessed: 3000 },
        ]);
      });

      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        if (tabId === 101) {
          cb({ documentTitle: 'Old Show | Disney+', hasVideo: true });
        } else if (tabId === 102) {
          cb({ documentTitle: 'Regular Show | Disney+', hasVideo: true });
        } else {
          cb(null);
        }
      });

      bg.getMediaTabs().clear();
      await bg.rebuildMediaTabs(true);

      const mediaTabs = bg.getMediaTabs();
      expect(mediaTabs.size()).toBe(2);
      // Tab 102 had higher lastAccessed (2000 vs 1000), so it was inserted first and is the current media owner!
      expect(mediaTabs.current()?.tabId).toBe(102);
      expect(mediaTabs.current()?.url).toBe('https://disneyplus.com/play/102');
    });

    it('rebuildMediaTabs prioritizes active tab over non-active tabs regardless of lastAccessed', async () => {
      (global as any).chrome.tabs.query = jest.fn((queryInfo, cb) => {
        cb([
          { id: 101, windowId: 1, active: false, url: 'https://disneyplus.com/play/101', lastAccessed: 5000 },
          { id: 102, windowId: 1, active: true, url: 'https://disneyplus.com/play/102', lastAccessed: 1000 },
        ]);
      });

      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        if (tabId === 101) {
          cb({ documentTitle: 'Background Show', hasVideo: true });
        } else if (tabId === 102) {
          cb({ documentTitle: 'Active Show', hasVideo: true });
        } else {
          cb(null);
        }
      });

      bg.getMediaTabs().clear();
      await bg.rebuildMediaTabs(true);

      const mediaTabs = bg.getMediaTabs();
      expect(mediaTabs.current()?.tabId).toBe(102);
    });

    it('autoRebuildOnStartup in MEDIA_BROWSER mode automatically publishes media context to service', async () => {
      // Mock storage for MEDIA_BROWSER role
      (global as any).chrome.storage.local.get = jest.fn((keys, cb) => {
        cb({
          browserInstanceId: 'test-media-browser-id',
          browserFamily: 'brave',
          displayName: 'Brave Media',
          mode: 'MEDIA_BROWSER',
          connectionGeneration: 1,
        });
      });

      (global as any).chrome.tabs.query = jest.fn((queryInfo, cb) => {
        cb([
          { id: 101, windowId: 1, active: true, url: 'https://disneyplus.com/play/regular-show', title: 'Regular Show | Disney+' },
        ]);
      });

      (global as any).chrome.tabs.get = jest.fn((tabId, cb) => {
        cb({ id: 101, windowId: 1, active: true, url: 'https://disneyplus.com/play/regular-show', title: 'Regular Show | Disney+' });
      });

      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        cb({ documentTitle: 'Regular Show | Disney+', jsonLdTitle: 'Regular Show', hasVideo: true });
      });

      mockFetch.mockClear();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, secret: 'test-secret' }),
      });

      bg.getMediaTabs().clear();
      bg.invalidateRole();

      await bg.autoRebuildOnStartup();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:17337/context',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Regular Show'),
        })
      );
    });

    it('handles tab closing or navigating during bootstrap gracefully', async () => {
      const executeScriptMock = (global as any).chrome.scripting.executeScript as jest.Mock;
      executeScriptMock.mockRejectedValueOnce(new Error('No tab with id: 999'));

      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        (global as any).chrome.runtime.lastError = { message: 'Receiving end does not exist' };
        cb(undefined);
        (global as any).chrome.runtime.lastError = undefined;
      });

      const meta = await bg.requestMetadata(999, 'https://disneyplus.com/play/999');
      expect(meta).toBeNull();
    });

    it('service worker restart without extension reload uses direct messaging without executeScript', async () => {
      const executeScriptMock = (global as any).chrome.scripting.executeScript as jest.Mock;
      executeScriptMock.mockClear();

      (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
        cb({ documentTitle: 'Existing Live Content Script', hasVideo: true });
      });

      const meta = await bg.requestMetadata(101, 'https://disneyplus.com/play/101');
      expect(executeScriptMock).not.toHaveBeenCalled();
      expect(meta).toEqual({
        documentTitle: 'Existing Live Content Script',
        hasVideo: true,
      });
    });
  });
});

describe('Voice session survival & playback publication', () => {
  let mockFetch: jest.Mock;
  let activeBg: typeof import('./background');
  let workerA: typeof import('./background');
  let workerB: typeof import('./background');

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.resetModules();
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    (global as any).chrome = {
      windows: {
        WINDOW_ID_NONE: -1,
        getLastFocused: jest.fn(() => {}),
        getAll: jest.fn(() => {}),
        onFocusChanged: { addListener: jest.fn() },
      },
      tabs: {
        get: jest.fn((tabId, cb) => cb({ id: tabId, windowId: 1, active: true })),
        sendMessage: jest.fn((tabId, msg, cb) => cb({})),
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() },
        onCreated: { addListener: jest.fn() },
      },
      runtime: {
        lastError: undefined,
        sendMessage: jest.fn(),
        onStartup: { addListener: jest.fn() },
        onInstalled: { addListener: jest.fn() },
        onMessage: { addListener: jest.fn() },
      },
      storage: {
        local: {
          get: jest.fn((keys, cb) => cb({})),
          set: jest.fn((data, cb) => cb && cb()),
          remove: jest.fn((keys, cb) => cb && cb()),
        },
        session: {
          _data: {} as Record<string, unknown>,
          get: jest.fn(function (this: any, keys, cb) {
            cb(this._data);
          }),
          set: jest.fn(function (this: any, data, cb) {
            Object.assign(this._data, data);
            cb && cb();
          }),
          remove: jest.fn(function (this: any, keys, cb) {
            const all = keys as string | string[];
            const k = Array.isArray(all) ? all : [all];
            for (const key of k) delete this._data[key];
            cb && cb();
          }),
        },
      },
      scripting: { executeScript: jest.fn(async () => [{ result: undefined }]) },
      alarms: {
        create: jest.fn(),
        onAlarm: { addListener: jest.fn() },
      },
    };
  });

  it('keeps an in-flight voice session through an MV3 worker restart so END is not dropped', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret' }),
    });

    // First worker lifetime: START persists the tab→session mapping.
    workerA = require('./background');
    workerA.clearCachedSecret();
    await workerA.handleVoiceLifecycleMessage(
      { event: 'VOICE_INPUT_STARTED' },
      { tab: { id: 42 } } as any
    );
    await flush();

    // Simulate worker suspension by discarding the module AND its in-memory maps.
    jest.resetModules();
    // Session storage survives (it lives in the browser, not the worker).

    // Second worker lifetime: fresh in-memory state, hydrated from session storage.
    workerB = require('./background');
    workerB.clearCachedSecret();

    // END must now resolve to the persisted session and POST to the service.
    mockFetch.mockClear();
    await workerB.handleVoiceLifecycleMessage(
      { event: 'VOICE_INPUT_ENDED' },
      { tab: { id: 42 } } as any
    );
    await flush();

    const lifecycleCall = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes('/voice/lifecycle')
    );
    expect(lifecycleCall).toBeTruthy();
    const posted = JSON.parse(lifecycleCall[1].body);
    expect(posted.event).toBe('VOICE_INPUT_ENDED');
    expect(posted.sessionId).toContain('voice-');
    expect(posted.tabId).toBe(42);
  });

  it('republishes Media context when the owner tab reports a playback change', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret' }),
    });

    activeBg = require('./background');
    activeBg.clearCachedSecret();
    const mediaTabs = activeBg.getMediaTabs();
    mediaTabs.clear();
    // Directly seed the tracker as if the media browser had bootstrap'd this tab.
    mediaTabs.noteActivated(7, 1, 'https://www.disneyplus.com/play/x', true, false);

    // The owner content script answers the metadata probe to confirm it is playing.
    (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
      cb({ hasVideo: true, isPlaying: true });
    });
    // The agent play event also raced ahead; keep the tracker authoritative.
    mediaTabs.notePlayback(7, true);

    mockFetch.mockClear();
    await activeBg.handleMediaPlaybackChangedMessage(
      { isPlaying: true, documentGeneration: 'doc-7' },
      { tab: { id: 7 } } as any
    );
    await flush();

    const publishCall = mockFetch.mock.calls.find((call) =>
      String(call[0]) === 'http://127.0.0.1:17337/context'
    );
    expect(publishCall).toBeTruthy();
    const envelope = JSON.parse(publishCall[1].body);
    expect(envelope.channel).toBe('media');
    expect(envelope.playbackState).toBe('playing');
    expect(envelope.tabId).toBe(7);
  });

  it('does not republish for a non-owner tab reporting a playback change', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret' }),
    });

    activeBg = require('./background');
    activeBg.clearCachedSecret();
    const mediaTabs = activeBg.getMediaTabs();
    mediaTabs.clear();
    mediaTabs.noteActivated(7, 1, 'https://www.disneyplus.com/play/x', true, false);

    mockFetch.mockClear();
    await activeBg.handleMediaPlaybackChangedMessage(
      { isPlaying: true, documentGeneration: 'doc-8' },
      { tab: { id: 8 } } as any
    );
    await flush();

    const publishCall = mockFetch.mock.calls.find((call) =>
      String(call[0]) === 'http://127.0.0.1:17337/context'
    );
    expect(publishCall).toBeUndefined();
  });

  it('retries one acknowledgement with the exact same identity and mutates media once', async () => {
    activeBg = require('./background');
    const role = await activeBg.getRole();
    activeBg.clearCachedSecret();

    const command = {
      commandId: 'cmd-retry-1',
      leaseId: 'lease-retry-1',
      browserInstanceId: role.browserInstanceId,
      connectionGeneration: role.connectionGeneration,
      tabId: 7,
      windowId: 1,
      mediaUrl: 'https://www.disneyplus.com/play/x',
      action: 'PAUSE',
      expectedDocumentGeneration: 'doc-7',
      expiresAt: Date.now() + 10_000,
    };

    (global as any).chrome.tabs.get = jest.fn((tabId, cb) =>
      cb({ id: tabId, windowId: 1, url: command.mediaUrl })
    );
    (global as any).chrome.tabs.sendMessage = jest.fn((tabId, message, cb) =>
      cb({
        commandId: message.commandId,
        action: message.command,
        outcome: 'CHANGED',
        initialPlayback: 'playing',
        finalPlayback: 'paused',
        documentGeneration: 'doc-7',
        mediaTargetId: 'media-7',
      })
    );

    let acknowledgementAttempts = 0;
    mockFetch.mockImplementation(async (url: string) => {
      const value = String(url);
      if (value.includes('/auth/handshake')) {
        return { ok: true, json: async () => ({ success: true, secret: 'test-secret' }) };
      }
      if (value.includes('/media/commands?')) {
        return { ok: true, json: async () => ({ success: true, commands: [command] }) };
      }
      if (value.includes('/media/commands/validate')) {
        return { ok: true, json: async () => ({ success: true, executable: true }) };
      }
      if (value.includes('/media/commands/ack')) {
        acknowledgementAttempts += 1;
        return { ok: acknowledgementAttempts > 1, json: async () => ({ success: true }) };
      }
      return { ok: true, json: async () => ({ success: true }) };
    });

    await activeBg.pollMediaCommands();

    expect((global as any).chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    const acknowledgementCalls = mockFetch.mock.calls.filter((call) =>
      String(call[0]).includes('/media/commands/ack')
    );
    expect(acknowledgementCalls).toHaveLength(2);
    expect(acknowledgementCalls[0][1].body).toBe(acknowledgementCalls[1][1].body);
  });
});
