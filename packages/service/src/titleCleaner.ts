export interface MetadataPayload {
  rawTitle?: string;
  documentTitle?: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
  /** Series name from structured metadata (partOfSeries / isPartOf / a TVSeries node). */
  jsonLdSeriesTitle?: string;
}

/**
 * Titles arrive from arbitrary web pages into a single-threaded service that a
 * hardware button depends on. Normalization is regex-heavy over punctuation, so
 * an unbounded title is a denial-of-service vector: a hostile tab could stall
 * the event loop and the N4 would stop responding. No real work title is close
 * to this long.
 */
export const MAX_TITLE_LENGTH = 400;

/** Providers that append their name to the page title. */
const PROVIDER_SUFFIXES = [
  'Prime Video',
  'Amazon.com',
  'Netflix Official Site',
  'Netflix',
  'Hulu',
  'Disney\\+',
  'HBO Max',
  'Max',
  'Apple TV\\+?',
  'Paramount\\+',
  'Peacock',
  'Crunchyroll',
  'Tubi Free TV',
  'Tubi',
  'Plex',
  'Fawesome TV',
  'Fawesome',
  'YouTube',
  'Wikipedia',
  'IMDb',
  'JustWatch',
];

/**
 * Providers that LEAD with their name ("Prime Video: <Show> Season 2").
 *
 * Deliberately a separate, much narrower list. A prefix rule needs only a
 * colon to fire, so the generic single-word entries above are unsafe here —
 * "Max: The Curse of Brotherhood" and "Plex: The Movie" are titles, not
 * provider chrome, and stripping their first word also unlocks the leading-verb
 * removal below.
 */
const PROVIDER_PREFIXES = ['Prime Video', 'Amazon\\.com'];

const SEPARATOR = '[\\s]*[|\\u2013\\u2014\\-\\u00b7]+[\\s]*';

// Longest first, so "Netflix Official Site" is preferred over "Netflix".
const PROVIDER_ALTERNATION = [...PROVIDER_SUFFIXES].sort((a, b) => b.length - a.length).join('|');

// Some providers introduce themselves ("… - Watch on Paramount+").
const PROVIDER_SUFFIX_RE = new RegExp(
  `${SEPARATOR}(?:watch(?:\\s+it)?\\s+on\\s+)?(?:${PROVIDER_ALTERNATION})\\s*$`,
  'i'
);
const PROVIDER_PREFIX_RE = new RegExp(`^(?:${PROVIDER_PREFIXES.join('|')})\\s*:\\s*`, 'i');

/**
 * Interface chrome wedged between the work title and the provider name.
 * Multi-word and unambiguous, so plain whitespace separation is enough.
 */
const CHROME_PHRASES = ['Watch Full Episodes', 'Seasons? & Episodes', 'Streaming Online'];
const CHROME_SUFFIX_RE = new RegExp(
  `[\\s]*(?:${SEPARATOR})?(?:${CHROME_PHRASES.join('|')})\\s*$`,
  'i'
);
/**
 * "Show" is an ordinary title word, so it only counts as chrome when a
 * separator sets it apart, as Apple TV does ("… - Show - Apple TV"). That
 * requirement is what keeps "The Truman Show" and "Chappelle's Show" intact.
 */
const CHROME_WORD_RE = new RegExp(`${SEPARATOR}(?:Show|Episodes)\\s*$`, 'i');

/**
 * Bidi and byte-order marks. Apple TV really does prefix document.title with
 * U+200E, which `\s` does not match, so trim() leaves it in place and any
 * leading-verb rule silently fails.
 */
const FORMAT_MARKS_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|' +
  'fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';

/**
 * A qualifier must begin at a word gap.
 *
 * Requiring real whitespace first — then optionally separator punctuation — is
 * what keeps the rules from biting into a word. Without it, "Ocean's 11" loses
 * its tail to the S-code pattern (`s 11`), and "Preseason 2" loses its head.
 */
const QUALIFIER_PREFIX = '[\\s]+[|\\u2013\\u2014\\-\\u00b7:,]*[\\s]*';

/**
 * Trailing season/episode qualifiers, only ever removed when they read as
 * metadata appended to a title.
 *
 * Deliberately NOT handled: "Part N" and "Vol. N". Those appear in real titles
 * (Kill Bill: Vol. 2; Harry Potter and the Deathly Hallows: Part 2) and are not
 * safely separable from season numbering.
 */
const QUALIFIER_PATTERNS = [
  // "Season 2", "Series 2", "Staffel 2", "Temporada 2", optionally + "Episode 4"
  new RegExp(
    `${QUALIFIER_PREFIX}(?:season|series|staffel|temporada|saison|stagione)\\s*(?:\\d{1,3}|${NUMBER_WORDS})` +
      `(?:\\s*[,:-]?\\s*(?:episode|ep\\.?)\\s*\\d{1,3})?\\s*$`,
    'i'
  ),
  // "S02", "S02E04", "S2 E4"
  new RegExp(`${QUALIFIER_PREFIX}s\\d{1,2}(?:\\s*[,:-]?\\s*e\\s?\\d{1,3})?\\s*$`, 'i'),
  // "Episode 4"
  new RegExp(`${QUALIFIER_PREFIX}(?:episode|ep\\.)\\s*\\d{1,3}\\s*$`, 'i'),
];

/**
 * A result is only accepted if a letter or digit survives — in any script.
 *
 * An ASCII-only check silently disabled every rule for CJK, Hangul, Cyrillic,
 * Greek, Arabic and more, so those titles were returned raw with the provider
 * name still attached.
 */
function hasSubstance(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/** Replace only if the result still says something. */
function tryReplace(current: string, pattern: RegExp): string {
  const candidate = current.replace(pattern, '').trim();
  if (candidate === current || !hasSubstance(candidate)) return current;
  return candidate;
}

/** Drop separator punctuation left dangling once a suffix was removed. */
function trimDanglingSeparators(title: string): string {
  const trimmed = title
    .replace(/^[\s|–—\-:,]+/, '')
    .replace(/[\s|–—\-:,]+$/, '')
    .trim();
  return hasSubstance(trimmed) ? trimmed : title.trim();
}

export interface CleanTitleOptions {
  /**
   * Remove trailing season/episode qualifiers. Turned off for a title that is
   * already work-level — a series name a page declared structurally is the
   * publisher's own answer, so guessing at it can only make things worse. It
   * is also the only way a work genuinely named "Open Season 2" survives.
   */
  stripQualifiers?: boolean;
}

export function cleanTitleText(title: string, options: CleanTitleOptions = {}): string {
  if (!title) return '';

  let cleaned = title
    .slice(0, MAX_TITLE_LENGTH)
    .replace(FORMAT_MARKS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

  const original = cleaned;

  // IMDb: "Dandadan (TV Series 2024– ) - IMDb" => "Dandadan"
  cleaned = cleaned.replace(/\s*\([^)]*(?:TV Series|Movie|Mini-Series|Video)[^)]*\)\s*-\s*IMDb$/i, '');
  // Crunchyroll: "Dandadan - Watch on Crunchyroll" => "Dandadan"
  cleaned = cleaned.replace(/\s*-\s*Watch on Crunchyroll$/i, '');

  let providerStripped = false;

  /**
   * Bounded loop rather than a single pass: removing a qualifier can expose a
   * provider suffix that was previously buried ("The Bear - Hulu Season 3"),
   * and pages do stack two providers ("… - Prime Video | Amazon.com").
   */
  for (let pass = 0; pass < 4; pass++) {
    const before = cleaned;

    const afterSuffix = tryReplace(cleaned, PROVIDER_SUFFIX_RE);
    if (afterSuffix !== cleaned) {
      cleaned = afterSuffix;
      providerStripped = true;
    }

    const afterPrefix = tryReplace(cleaned, PROVIDER_PREFIX_RE);
    if (afterPrefix !== cleaned) {
      cleaned = afterPrefix;
      providerStripped = true;
    }

    if (providerStripped) {
      cleaned = tryReplace(cleaned, CHROME_SUFFIX_RE);
      cleaned = tryReplace(cleaned, CHROME_WORD_RE);
    }

    if (options.stripQualifiers !== false) {
      for (const pattern of QUALIFIER_PATTERNS) {
        cleaned = tryReplace(cleaned, pattern);
      }
    }

    if (cleaned === before) break;
  }

  if (providerStripped) {
    /**
     * Providers that append their name also tend to prefix a verb:
     * "Watch <Show> Season 2 | Prime Video". Gated on a provider marker so a
     * work actually named "Watch ..." is safe everywhere else.
     */
    cleaned = tryReplace(cleaned, /^(?:watch|stream)\s+/i);
  }

  // Only tidy punctuation we ourselves exposed; "-30-" is a real film title.
  return cleaned === original ? cleaned : trimDanglingSeparators(cleaned);
}

/**
 * The single work-level title every lookup action searches on.
 *
 * Structured series metadata wins outright: when a page declares the series it
 * belongs to, that is the work title, and no amount of string surgery on a
 * flattened display title beats it.
 */
export function deriveCanonicalTitle(meta: MetadataPayload): string {
  // Priority 0: the series a page explicitly says it is part of. Already
  // work-level, so qualifier stripping is not applied to it.
  if (meta.jsonLdSeriesTitle && meta.jsonLdSeriesTitle.trim()) {
    const cleaned = cleanTitleText(meta.jsonLdSeriesTitle, { stripQualifiers: false });
    if (cleaned) return cleaned;
  }

  for (const candidate of [meta.jsonLdTitle, meta.ogTitle, meta.twitterTitle, meta.documentTitle, meta.rawTitle]) {
    if (candidate && candidate.trim()) {
      const cleaned = cleanTitleText(candidate);
      if (cleaned) return cleaned;
    }
  }

  return '';
}
