import { PageMetadata } from './metadata';

const SERVICE_URL = 'http://127.0.0.1:17337';
let cachedSecret: string | null = null;
let latestSequenceId = 0;

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
        console.log('[StreamDockBridge Extension] Handshake success, secret provisioned.');
        return cachedSecret;
      }
    }
  } catch (e) {
    console.error('[StreamDockBridge Extension] Handshake error:', e);
  }

  return null;
}

export async function syncActiveContext() {
  const currentSequence = ++latestSequenceId;

  chrome.tabs.query({ active: true }, async (tabs) => {
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
    const initialWindowId = targetTab.windowId;

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

    if (currentSequence !== latestSequenceId) {
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
      windowId: initialWindowId,
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
      console.log(`[StreamDockBridge Extension] POST /context status: ${res.status}`);
    } catch (e) {
      console.error('[StreamDockBridge Extension] POST /context error:', e);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onActivated.addListener(() => syncActiveContext());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url)) {
      syncActiveContext();
    }
  });
  chrome.tabs.onCreated.addListener(() => syncActiveContext());
  chrome.windows.onFocusChanged.addListener(() => syncActiveContext());
  chrome.runtime.onStartup.addListener(() => syncActiveContext());
  chrome.runtime.onInstalled.addListener(() => syncActiveContext());
}
