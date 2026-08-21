export interface PageMetadata {
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

export function extractPageMetadata(doc: Document): PageMetadata {
  const documentTitle = doc.title || '';

  const ogElem = doc.querySelector('meta[property="og:title"]');
  const ogTitle = ogElem ? (ogElem.getAttribute('content') || undefined) : undefined;

  const twElem = doc.querySelector('meta[name="twitter:title"]');
  const twitterTitle = twElem ? (twElem.getAttribute('content') || undefined) : undefined;

  let jsonLdTitle: string | undefined = undefined;
  const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');

  for (let i = 0; i < jsonLdScripts.length; i++) {
    try {
      const parsed = JSON.parse(jsonLdScripts[i].textContent || '');
      const items = flattenJsonLd(parsed);
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (isMediaObjectType(item['@type'])) {
          const candidate = item.name || item.headline;
          if (typeof candidate === 'string' && candidate.trim()) {
            jsonLdTitle = candidate.trim();
            break;
          }
        }
      }
      if (jsonLdTitle) break;
    } catch (e) {
      // Ignore JSON parse errors
    }
  }

  return {
    documentTitle,
    ogTitle: ogTitle ? ogTitle.trim() : undefined,
    twitterTitle: twitterTitle ? twitterTitle.trim() : undefined,
    jsonLdTitle,
  };
}
