export interface MetadataPayload {
  rawTitle?: string;
  documentTitle?: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
}

export function cleanTitleText(title: string): string {
  if (!title) return '';
  let cleaned = title.trim();

  // IMDb cleanup: e.g. "Dandadan (TV Series 2024– ) - IMDb" => "Dandadan"
  cleaned = cleaned.replace(/\s*\([^)]*(?:TV Series|Movie|Mini-Series|Video)[^)]*\)\s*-\s*IMDb$/i, '');
  cleaned = cleaned.replace(/\s*-\s*IMDb$/i, '');

  // Crunchyroll cleanup: e.g. "Dandadan - Watch on Crunchyroll" => "Dandadan"
  cleaned = cleaned.replace(/\s*-\s*Watch on Crunchyroll$/i, '');
  cleaned = cleaned.replace(/\s*\|\s*Crunchyroll$/i, '');

  // Common site suffix cleanup
  cleaned = cleaned.replace(/\s*-\s*YouTube$/i, '');
  cleaned = cleaned.replace(/\s*\|\s*Netflix$/i, '');
  cleaned = cleaned.replace(/\s*-\s*Wikipedia$/i, '');

  return cleaned.trim();
}

export function deriveCanonicalTitle(meta: MetadataPayload): string {
  // Priority 1: Strong structured metadata (JSON-LD name/headline for principal media)
  if (meta.jsonLdTitle && meta.jsonLdTitle.trim()) {
    const cleaned = cleanTitleText(meta.jsonLdTitle);
    if (cleaned) return cleaned;
  }

  // Priority 2: og:title
  if (meta.ogTitle && meta.ogTitle.trim()) {
    const cleaned = cleanTitleText(meta.ogTitle);
    if (cleaned) return cleaned;
  }

  // Priority 3: twitter:title
  if (meta.twitterTitle && meta.twitterTitle.trim()) {
    const cleaned = cleanTitleText(meta.twitterTitle);
    if (cleaned) return cleaned;
  }

  // Priority 4: Cleaned document title
  if (meta.documentTitle && meta.documentTitle.trim()) {
    const cleaned = cleanTitleText(meta.documentTitle);
    if (cleaned) return cleaned;
  }

  // Priority 5: Raw tab title
  if (meta.rawTitle && meta.rawTitle.trim()) {
    const cleaned = cleanTitleText(meta.rawTitle);
    if (cleaned) return cleaned;
  }

  return '';
}
