import { PageMetadata } from './metadata';

const SERVICE_URL = 'http://127.0.0.1:17337';
let cachedSecret: string | null = null;
let latestSequenceId = 0;
let focusedWindowId: number | null = null;
let isServiceOffline = false;

export function getFocusedWindowId(): number | null {
  return focusedWindowId;
}

export function setFocusedWindowId(windowId: number | null) {
  focusedWindowId = windowId;
}

export async function getSecret(): Promise<string | null> {
  if (cachedSecret) return cachedSecret;

  const storageData = await new Promise<{ bridgeSecret?: string }>((resolve) => {
    chrome.storage.local.get(['bridgeSecret'], (res) => resolve(res || {}));
  });

  if (storageData.bridgeSecret) {
    cachedSecret = storageData.bridgeSecret;
    return cachedSecret;
  }

  try {
    const res = await fetch(`${SERVICE_URL}/auth/handshake`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.secret) {
        cachedSecret = data.secret;
        await new Promise<void>((resolve) => chrome.storage.local.set({ bridgeSecret: data.secret }, () => resolve()));
        return cachedSecret;
      }
    }
  } catch (e) {
    // Handshake failed
  }

  return null;
}

export async function syncActiveContext() {
  const currentSequence = ++latestSequenceId;

  // Query active tab for the focused window authority
  const queryInfo: chrome.tabs.QueryInfo = { active: true };
  if (focusedWindowId !== null && typeof chrome !== 'undefined' && chrome.windows && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
    queryInfo.windowId = focusedWindowId;
  } else {
    queryInfo.lastFocusedWindow = true;
  }

  chrome.tabs.query(queryInfo, async (tabs) => {
    if (!tabs || tabs.length === 0) return;

    let targetTab: chrome.tabs.Tab | null = null;
    for (const tab of tabs) {
      if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
        targetTab = tab;
        break;
      }
    }

    if (!targetTab) {
      targetTab = tabs[0];
    }

    if (!targetTab || !targetTab.id || !targetTab.url) return;
    const tabId = targetTab.id;
    const tabUrl: string = targetTab.url;
    const tabWindowId = targetTab.windowId;

    // Check authority: If target tab belongs to a non-focused window, drop it
    if (typeof chrome !== 'undefined' && chrome.windows && focusedWindowId !== null && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      if (tabWindowId !== focusedWindowId) {
        return;
      }
    }

    let meta: PageMetadata = { documentTitle: targetTab.title || '' };

    if (tabUrl.startsWith('http://') || tabUrl.startsWith('https://')) {
      try {
        meta = await new Promise<PageMetadata>((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'GET_METADATA' }, (response) => {
            if (chrome.runtime.lastError || !response) {
              resolve({ documentTitle: targetTab?.title || '' });
            } else {
              resolve(response);
            }
          });
        });
      } catch (e) {
        meta = { documentTitle: targetTab.title || '' };
      }
    }

    // RACE & FOCUS PROTECTION: Drop stale results if sequence ID changed or window focus changed
    if (currentSequence !== latestSequenceId) {
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.windows && focusedWindowId !== null && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      if (tabWindowId !== focusedWindowId) {
        return;
      }
    }

    let hostname = '';
    try {
      hostname = new URL(tabUrl).hostname || '';
    } catch (e) {
      // Invalid URL scheme
    }

    const payload = {
      url: tabUrl,
      hostname,
      rawTitle: targetTab.title || '',
      documentTitle: meta.documentTitle,
      ogTitle: meta.ogTitle,
      twitterTitle: meta.twitterTitle,
      jsonLdTitle: meta.jsonLdTitle,
      tabId: tabId,
      windowId: tabWindowId,
      timestamp: Date.now(),
    };

    const secret = await getSecret();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers['X-Bridge-Secret'] = secret;
    }

    try {
      const res = await fetch(`${SERVICE_URL}/context`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        isServiceOffline = false;
      } else {
        isServiceOffline = true;
      }
    } catch (e) {
      isServiceOffline = true;
      // Schedule lightweight recovery check when service is offline
      scheduleServiceRecovery();
    }
  });
}

let recoveryTimeout: any = null;
export function scheduleServiceRecovery() {
  if (recoveryTimeout) return;
  recoveryTimeout = setTimeout(async () => {
    recoveryTimeout = null;
    try {
      const res = await fetch(`${SERVICE_URL}/health`);
      if (res.ok) {
        isServiceOffline = false;
        syncActiveContext();
      } else if (isServiceOffline) {
        scheduleServiceRecovery();
      }
    } catch (e) {
      if (isServiceOffline) {
        scheduleServiceRecovery();
      }
    }
  }, 3000);
}

export function initExtension() {
  if (typeof chrome !== 'undefined' && chrome.windows) {
    chrome.windows.getLastFocused({ populate: false }, (win) => {
      if (win && win.id !== undefined && win.id !== chrome.windows.WINDOW_ID_NONE) {
        focusedWindowId = win.id;
      }
      syncActiveContext();
    });

    chrome.windows.onFocusChanged.addListener((windowId) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        focusedWindowId = windowId;
        syncActiveContext();
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      if (focusedWindowId === null || activeInfo.windowId === focusedWindowId) {
        syncActiveContext();
      }
    });

    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (tab.active && (focusedWindowId === null || tab.windowId === focusedWindowId)) {
        if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
          syncActiveContext();
        }
      }
    });

    chrome.tabs.onCreated.addListener(() => syncActiveContext());
    chrome.runtime.onStartup.addListener(() => syncActiveContext());
    chrome.runtime.onInstalled.addListener(() => syncActiveContext());
  }

  if (typeof chrome !== 'undefined' && chrome.alarms) {
    chrome.alarms.create('service_recovery_alarm', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'service_recovery_alarm' && isServiceOffline) {
        syncActiveContext();
      }
    });
  }
}

initExtension();
