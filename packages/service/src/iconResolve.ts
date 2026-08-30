import { safeGet, IconFetchError, MAX_RESPONSE_BYTES, hopPolicyFailure } from './iconFetch';
import { imageDimensions } from './imageDimensions';

/**
 * Turning a site origin into an image the deck can display.
 *
 * Bytes are never decoded here. They are sniffed, bounded, dimension-checked
 * and passed through as a data URI, so this process runs no image decoder.
 * That does not make the bytes harmless — the rendering host and the Property
 * Inspector both decode them — which is why the limits below are enforced
 * before anything is handed on.
 */

/** Enough to reach the <head> of any real page; the rest is never needed. */
export const MAX_HTML_BYTES = 192 * 1024;

/**
 * Whole-resolution budget, covering the page read and every icon candidate.
 *
 * Deliberately under the plugin's own 25s bridge timeout: without this, six
 * serial fetches at 10s each could outlive the caller that asked for them.
 */
export const RESOLVE_BUDGET_MS = 20000;

/** How many declared candidates are worth trying before giving up. */
export const MAX_CANDIDATES = 5;

/** MIME types the host's own data-URI table accepts, minus the risky ones. */
const ACCEPTED = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/x-icon', magic: [0x00, 0x00, 0x01, 0x00] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF….WEBP, checked below
];

/**
 * SVG is deliberately excluded even though the host accepts it: it is XML, so
 * it carries entity-expansion, external-reference and embedded-script surface,
 * and we would be handing it straight to the host's renderer. Around 1% of
 * sites offer only SVG, which is a poor trade for that risk.
 */
export const MAX_ICON_DIMENSION = 1024;

export interface ResolvedIcon {
  /** `data:<mime>;base64,<...>` ready for setImage. */
  dataUri: string;
  /** Where it came from, for diagnostics. */
  sourceUrl: string;
  mime: string;
  bytes: number;
}

export type IconResolveFailure =
  | 'no_candidates'
  | 'unsupported_image'
  | 'image_too_large'
  | 'fetch_failed';

export type IconResolveResult =
  | { ok: true; icon: ResolvedIcon }
  | { ok: false; reason: IconResolveFailure };

export function sniffMime(body: Buffer): string | null {
  for (const entry of ACCEPTED) {
    if (body.length < entry.magic.length) continue;
    if (entry.magic.every((byte, i) => body[i] === byte)) {
      if (entry.mime === 'image/webp') {
        // RIFF is a container; require the WEBP fourcc.
        if (body.length < 12 || body.slice(8, 12).toString('ascii') !== 'WEBP') continue;
      }
      return entry.mime;
    }
  }
  return null;
}

export { pngDimensions } from './imageDimensions';

interface Candidate {
  href: string;
  score: number;
}

/**
 * Pull `<link ...>` tags out of a page.
 *
 * Deliberately NOT a regex. `/<link\b[^>]*>/g` is quadratic on hostile input:
 * a body of 192 KB of `"<link"` with no `>` anywhere gives every occurrence a
 * scan to end-of-string, which measured at ~4 seconds of blocked event loop —
 * and this service is single-threaded, so that stalls keyDown launches and
 * context updates too. indexOf scanning is linear and bounded.
 */
export function extractLinkTags(html: string): string[] {
  const MAX_TAG_LENGTH = 4096;
  const MAX_TAGS = 100;
  const lower = html.toLowerCase();
  const tags: string[] = [];

  let cursor = 0;
  while (tags.length < MAX_TAGS) {
    const start = lower.indexOf('<link', cursor);
    if (start < 0) break;

    const following = html[start + 5];
    // `<linkfoo` is a different element; only a delimiter makes it a link tag.
    if (following !== undefined && !/[\s/>]/.test(following)) {
      cursor = start + 5;
      continue;
    }

    const end = html.indexOf('>', start);
    if (end < 0) break;
    if (end - start <= MAX_TAG_LENGTH) tags.push(html.slice(start, end + 1));
    cursor = end + 1;
  }

  return tags;
}

/**
 * Rank declared icons for a ~126px square key.
 *
 * The HTML spec has no ranked list of rel values — `sizes` and `type` are the
 * normative signals — so ranking is by declared size, preferring the smallest
 * that still exceeds the key, then the largest below it. apple-touch-icon is
 * non-standard but is present on a large share of sites and is usually 180px,
 * which is exactly the right neighbourhood.
 */
export function rankIconCandidates(html: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const tag of extractLinkTags(html)) {
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1];
    if (!rel) continue;
    const tokens = rel.toLowerCase().split(/\s+/);
    const isIcon = tokens.includes('icon') || tokens.includes('apple-touch-icon');
    // mask-icon and monochrome purposes are silhouettes; they render as blobs.
    if (!isIcon || tokens.includes('mask-icon')) continue;

    const href = (/\bhref\s*=\s*["']([^"']+)/i.exec(tag) || [])[1];
    if (!href) continue;

    const type = ((/\btype\s*=\s*["']?([^"'>\s]+)/i.exec(tag) || [])[1] || '').toLowerCase();
    if (type.includes('svg')) continue; // see the note on SVG above

    const sizes = ((/\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1] || '').toLowerCase();
    let largest = 0;
    for (const token of sizes.split(/\s+/)) {
      const match = /^(\d+)x(\d+)$/.exec(token);
      if (match) largest = Math.max(largest, Number(match[1]));
    }

    /**
     * Lowest score wins. Four bands, in order of preference:
     *   1. covers the key  — smallest first, so a 144px icon beats a 512px one
     *   2. below the key   — largest first
     *   3. undeclared apple-touch-icon, which is conventionally around 180px
     *   4. undeclared anything else
     * The clamp keeps an absurd declared size inside its own band rather than
     * letting it fall through into a later one.
     */
    const KEY_PIXELS = 128;
    let score: number;
    if (largest >= KEY_PIXELS) score = Math.min(largest, 9000);
    else if (largest > 0) score = 10000 - largest;
    else score = tokens.includes('apple-touch-icon') ? 20000 : 30000;

    candidates.push({ href, score });
  }

  return candidates.sort((a, b) => a.score - b.score);
}

function toDataUri(body: Buffer, mime: string): string {
  return `data:${mime};base64,${body.toString('base64')}`;
}

function accept(body: Buffer, sourceUrl: string): IconResolveResult {
  const mime = sniffMime(body);
  // Content-Type is not trusted: a large share of /favicon.ico responses are
  // actually PNG, and vice versa.
  if (!mime) return { ok: false, reason: 'unsupported_image' };

  if (body.length > MAX_RESPONSE_BYTES) return { ok: false, reason: 'image_too_large' };

  /**
   * Every accepted format is checked, not only PNG. A 2 KB JPEG declaring
   * 65535x65535, or an ICO whose entry holds a PNG declaring the same, reaches
   * the host's decoder and the panel's browser exactly like a PNG would.
   *
   * Unreadable dimensions are a REFUSAL, not a pass. All four accepted formats
   * carry their size in a header, so a file whose header cannot be read is
   * either malformed or crafted to defeat this check while a more lenient
   * decoder still resyncs and honours the real value. Real sites are unaffected
   * — and a site with one odd icon still has its remaining candidates and
   * /favicon.ico to fall back on.
   */
  const dims = imageDimensions(body, mime);
  if (!dims) return { ok: false, reason: 'unsupported_image' };
  if (dims.width > MAX_ICON_DIMENSION || dims.height > MAX_ICON_DIMENSION) {
    return { ok: false, reason: 'image_too_large' };
  }
  if (dims.width <= 0 || dims.height <= 0) return { ok: false, reason: 'unsupported_image' };

  return { ok: true, icon: { dataUri: toDataUri(body, mime), sourceUrl, mime, bytes: body.length } };
}

export type Getter = typeof safeGet;

/**
 * Discover and fetch a site's icon.
 *
 * Declared icons first, because /favicon.ico is conventional rather than
 * required and skews to 16-32px, which looks poor on a key. /favicon.ico
 * remains the fallback — and is all some sites offer.
 */
export async function resolveSiteIcon(origin: string, get: Getter = safeGet): Promise<IconResolveResult> {
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  const hrefs: string[] = [];

  try {
    // Truncate rather than fail: many homepages exceed any sane cap, and the
    // <head> we need sits at the very start.
    const page = await get(origin, {
      maxBytes: MAX_HTML_BYTES,
      allowTruncation: true,
      totalTimeoutMs: remaining(),
    });
    if (page.status >= 200 && page.status < 300) {
      const html = page.body.toString('utf8');
      for (const candidate of rankIconCandidates(html)) {
        try {
          hrefs.push(new URL(candidate.href, page.finalUrl).toString());
        } catch (e) {
          // A malformed href is simply not a candidate.
        }
      }
    }
  } catch (e) {
    // The site may refuse the HTML fetch and still serve /favicon.ico.
  }

  try {
    hrefs.push(new URL('/favicon.ico', origin).toString());
  } catch (e) {
    return { ok: false, reason: 'no_candidates' };
  }

  /**
   * The most specific reason any candidate gave. Without this, a refusal as
   * precise as "declares 30000x30000" is reported as the generic
   * "unsupported_image", which is misleading in diagnostics.
   */
  let refusal: IconResolveFailure | null = null;

  for (const href of hrefs.slice(0, MAX_CANDIDATES)) {
    if (remaining() <= 0) break;

    /**
     * Judge the candidate BEFORE requesting it. A page is free to declare an
     * ineligible href, and that is its own problem, not a redirect attack — so
     * it must skip to the next candidate rather than abandoning the site. That
     * distinction is only possible if a policy refusal from `get` below can
     * mean one thing: a redirect went somewhere it should not.
     */
    try {
      if (hopPolicyFailure(new URL(href))) continue;
    } catch (e) {
      continue;
    }

    try {
      // An image is useless partial, so no truncation here.
      const response = await get(href, { totalTimeoutMs: remaining() });
      if (response.status < 200 || response.status >= 300) continue;
      const result = accept(response.body, response.finalUrl);
      if (result.ok) return result;
      refusal = result.reason;
    } catch (e) {
      if (e instanceof IconFetchError && (e.reason === 'blocked_host' || e.reason === 'blocked_address')) {
        // The candidate itself was eligible, so this can only be a redirect
        // into somewhere it should not go. That ends the attempt.
        return { ok: false, reason: 'fetch_failed' };
      }
    }
  }

  return { ok: false, reason: refusal ?? 'fetch_failed' };
}
