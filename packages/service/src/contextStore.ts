import { contextChannels, SourceIdentity } from './contextChannels';

export interface ContextRecord {
  url: string;
  hostname: string;
  rawTitle: string;
  documentTitle: string;
  ogTitle: string;
  twitterTitle: string;
  jsonLdTitle: string;
  /** Series name from structured page metadata, when the page declares one. */
  jsonLdSeriesTitle: string;
  canonicalTitle: string;
  /** Fresh playback snapshot used only to suppress an unnecessary PAUSE. */
  playbackState?: 'playing' | 'paused';
  /** Per-document token supplied by the content script for stale-target rejection. */
  documentGeneration?: string;
  tabId: number;
  windowId: number;
  timestamp: number;
}

/**
 * The identity used by a browser that has not told us who it is.
 *
 * An extension built before multi-browser support sends no instance id and no
 * channel. Treating it as one HYBRID source publishing MEDIA reproduces the old
 * single-context behaviour exactly, so an un-upgraded browser keeps working.
 * Two such browsers would still fight over the channel — the fix for that is
 * installing the newer extension, which is what gives them separate identities.
 */
export const LEGACY_SOURCE_ID = 'legacy-single-browser';

export const LEGACY_SOURCE: SourceIdentity = {
  browserInstanceId: LEGACY_SOURCE_ID,
  browserFamily: 'unknown',
  displayName: 'Browser (pre-channel extension)',
  mode: 'HYBRID',
  connectionGeneration: 1,
};

let legacySequence = 0;

/**
 * The historical single-context surface, now a thin view over the MEDIA channel.
 *
 * It used to fall back to PAGE when media was empty, and that was a real defect
 * rather than a convenience: with Brave publishing media and Chrome publishing
 * pages, a media key pressed while Brave had nothing would search whatever
 * Chrome happened to be showing. The owner saw exactly that — a ReelGood search
 * for a Supabase admin page while Regular Show was playing.
 *
 * Absence of media is now absence, not an invitation to use something else.
 * Every caller that wants the page must ask for the page by name.
 */
export class ContextStore {
  private compat(now = Date.now()): ContextRecord | null {
    return contextChannels.getRecord('media', now);
  }

  public updateContext(record: ContextRecord): boolean {
    const current = this.compat();
    if (current) {
      // Guard against stale/out-of-order updates
      if (record.timestamp < current.timestamp) {
        return false;
      }
      // Guard against overwriting a valid title with an empty title for the same page URL
      if (current.url === record.url && current.canonicalTitle && !record.canonicalTitle) {
        return false;
      }
    }

    const result = contextChannels.observe({
      source: LEGACY_SOURCE,
      channel: 'media',
      payload: { ...record },
      tabId: record.tabId,
      windowId: record.windowId,
      observationSequence: ++legacySequence,
      observedAt: record.timestamp,
    });

    return result.accepted;
  }

  public getContext(): ContextRecord | null {
    const current = this.compat();
    if (!current || !current.canonicalTitle) {
      return null;
    }
    return current;
  }

  /**
   * The stored record regardless of whether a title was derivable.
   *
   * getContext() requires a canonicalTitle because the lookup actions search on
   * it. Actions that only need the URL must not inherit that requirement — a
   * page with no usable title (a direct .mp4, a bare player, a title the
   * cleaner strips to empty) still has a perfectly transcribable URL.
   */
  public getCurrentRecord(): ContextRecord | null {
    return this.compat();
  }

  public clear(): void {
    contextChannels.clear();
    legacySequence = 0;
  }
}

export const contextStore = new ContextStore();
