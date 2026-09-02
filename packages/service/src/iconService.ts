import { deriveSiteOrigin } from './siteIcon';
import { isBlockedHostname } from './ipPolicy';
import { resolveSiteIcon, Getter } from './iconResolve';
import { IconCache, IconCacheHit } from './iconCache';
import { safeGet } from './iconFetch';

/**
 * The one place a URL template becomes an icon.
 *
 * Everything here is decided from the template's ORIGIN, never from the
 * current page: that is what makes a title change free, and what lets two keys
 * on the same site share a single download.
 */

export type IconStatus =
  | 'loaded' // fetched just now
  | 'cached' // served from the cache
  | 'unavailable' // eligible, but no usable icon came back
  | 'dynamic_host' // the template's authority depends on runtime context
  | 'local_host' // a legal browser destination, not an eligible fetch target
  | 'invalid_template'
  | 'unsupported_scheme';

export interface SiteIconOutcome {
  status: IconStatus;
  hostname?: string;
  origin?: string;
  icon?: IconCacheHit;
}

export interface SiteIconOptions {
  /** Re-resolve this one origin, ignoring and replacing its cache entry. */
  refresh?: boolean;
}

export class IconService {
  private readonly cache: IconCache;
  private readonly get: Getter;
  /**
   * One in-flight resolution per origin.
   *
   * Six keys appearing at once on the same site must cause one download, not
   * six. Entries are always removed in a finally, so this cannot grow.
   */
  private inflight = new Map<string, Promise<SiteIconOutcome>>();

  constructor(cache?: IconCache, get: Getter = safeGet) {
    this.cache = cache ?? new IconCache();
    this.get = get;
  }

  async resolve(template: string, options: SiteIconOptions = {}): Promise<SiteIconOutcome> {
    const derived = deriveSiteOrigin(template);
    if (!derived.ok) return { status: derived.reason };

    const { hostname, origin } = derived.site;

    /**
     * Opening http://localhost:3000 from a key stays legal. Making this
     * service fetch from it does not — the two capabilities have different
     * policies and this is the boundary between them.
     */
    if (isBlockedHostname(hostname)) return { status: 'local_host', hostname, origin };

    /**
     * Refresh runs its own resolution and never joins an in-flight one.
     *
     * Joining would return the pre-refresh promise, whose completion re-installs
     * the very entry that was just invalidated — the button would appear to work
     * and change nothing. An explicit refresh is worth one possible duplicate
     * fetch; both results are valid icons for the same origin.
     */
    if (options.refresh) {
      this.cache.invalidate(origin);
      return this.fetchAndStore(hostname, origin);
    }

    const cached = this.cache.get(origin);
    if (cached.state === 'hit') return { status: 'cached', hostname, origin, icon: cached.icon };
    if (cached.state === 'failed') return { status: 'unavailable', hostname, origin };

    const existing = this.inflight.get(origin);
    if (existing) return existing;

    const work = this.fetchAndStore(hostname, origin).finally(() => {
      this.inflight.delete(origin);
    });
    this.inflight.set(origin, work);
    return work;
  }

  private async fetchAndStore(hostname: string, origin: string): Promise<SiteIconOutcome> {
    let result;
    try {
      result = await resolveSiteIcon(origin, this.get);
    } catch (e) {
      // A favicon must never be able to break anything upstream of it.
      this.cache.setFailure(origin, 'fetch_failed');
      return { status: 'unavailable', hostname, origin };
    }

    if (!result.ok) {
      this.cache.setFailure(origin, result.reason);
      return { status: 'unavailable', hostname, origin };
    }

    const icon: IconCacheHit = {
      dataUri: result.icon.dataUri,
      mime: result.icon.mime,
      bytes: result.icon.bytes,
      sourceUrl: result.icon.sourceUrl,
    };
    this.cache.set(origin, icon);
    return { status: 'loaded', hostname, origin, icon };
  }
}
