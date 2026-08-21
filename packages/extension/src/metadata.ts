export interface PageMetadata {
  url?: string;
  documentTitle: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
}

const MEDIA_TYPES = [
  'CreativeWork',
  'Movie',
  'TVSeries',
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

export function cleanTitleText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

export function extractPageMetadata(doc: Document): PageMetadata {
  const meta: PageMetadata = {
    url: typeof doc !== 'undefined' && doc.location ? doc.location.href : '',
    documentTitle: cleanTitleText(doc.title),
  };

  try {
    const ogMeta = doc.querySelector('meta[property="og:title"]');
    if (ogMeta) {
      const content = ogMeta.getAttribute('content');
      if (content) meta.ogTitle = cleanTitleText(content);
    }

    const twitterMeta = doc.querySelector('meta[name="twitter:title"]');
    if (twitterMeta) {
      const content = twitterMeta.getAttribute('content');
      if (content) meta.twitterTitle = cleanTitleText(content);
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
            const candidate = item.name || item.headline;
            if (typeof candidate === 'string' && candidate.trim()) {
              meta.jsonLdTitle = cleanTitleText(candidate);
              break;
            }
          }
        }
        if (meta.jsonLdTitle) break;
      } catch (e) {
        // Ignore JSON parse errors in LD+JSON blocks
      }
    }
  } catch (e) {
    // Best effort extraction
  }

  return meta;
}
