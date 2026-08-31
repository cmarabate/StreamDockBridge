import { PageMetadata } from './metadata';
import { BrowserRole, loadBrowserRole, detectBrowserFamily, channelsFor } from './browserRole';
import { MediaTabTracker, looksLikeMedia } from './mediaTabs';
import { buildEnvelope, SequenceCounter, PagePayload } from './publisher';

const SERVICE_URL = 'http://127.0.0.1:17337';
let cachedSecret: string | null = null;
let latestSequenceId = 0;
let focusedWindowId: number | null = null;
let isServiceOffline = false;

/**
 * This installation's identity and role.
 *
 * Resolved once per service-worker lifetime. The generation inside it is bumped
 * on that first load, which is what lets the service tell a fresh worker from a
 * dead one whose messages are still arriving.
 */
let rolePromise: Promise<BrowserRole> | null = null;

const roleStorage = {
  async get(keys: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (r) => resolve(r || {}));
      } catch (e) {
        resolve({});
      }
    });
  },
  async set(items: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(items, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  },
};

export async function getRole(): Promise<BrowserRole> {
  if (!rolePromise) {
    rolePromise = (async () => {
      const family = await detectBrowserFamily();
      return loadBrowserRole(roleStorage, { family });
    })();
  }
  return rolePromise;
}

/** The settings page changed something; re-read it and republish. */
export function invalidateRole(): void {
  rolePromise = null;
}

const sequence = new SequenceCounter();
const mediaTabs = new MediaTabTracker();

export function getMediaTabs(): MediaTabTracker {
  return mediaTabs;
}

export function getFocusedWindowId(): number | null {
  return focusedWindowId;
}

export function setFocusedWindowId(windowId: number | null) {
  focusedWindowId = windowId;
}

export function isFocusedWindow(winId?: number): boolean {
  if (focusedWindowId === null || winId === undefined || (typeof chrome !== 'undefined' && chrome.windows && focusedWindowId === chrome.windows.WINDOW_ID_NONE)) {
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

export function clearCachedSecret() {
  cachedSecret = null;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.remove(['bridgeSecret']);
  }
}

export async function getSecret(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    clearCachedSecret();
  } else if (cachedSecret) {
    return cachedSecret;
  }

  const storageData = await new Promise<{ bridgeSecret?: string }>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({});
      }
    }, 300);

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && !forceRefresh) {
      chrome.storage.local.get(['bridgeSecret'], (res) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(res || {});
        }
      });
    } else {
      clearTimeout(timer);
      resolve({});
    }
  });

  if (storageData.bridgeSecret && !forceRefresh) {
    cachedSecret = storageData.bridgeSecret;
    return cachedSecret;
  }

  try {
    const res = await fetch(`${SERVICE_URL}/auth/handshake`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.secret) {
        cachedSecret = data.secret;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ bridgeSecret: data.secret });
        }
        return cachedSecret;
      }
    }
  } catch (e: any) {
    // Handshake error ignored
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

/** Note that a tab became active, and move media ownership if it qualifies. */
export async function noteTabActivated(tabId: number, windowId: number): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;

  const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
    try {
      chrome.tabs.get(tabId, (t) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        resolve(err || !t ? null : t);
      });
    } catch (e) {
      resolve(null);
    }
  });
  if (!tab) return;

  const url = tab.url || tab.pendingUrl || '';
  const meta = await requestMetadata(tabId);
  const wasOwner = mediaTabs.current()?.tabId === tabId;

  /**
   * No answer means we do not know, not that this is not media. A tab we
   * already believe is playing keeps that standing; one we know nothing about
   * simply is not promoted.
   */
  if (meta === null) {
    if (!mediaTabs.has(tabId)) return;
  } else {
    mediaTabs.noteActivated(tabId, windowId, url, looksLikeMedia(meta));
  }

  // Only bother the service when ownership actually moved.
  if (mediaTabs.current()?.tabId !== tabId || wasOwner) {
    if (!wasOwner) await publishMedia();
    return;
  }
  await publishMedia();
}

/**
 * Tell the service everything this browser currently believes.
 *
 * Used after a mode change and after the service has evidently restarted, so a
 * browser reclaims its channels without waiting for the user to do something.
 */
export async function republishAll(): Promise<void> {
  const role = await getRole();
  const allowed = channelsFor(role.mode);

  if (allowed.includes('media')) await publishMedia(role);
  else await postObservation(role, 'media', null);

  if (allowed.includes('page')) syncActiveContext();
}

/** Release this browser's channels on the way out. */
export async function sayGoodbye(): Promise<void> {
  try {
    const role = await getRole();
    const secret = await getSecret();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Bridge-Secret'] = secret;
    await fetch(`${SERVICE_URL}/sources/disconnect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ browserInstanceId: role.browserInstanceId }),
    });
  } catch (e) {
    // Best effort. The service's own TTL covers a browser that cannot say bye.
  }
}

/**
 * Keep this browser's channels alive, and reclaim them after a service restart.
 *
 * Deliberately separate from recoveryTick, which asks "does the service have
 * ANY context". That question cannot work once two browsers publish, because
 * the answer is almost never no. This one asks whether the service still knows
 * about THIS installation.
 */
export async function heartbeatTick(): Promise<void> {
  try {
    const role = await getRole();
    const allowed = channelsFor(role.mode);

    const secret = await getSecret();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Bridge-Secret'] = secret;

    /**
     * Says "still here" without publishing anything. A browser playing one
     * episode for an hour has no new observation to make, and its source must
     * not age out underneath it — that would release media mid-playback.
     */
    const res = await fetch(`${SERVICE_URL}/sources/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: {
          browserInstanceId: role.browserInstanceId,
          browserFamily: role.browserFamily,
          displayName: role.displayName,
          mode: role.mode,
          connectionGeneration: role.connectionGeneration,
        },
      }),
    });

    if (!res.ok) {
      isServiceOffline = true;
      return;
    }
    isServiceOffline = false;

    const data = await res.json();
    const owned: string[] = Array.isArray(data?.owned) ? data.owned : [];

    /**
     * The service does not hold a channel this browser is supposed to be
     * publishing — it restarted, or the channel was released while the worker
     * was asleep. Say everything again rather than waiting for the user to do
     * something.
     */
    const missing = allowed.filter((c) => c !== 'project' && !owned.includes(c));
    if (missing.length > 0) await republishAll();
  } catch (e) {
    isServiceOffline = true;
  }
}

export async function syncActiveContext(retryCount = 0) {
  const currentSequence = ++latestSequenceId;

  if (typeof chrome === 'undefined' || !chrome.windows || !chrome.tabs) {
    return;
  }

  chrome.windows.getAll({ populate: true }, async (windows) => {
    const err = chrome.runtime.lastError;
    if (err) { void err.message; }

    if (!windows || windows.length === 0) {
      if (retryCount < 3) {
        setTimeout(() => syncActiveContext(retryCount + 1), 200);
      }
      return;
    }

    let targetWin: chrome.windows.Window | undefined;
    if (focusedWindowId !== null && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      targetWin = windows.find((w) => w.id === focusedWindowId);
    }
    if (!targetWin) {
      targetWin = windows.find((w) => w.focused) || windows[0];
    }

    if (!targetWin || !targetWin.tabs || targetWin.tabs.length === 0) {
      if (retryCount < 3) {
        setTimeout(() => syncActiveContext(retryCount + 1), 200);
      }
      return;
    }

    const targetTab = targetWin.tabs.find((t) => t.active) || targetWin.tabs[0];
    if (!targetTab || !targetTab.id) return;
    const tabId = targetTab.id;
    const tabUrl: string = targetTab.url || targetTab.pendingUrl || '';
    const tabWindowId = targetWin.id || targetTab.windowId;

    if (!tabUrl) {
      if (retryCount < 3) {
        setTimeout(() => syncActiveContext(retryCount + 1), 200);
      }
      return;
    }

    let meta: PageMetadata = { url: tabUrl, documentTitle: targetTab.title || '' };

    try {
      meta = await new Promise<PageMetadata>((resolve) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({ url: tabUrl, documentTitle: targetTab?.title || '' });
          }
        }, 150);

        try {
          chrome.tabs.sendMessage(tabId, { action: 'GET_METADATA' }, (response) => {
            const sendErr = chrome.runtime.lastError;
            if (sendErr) { void sendErr.message; }
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              if (sendErr || !response) {
                resolve({ url: tabUrl, documentTitle: targetTab?.title || '' });
              } else {
                resolve(response);
              }
            }
          });
        } catch (e) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve({ url: tabUrl, documentTitle: targetTab?.title || '' });
          }
        }
      });
    } catch (e) {
      // Message error fallback
    }

    const docTitle = meta.documentTitle || targetTab.title || tabUrl;
    const hasRichMetadata = meta.ogTitle || meta.twitterTitle || meta.jsonLdTitle;
    const hasValidDocTitle = docTitle && !docTitle.startsWith('http://') && !docTitle.startsWith('https://');

    if (!hasRichMetadata && !hasValidDocTitle && retryCount < 3) {
      setTimeout(() => syncActiveContext(retryCount + 1), 300);
      return;
    }

    if (currentSequence !== latestSequenceId) {
      return;
    }

    let hostname = '';
    try {
      if (tabUrl) {
        hostname = new URL(tabUrl).hostname || '';
      }
    } catch (e) {
      // Invalid URL scheme
    }

    const page: PagePayload = {
      url: tabUrl,
      hostname,
      rawTitle: targetTab.title || tabUrl,
      documentTitle: docTitle,
      ogTitle: meta.ogTitle,
      twitterTitle: meta.twitterTitle,
      jsonLdTitle: meta.jsonLdTitle,
      jsonLdSeriesTitle: meta.jsonLdSeriesTitle,
      tabId: tabId,
      windowId: tabWindowId,
    };

    /**
     * The active tab's own media eligibility, recorded whether or not this
     * browser publishes media. Keeping the tracker current in every mode means
     * switching a browser to Media later does not start from an empty set.
     */
    /**
     * Only a real answer changes eligibility. The fallback meta built above
     * when the content script does not reply carries no media evidence, and
     * treating that as "not media" is what removed a playing tab from the set.
     */
    if (meta.ogType || meta.jsonLdType || meta.hasVideo !== undefined) {
      mediaTabs.noteEvidence(tabId, tabWindowId, tabUrl, looksLikeMedia(meta));
    }

    const role = await getRole();
    const allowed = channelsFor(role.mode);

    /**
     * PAGE is the active tab of the last-focused window — the work-browser
     * contract. It follows the tab you are looking at, and changing tabs must
     * move it immediately.
     */
    if (allowed.includes('page')) {
      await postObservation(role, 'page', page);
    }

    /**
     * MEDIA follows a different rule entirely: the most recently ACTIVATED
     * eligible tab, which is not necessarily the active one and is deliberately
     * unaffected by this browser being in the background. Publishing it from
     * here keeps it fresh whenever anything else happens.
     */
    if (allowed.includes('media')) {
      await publishMedia(role);
    }
  });
}

/**
 * Send one observation.
 *
 * A body the role forbids is never built, so a browser cannot publish a channel
 * it is not configured for even if something calls this by mistake.
 */
export async function postObservation(
  role: BrowserRole,
  channel: 'media' | 'page' | 'project',
  payload: PagePayload | null
): Promise<boolean> {
  const envelope = buildEnvelope(role, channel, sequence.next(), payload, Date.now());
  if (!envelope) return false;

  let secret = await getSecret();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Bridge-Secret'] = secret;

  const body = JSON.stringify(envelope);

  try {
    let res = await fetch(`${SERVICE_URL}/context`, { method: 'POST', headers, body });

    if (res.status === 401) {
      secret = await getSecret(true);
      if (secret) {
        headers['X-Bridge-Secret'] = secret;
        res = await fetch(`${SERVICE_URL}/context`, { method: 'POST', headers, body });
      }
    }

    isServiceOffline = !res.ok;
    return res.ok;
  } catch (e: any) {
    isServiceOffline = true;
    return false;
  }
}

/**
 * Publish whichever tab currently owns media, or release the channel when no
 * eligible tab is left.
 */
export async function publishMedia(role?: BrowserRole): Promise<void> {
  const resolved = role || (await getRole());
  if (!channelsFor(resolved.mode).includes('media')) return;

  let owner = mediaTabs.current();

  /**
   * An empty tracker is not evidence that nothing is playing.
   *
   * This map lives in an MV3 service worker, which the browser kills whenever
   * it feels like it, and it comes back empty. Publishing a RELEASE at that
   * moment is how Brave erased its own media channel while Regular Show was
   * still playing — and then a media key, finding nothing, fell through to
   * whatever Chrome was showing. Rebuild from the real tabs before concluding
   * there is nothing to play.
   */
  if (!owner) {
    await rebuildMediaTabs();
    owner = mediaTabs.current();
  }

  if (!owner) {
    await postObservation(resolved, 'media', null);
    return;
  }

  if (typeof chrome === 'undefined' || !chrome.tabs) return;

  const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
    try {
      chrome.tabs.get(owner.tabId, (t) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        resolve(err || !t ? null : t);
      });
    } catch (e) {
      resolve(null);
    }
  });

  // The tab vanished without an onRemoved reaching us.
  if (!tab || !tab.id) {
    mediaTabs.noteClosed(owner.tabId);
    await publishMedia(resolved);
    return;
  }

  const url = tab.url || owner.url;
  let hostname = '';
  try {
    hostname = new URL(url).hostname || '';
  } catch (e) {
    // A tab on an internal page has no usable hostname.
  }

  // Silence here costs richer titles, never the channel itself.
  const meta = (await requestMetadata(tab.id)) || { documentTitle: tab.title || url };

  await postObservation(resolved, 'media', {
    url,
    hostname,
    rawTitle: tab.title || url,
    documentTitle: meta.documentTitle || tab.title || url,
    ogTitle: meta.ogTitle,
    twitterTitle: meta.twitterTitle,
    jsonLdTitle: meta.jsonLdTitle,
    jsonLdSeriesTitle: meta.jsonLdSeriesTitle,
    tabId: tab.id,
    windowId: tab.windowId ?? owner.windowId,
  });
}

/**
 * Ask a tab's content script what it knows.
 *
 * Returns null when the script did not answer, which is NOT the same as
 * answering "this is not media". A streaming page is heavy and routinely
 * misses a short deadline; treating that silence as a negative is what deleted
 * a playing tab from the candidate set. The deadline is generous for the same
 * reason — this runs in the background, so waiting costs nothing visible.
 */
export const METADATA_TIMEOUT_MS = 600;

function requestMetadata(tabId: number): Promise<PageMetadata | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, METADATA_TIMEOUT_MS);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'GET_METADATA' }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err || !response ? null : response);
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

/**
 * Ask every tab whether it is playing something, and repopulate the tracker.
 *
 * Only ever ADDS candidates. A tab that does not answer is left out of this
 * pass rather than being recorded as not-media, because silence is ignorance.
 */
export async function rebuildMediaTabs(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;

  const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => {
    try {
      chrome.tabs.query({}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        resolve(Array.isArray(result) ? result : []);
      });
    } catch (e) {
      resolve([]);
    }
  });

  // Bounded: a browser with hundreds of tabs must not turn this into a storm.
  const candidates = tabs.filter((t) => typeof t.id === 'number' && /^https?:/.test(t.url || ''));
  const scanned = candidates.slice(0, 40);

  const results = await Promise.all(
    scanned.map(async (tab) => ({ tab, meta: await requestMetadata(tab.id as number) }))
  );

  for (const { tab, meta } of results) {
    if (!meta) continue; // no answer is not a negative answer
    if (!looksLikeMedia(meta)) continue;
    /**
     * Recorded as evidence rather than activation, so a rebuild never invents
     * an activation order. The active tab keeps its natural precedence because
     * a real activation always outranks these.
     */
    mediaTabs.noteEvidence(tab.id as number, tab.windowId ?? 0, tab.url || '', true);
  }
}

export function initExtension() {
  try {
    if (typeof chrome !== 'undefined' && chrome.windows) {
      chrome.windows.getLastFocused({ populate: false }, (win) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        if (win && win.id !== undefined && win.id !== chrome.windows.WINDOW_ID_NONE) {
          focusedWindowId = win.id;
        }
        syncActiveContext();
      });
    } else {
      syncActiveContext();
    }
  } catch (e) {
    syncActiveContext();
  }
}

// Global scope exports on globalThis & self
try {
  (globalThis as any)['syncActiveContext'] = syncActiveContext;
  (globalThis as any)['initExtension'] = initExtension;
  if (typeof self !== 'undefined') {
    (self as any)['syncActiveContext'] = syncActiveContext;
    (self as any)['initExtension'] = initExtension;
  }
} catch (e) {
  // Global scope may be locked down in some environments; safe to ignore.
}

// Synchronous top-level MV3 event listener registrations
if (typeof chrome !== 'undefined') {
  if (chrome.runtime) {
    chrome.runtime.onStartup?.addListener(() => syncActiveContext());
    chrome.runtime.onInstalled?.addListener(() => syncActiveContext());
  }

  if (chrome.windows) {
    chrome.windows.onFocusChanged?.addListener((windowId) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        focusedWindowId = windowId;
        syncActiveContext();
      }
    });
  }

  if (chrome.runtime) {
    /**
     * The settings page changed the mode or the name.
     *
     * `sender.tab` is set for a content script and absent for an extension page,
     * so requiring its absence means only our own options page can change this
     * browser's role. A page's script cannot reach context authority here, which
     * is the property this worker has always held.
     */
    chrome.runtime.onMessage?.addListener((message, sender) => {
      if (sender && (sender as chrome.runtime.MessageSender).tab) return undefined;
      if (message && message.action === 'ROLE_CHANGED') {
        invalidateRole();
        void republishAll();
      }
      return undefined;
    });

    /**
     * A browser closing cleanly says so, rather than leaving the service to
     * time its channels out. The TTL is the backstop for a crash.
     */
    chrome.runtime.onSuspend?.addListener(() => {
      void sayGoodbye();
    });
  }

  if (chrome.tabs) {
    chrome.tabs.onActivated?.addListener((activeInfo) => {
      /**
       * Media ownership follows ACTIVATION, in any window, whether or not this
       * browser is the foreground application. That is the whole reason a media
       * key keeps working while the owner reads something else.
       */
      void noteTabActivated(activeInfo.tabId, activeInfo.windowId);

      if (focusedWindowId === null || activeInfo.windowId === focusedWindowId) {
        syncActiveContext();
      }
    });

    chrome.tabs.onRemoved?.addListener((tabId) => {
      if (!mediaTabs.has(tabId)) return;
      mediaTabs.noteClosed(tabId);
      // Falls back to the next most recent eligible tab, or releases the channel.
      void publishMedia();
    });

    chrome.tabs.onUpdated?.addListener((_tabId, changeInfo, tab) => {
      if (tab.active && isFocusedWindow(tab.windowId)) {
        if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
          syncActiveContext();
        }
      }
    });

    chrome.tabs.onCreated?.addListener((tab) => {
      if (isFocusedWindow(tab.windowId)) {
        syncActiveContext();
      }
    });
  }

  if (chrome.alarms) {
    chrome.alarms.create('service_recovery_alarm', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm?.addListener((alarm) => {
      if (alarm.name === 'service_recovery_alarm') {
        recoveryTick();
        heartbeatTick();
      }
    });
  }
}

// Immediate synchronous top-level execution
initExtension();
