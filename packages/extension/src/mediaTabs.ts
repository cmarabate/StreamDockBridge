/**
 * Which tab owns the MEDIA channel inside one browser.
 *
 * The behaviour being preserved: the media key keeps working while the owner
 * reads something else, and even while the media browser is not the foreground
 * application at all. That is the point of a stream deck key — you press it
 * without going back to the browser first.
 *
 * So media ownership follows ACTIVATION of eligible tabs, not focus. Activating
 * an unrelated tab, or alt-tabbing away from the browser entirely, changes
 * nothing. Only another eligible tab, or the owner going away, does.
 */

export interface MediaTabState {
  tabId: number;
  windowId: number;
  url: string;
  /** Activation order from live user tab switching. Higher is more recent. 0 if bootstrap/unactivated. */
  order: number;
  /** Whether this tab is the active tab in its browser window. */
  isActive?: boolean;
  /** Whether media is actively playing in this tab. */
  isPlaying?: boolean;
  /** Timestamp from chrome.tabs.Tab.lastAccessed for recency ranking. */
  lastAccessed?: number;
  /** Timestamp when this tab state was last updated. */
  updatedAt: number;
}

/**
 * Whether a page looks like something someone is watching.
 *
 * Evidence-based rather than a host allowlist: a list would need editing for
 * every new service and would still be wrong for a self-hosted player. A page
 * qualifies if it declares itself video via Open Graph, describes a screen work
 * in structured data, or actually has a playing-capable video element.
 */
export interface MediaEvidence {
  ogType?: string;
  jsonLdType?: string;
  hasVideo?: boolean;
  isPlaying?: boolean;
}

const SCREEN_WORK_TYPES = [
  'movie',
  'tvepisode',
  'tvseries',
  'tvseason',
  'videoobject',
  'episode',
  'clip',
];

export function looksLikeMedia(evidence: MediaEvidence | null | undefined): boolean {
  if (!evidence) return false;

  const ogType = (evidence.ogType || '').toLowerCase();
  if (ogType.startsWith('video')) return true;

  const jsonLdType = (evidence.jsonLdType || '').toLowerCase();
  if (SCREEN_WORK_TYPES.includes(jsonLdType)) return true;

  return evidence.hasVideo === true || evidence.isPlaying === true;
}

export interface NoteEvidenceOptions {
  isActive?: boolean;
  isPlaying?: boolean;
  lastAccessed?: number;
  order?: number;
}

/**
 * Tracks eligible media tabs and deterministically names the current owner.
 *
 * Invariant: A paused background eligible tab must never defeat an active playing
 * eligible page, even after extension reload/rebuild bootstrap before a user tab switch.
 */
export class MediaTabTracker {
  private tabs = new Map<number, MediaTabState>();
  private counter = 0;

  /**
   * A tab became active, or reported fresh evidence while active.
   */
  noteActivated(
    tabId: number,
    windowId: number,
    url: string,
    eligible: boolean,
    isPlaying?: boolean
  ): void {
    if (!eligible) {
      this.tabs.delete(tabId);
      return;
    }

    // Mark all other tabs in the same window as not active
    for (const [id, state] of this.tabs.entries()) {
      if (id !== tabId && state.windowId === windowId) {
        this.tabs.set(id, { ...state, isActive: false, updatedAt: Date.now() });
      }
    }

    const existing = this.tabs.get(tabId);
    this.tabs.set(tabId, {
      tabId,
      windowId,
      url,
      order: ++this.counter,
      isActive: true,
      isPlaying: isPlaying !== undefined ? isPlaying : existing?.isPlaying ?? false,
      lastAccessed: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /**
   * A tab reported evidence without an explicit activation event (e.g. during reload rebuild).
   */
  noteEvidence(
    tabId: number,
    windowId: number,
    url: string,
    eligible: boolean,
    opts?: NoteEvidenceOptions
  ): void {
    if (!eligible) {
      this.tabs.delete(tabId);
      return;
    }

    const existing = this.tabs.get(tabId);
    const order = existing ? existing.order : (opts?.order ?? 0);
    const isPlaying = opts?.isPlaying !== undefined ? opts.isPlaying : existing?.isPlaying ?? false;
    const isActive = opts?.isActive !== undefined ? opts.isActive : existing?.isActive ?? false;
    const lastAccessed = opts?.lastAccessed !== undefined ? opts.lastAccessed : existing?.lastAccessed ?? 0;

    this.tabs.set(tabId, {
      tabId,
      windowId,
      url,
      order,
      isActive,
      isPlaying,
      lastAccessed,
      updatedAt: Date.now(),
    });
  }

  /**
   * Update playback state for a known tab.
   */
  notePlayback(tabId: number, isPlaying: boolean): void {
    const existing = this.tabs.get(tabId);
    if (existing) {
      this.tabs.set(tabId, {
        ...existing,
        isPlaying,
        updatedAt: Date.now(),
      });
    }
  }

  noteClosed(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /**
   * Evaluates all candidate tabs and selects the deterministic current Media owner.
   *
   * Authority Hierarchy:
   * 1. If explicit live activation order exists (order > 0) and the highest-order tab is active in window:
   *    Active user choice wins.
   * 2. Active playing media in window (isPlaying === true && isActive === true).
   * 3. Background playing media (isPlaying === true).
   * 4. Active tab in window (isActive === true).
   * 5. Most recently activated tab (order > 0).
   * 6. Recency heuristic from tab.lastAccessed.
   * 7. Deterministic tie-breaker by tabId.
   */
  current(): MediaTabState | null {
    if (this.tabs.size === 0) return null;

    const candidates = Array.from(this.tabs.values());

    candidates.sort((a, b) => {
      // 1. Check live activation precedence: if a tab has live activation (order > 0) and is active in its window
      const aLiveActive = (a.order > 0 && a.isActive) ? 1 : 0;
      const bLiveActive = (b.order > 0 && b.isActive) ? 1 : 0;
      if (aLiveActive !== bLiveActive) {
        return bLiveActive - aLiveActive;
      }
      if (aLiveActive === 1 && bLiveActive === 1) {
        return b.order - a.order;
      }

      // 2. Active playing media in window (Rank 1)
      const aActivePlaying = (a.isPlaying && a.isActive) ? 1 : 0;
      const bActivePlaying = (b.isPlaying && b.isActive) ? 1 : 0;
      if (aActivePlaying !== bActivePlaying) {
        return bActivePlaying - aActivePlaying;
      }

      // 3. Any playing media (Rank 2)
      const aPlaying = a.isPlaying ? 1 : 0;
      const bPlaying = b.isPlaying ? 1 : 0;
      if (aPlaying !== bPlaying) {
        return bPlaying - aPlaying;
      }

      // 4. Active tab in window (Rank 3)
      const aActive = a.isActive ? 1 : 0;
      const bActive = b.isActive ? 1 : 0;
      if (aActive !== bActive) {
        return bActive - aActive;
      }

      // 5. Prior activation order (Rank 4)
      if (a.order !== b.order) {
        return b.order - a.order;
      }

      // 6. Last accessed timestamp (Rank 5)
      const aAccessed = a.lastAccessed || 0;
      const bAccessed = b.lastAccessed || 0;
      if (aAccessed !== bAccessed) {
        return bAccessed - aAccessed;
      }

      // 7. Deterministic tie-breaker
      return b.tabId - a.tabId;
    });

    return candidates[0] || null;
  }

  get(tabId: number): MediaTabState | undefined {
    return this.tabs.get(tabId);
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  size(): number {
    return this.tabs.size;
  }

  clear(): void {
    this.tabs.clear();
    this.counter = 0;
  }
}
