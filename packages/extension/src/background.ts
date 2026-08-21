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

export function isFocusedWindow(winId?: number): boolean {
  if (focusedWindowId === null || (typeof chrome !== 'undefined' && chrome.windows && focusedWindowId === chrome.windows.WINDOW_ID_NONE)) {
    return true;
  }
  return winId === focusedWindowId;
}

export function getIsServiceOffline(): boolean {
  return isServiceOffline;
}

export function setIsServiceOffline(offline: boolean) {
  isServiceOffline = offline;
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
    } else {
      console.warn('[Extension Handshake Failed]: status', res.status);
    }
  } catch (e) {
    console.warn('[Extension Handshake Error]:', e);
  }

  return null;
}

export async function recoveryTick() {
  try {
    const res = await fetch(`${SERVICE_URL}/context`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.context === null) {
        syncActiveContext();
      }
      isServiceOffline = false;
    } else {
      isServiceOffline = true;
    }
  } catch (e) {
    isServiceOffline = true;
  }
}

export async function syncActiveContext() {
  const currentSequence = ++latestSequenceId;

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

    if (!isFocusedWindow(tabWindowId)) {
      return;
    }

    let meta: PageMetadata = { documentTitle: targetTab.title || '' };

    if (tabUrl.startsWith('http://') || tabUrl.startsWith('https://')) {
      try {
        meta = await new Promise<PageMetadata>((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'GET_METADATA' }, (response) => {
            if (chrome.runtime?.lastError || !response) {
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

    if (currentSequence !== latestSequenceId) {
      return;
    }
    if (!isFocusedWindow(tabWindowId)) {
      return;
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
        console.warn('[Extension Context Post Failed]: status', res.status);
        isServiceOffline = true;
      }
    } catch (e) {
      console.warn('[Extension Context Post Error]:', e);
      isServiceOffline = true;
    }
  });
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
      if (isFocusedWindow(activeInfo.windowId)) {
        syncActiveContext();
      }
    });

    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (tab.active && isFocusedWindow(tab.windowId)) {
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
      if (alarm.name === 'service_recovery_alarm') {
        recoveryTick();
      }
    });
  }
}

initExtension();
