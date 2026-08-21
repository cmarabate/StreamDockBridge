export interface PageMetadata {
  documentTitle: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
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
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = item['@type'];
        const validTypes = ['CreativeWork', 'Movie', 'TVSeries', 'TVEpisode', 'Book', 'VideoObject', 'NewsArticle', 'Article', 'MediaObject'];
        const isMedia = Array.isArray(type)
          ? type.some((t: string) => validTypes.includes(t))
          : validTypes.includes(type);

        if (isMedia || !type) {
          const candidate = item.name || item.headline;
          if (typeof candidate === 'string' && candidate.trim()) {
            jsonLdTitle = candidate.trim();
            break;
          }
        }
      }
      if (jsonLdTitle) break;
    } catch (e) {
      // Ignore JSON parse errors in script tag
    }
  }

  return {
    documentTitle,
    ogTitle: ogTitle ? ogTitle.trim() : undefined,
    twitterTitle: twitterTitle ? twitterTitle.trim() : undefined,
    jsonLdTitle,
  };
}
