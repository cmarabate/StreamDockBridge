export interface PageMetadata {
  url?: string;
  documentTitle: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
  /** Series this page belongs to, when the page says so structurally. */
  jsonLdSeriesTitle?: string;

  /**
   * Evidence that this page is something being WATCHED, used to decide whether
   * a tab is eligible to own the media channel. Deliberately evidence rather
   * than a host allowlist, which would need editing per service and would still
   * miss a self-hosted player.
   */
  ogType?: string;
  jsonLdType?: string;
  hasVideo?: boolean;
  isPlaying?: boolean;
}

const MEDIA_TYPES = [
  'CreativeWork',
  'Movie',
  'TVSeries',
  'TVSeason',
  'TVEpisode',
  'VideoObject',
  'MediaObject',
  'Article',
  'NewsArticle',
  'Book',
];

const EXCLUDED_TYPES = [
  'Organization',
  'WebSite',
  'BreadcrumbList',
  'Person',
  'SiteNavigationElement',
];

export function isMediaObjectType(typeValue: any): boolean {
  if (!typeValue) return false;
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  if (types.some((t) => typeof t === 'string' && EXCLUDED_TYPES.includes(t))) {
    return false;
  }
  return types.some((t) => typeof t === 'string' && MEDIA_TYPES.includes(t));
}

function typeMatches(typeValue: any, wanted: string): boolean {
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  return types.some((t) => typeof t === 'string' && t === wanted);
}

function nameOf(node: any): string {
  if (!node || typeof node !== 'object') return '';
  return typeof node.name === 'string' ? normalizeWhitespace(node.name) : '';
}

/** Types that actually denote a series a work can belong to. */
const SERIES_TYPES = ['TVSeries', 'CreativeWorkSeries', 'Series'];

function isSeriesNode(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some((t) => typeof t === 'string' && SERIES_TYPES.includes(t));
}

/** Publishers sometimes emit these as single-element arrays. */
function firstOf(value: any): any {
  return Array.isArray(value) ? value[0] : value;
}

export function extractSeriesTitle(item: any): string {
  if (!item || typeof item !== 'object') return '';

  if (typeMatches(item['@type'], 'TVSeries')) {
    const own = nameOf(item);
    if (own) return own;
  }

  const direct = firstOf(item.partOfSeries);
  const directName = nameOf(direct);
  if (directName) return directName;

  const season = firstOf(item.partOfSeason);
  if (season && typeof season === 'object') {
    const viaSeason = nameOf(firstOf(season.partOfSeries));
    if (viaSeason) return viaSeason;
  }

  /**
   * isPartOf is the generic containment property and is routinely used to point
   * at a WebSite or WebPage. Without a type check, a page whose movie declares
   * `isPartOf: {@type: WebSite, name: "Prime Video"}` would make every lookup
   * search for "Prime Video" — and because this feeds the highest-priority
   * title source, it would override everything else on the page.
   */
  const generic = firstOf(item.isPartOf);
  if (isSeriesNode(generic)) {
    const genericName = nameOf(generic);
    if (genericName) return genericName;
  }

  return '';
}

function flattenJsonLd(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  let results: any[] = [];
  if (Array.isArray(node)) {
    for (const item of node) {
      results = results.concat(flattenJsonLd(item));
    }
  } else {
    results.push(node);
    if (node['@graph']) {
      results = results.concat(flattenJsonLd(node['@graph']));
    }
  }
  return results;
}

/**
 * Whitespace normalization only.
 *
 * Named distinctly from the service's cleanTitleText, which does provider,
 * chrome and season-qualifier stripping. Both are (string) => string, so a
 * shared name invites importing the wrong semantics with no type error.
 */
export function normalizeWhitespace(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

export function extractPageMetadata(doc: Document): PageMetadata {
  const meta: PageMetadata = {
    url: typeof doc !== 'undefined' && doc.location ? doc.location.href : '',
    documentTitle: normalizeWhitespace(doc.title),
  };

  try {
    const ogMeta = doc.querySelector('meta[property="og:title"]');
    if (ogMeta) {
      const content = ogMeta.getAttribute('content');
      if (content) meta.ogTitle = normalizeWhitespace(content);
    }

    const ogTypeMeta = doc.querySelector('meta[property="og:type"]');
    if (ogTypeMeta) {
      const content = ogTypeMeta.getAttribute('content');
      if (content) meta.ogType = normalizeWhitespace(content);
    }

    /**
     * A real player element, not merely a decorative one. Requiring a source or
     * a known duration keeps an autoplaying advert banner from making an
     * ordinary page look like something the owner is watching.
     */
    /**
     * ALWAYS set, true or false.
     *
     * This field is what distinguishes "the page answered and it is not media"
     * from "the content script never answered". Leaving it undefined on an
     * ordinary page made those two cases byte-identical, so a media tab that
     * navigated to a work page was never demoted — and the media channel then
     * carried that page's title. That is the failure this whole slice repairs,
     * reappearing inside the channel where isolation cannot help.
     */
    meta.hasVideo = false;
    meta.isPlaying = false;
    try {
      const videos = doc.querySelectorAll('video');
      for (let v = 0; v < videos.length; v++) {
        const video = videos[v] as HTMLVideoElement;
        const hasSource = !!(video.currentSrc || video.src || video.querySelector('source'));
        const hasDuration = typeof video.duration === 'number' && video.duration > 0;
        if (hasSource || hasDuration) {
          meta.hasVideo = true;
        }
        if (!video.paused && !video.ended && video.currentTime > 0) {
          meta.isPlaying = true;
          break;
        }
      }
    } catch (e) {
      // A document without a real video implementation is simply not media.
    }

    const twitterMeta = doc.querySelector('meta[name="twitter:title"]');
    if (twitterMeta) {
      const content = twitterMeta.getAttribute('content');
      if (content) meta.twitterTitle = normalizeWhitespace(content);
    }

    const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < jsonLdScripts.length; i++) {
      try {
        const text = jsonLdScripts[i].textContent;
        if (!text) continue;
        const parsed = JSON.parse(text);
        const items = flattenJsonLd(parsed);
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          if (isMediaObjectType(item['@type'])) {
            /**
             * Title and series must come from the SAME node. Letting them be
             * filled independently means a "More like this" carousel entry
             * elsewhere in the graph can supply the series while the principal
             * node supplies the title — and since series outranks title, the
             * carousel would win. First principal node wins, both fields together.
             *
             * A TVSeason's own name is "Season 2", which is never a work title,
             * so it may contribute a series but not a title.
             */
            const isSeason = typeMatches(item['@type'], 'TVSeason');
            const candidate = isSeason ? '' : item.name || item.headline;
            const usableTitle =
              typeof candidate === 'string' && candidate.trim() ? normalizeWhitespace(candidate) : '';
            const series = extractSeriesTitle(item);

            if (usableTitle || series) {
              if (usableTitle) meta.jsonLdTitle = usableTitle;
              if (series) meta.jsonLdSeriesTitle = series;
              /**
               * The principal node's own type, recorded so media eligibility is
               * decided from the same node the title came from rather than from
               * some unrelated entry elsewhere in the graph.
               */
              if (!meta.jsonLdType) {
                const rawType = item['@type'];
                const firstType = Array.isArray(rawType) ? rawType[0] : rawType;
                if (typeof firstType === 'string') meta.jsonLdType = firstType;
              }
              break;
            }
          }
        }
        if (meta.jsonLdTitle || meta.jsonLdSeriesTitle) break;
      } catch (e) {
        // Ignore JSON parse errors in LD+JSON blocks
      }
    }
  } catch (e) {
    // Best effort extraction
  }

  return meta;
}
