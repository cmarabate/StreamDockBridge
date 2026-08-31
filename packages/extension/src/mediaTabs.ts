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
  /** Activation order. Higher is more recent. */
  order: number;
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

  return evidence.hasVideo === true;
}

/**
 * Tracks eligible media tabs and names the current owner.
 *
 * Bounded by construction: entries only exist for tabs the browser has told us
 * about, and every removal path deletes them.
 */
export class MediaTabTracker {
  private tabs = new Map<number, MediaTabState>();
  private counter = 0;

  /**
   * A tab became active, or reported fresh evidence while active.
   *
   * Ineligible pages are not merely ignored — an eligible tab that navigates to
   * something that is not media must stop being a candidate, or closing it
   * later would hand ownership to a stale entry.
   */
  noteActivated(tabId: number, windowId: number, url: string, eligible: boolean): void {
    if (!eligible) {
      this.tabs.delete(tabId);
      return;
    }
    this.tabs.set(tabId, { tabId, windowId, url, order: ++this.counter });
  }

  /**
   * A tab reported evidence without being activated.
   *
   * This keeps a background tab's eligibility current without promoting it:
   * ownership is about activation, so a tab that starts playing in the
   * background does not steal the channel.
   */
  noteEvidence(tabId: number, windowId: number, url: string, eligible: boolean): void {
    if (!eligible) {
      this.tabs.delete(tabId);
      return;
    }
    const existing = this.tabs.get(tabId);
    if (existing) {
      this.tabs.set(tabId, { ...existing, windowId, url });
      return;
    }
    // First time we have seen it and it was never activated: remember it as the
    // least recent candidate so it can still be a fallback.
    this.tabs.set(tabId, { tabId, windowId, url, order: 0 });
  }

  noteClosed(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** The most recently activated eligible tab, or null. */
  current(): MediaTabState | null {
    let best: MediaTabState | null = null;
    for (const state of this.tabs.values()) {
      if (!best || state.order > best.order) best = state;
    }
    return best;
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
