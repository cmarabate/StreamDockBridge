/**
 * Choosing the BEST website icon for a ~126px key, not the first usable one.
 *
 * Two scores exist here and they are not the same thing:
 *
 *  - a DECLARED score, from the page's own `sizes` attribute, used only to
 *    decide the order in which candidates are worth downloading;
 *  - an ACTUAL score, from the bytes that came back, which decides the winner.
 *
 * The declared score is a hint and is frequently absent or wrong — ReelGood
 * declares no size at all on a 120x120 icon — so it must never be the final
 * word. This split is what stopped a 64x64 favicon.ico winning over it.
 */

/** The N4 Pro key is approximately this many pixels square. */
export const KEY_PIXELS = 126;

/** Below this, an asset is visibly soft on a key and is a last resort. */
export const MIN_USEFUL_PIXELS = 96;

export type CandidateSource = 'link' | 'apple-touch' | 'manifest' | 'fallback';

export interface IconCandidate {
  href: string;
  /** Largest declared square dimension, or 0 when the page said nothing. */
  declaredSize: number;
  source: CandidateSource;
}

/**
 * How good an image ACTUALLY is for the key. Lower wins.
 *
 * Bands, in order of preference:
 *   1. covers the key (>=128) — smallest such, so a 144px asset beats a 512px
 *      one; upscaling is what looks bad, and downscaling a little is free
 *   2. nearly covers it (96..127) — larger is better
 *   3. half the key (48..95) — larger is better
 *   4. anything else — larger is better
 *
 * The limiting dimension is the SMALLER side, because a wide banner scaled to
 * fit a square key is bounded by its height.
 */
export function scoreActualDimensions(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return Number.POSITIVE_INFINITY;

  const limiting = Math.min(width, height);
  // A tiebreaker only: a square asset fills a square key without letterboxing.
  const aspectPenalty = Math.round((Math.abs(width - height) / Math.max(width, height)) * 90);

  let band: number;
  if (limiting >= 128) band = Math.min(limiting, 9000);
  else if (limiting >= MIN_USEFUL_PIXELS) band = 10000 - limiting;
  else if (limiting >= 48) band = 20000 - limiting;
  else band = 30000 - limiting;

  return band + aspectPenalty;
}

/** True when a candidate is good enough that further downloads are wasted. */
export function isExcellent(width: number, height: number): boolean {
  const limiting = Math.min(width, height);
  const square = Math.abs(width - height) <= 2;
  return square && limiting >= KEY_PIXELS && limiting <= 256;
}

/**
 * Download ORDER, from what the page claimed. Never the final ranking.
 *
 * An undeclared size is deliberately mid-table rather than last: a page that
 * declares nothing is the common case, and burying those behind every
 * 16x16 that bothered to declare itself is how the ReelGood defect happened.
 */
export function scoreDeclared(candidate: IconCandidate): number {
  const declared = candidate.declaredSize;

  if (declared >= 128) return Math.min(declared, 9000);
  if (declared >= MIN_USEFUL_PIXELS) return 10000 - declared;

  if (declared === 0) {
    // apple-touch-icon is conventionally 180px, so it is the better guess.
    if (candidate.source === 'apple-touch') return 12000;
    if (candidate.source === 'manifest') return 12500;
    if (candidate.source === 'link') return 13000;
    return 14000; // /favicon.ico, which skews to 16-32px
  }

  // Declared, but too small to be good. Still worth trying if nothing else is.
  return 20000 - declared;
}

/** Order candidates by how promising they look before anything is downloaded. */
export function orderCandidates(candidates: IconCandidate[]): IconCandidate[] {
  const seen = new Set<string>();
  const unique: IconCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    unique.push(candidate);
  }
  return unique.sort((a, b) => scoreDeclared(a) - scoreDeclared(b));
}
