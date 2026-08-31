import { safeGet, IconFetchError, MAX_RESPONSE_BYTES, hopPolicyFailure } from './iconFetch';
import { imageDimensions } from './imageDimensions';
import { IconCandidate, orderCandidates, scoreActualDimensions, isExcellent } from './iconRank';

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

/**
 * How many candidates are actually downloaded before the best so far wins.
 *
 * Enough to get past a small favicon.ico to a real asset, few enough that a
 * hostile page cannot turn one key into a download run.
 */
export const MAX_CANDIDATES_FETCHED = 4;

/** A web app manifest is small JSON; anything larger is not one. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

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
  /** Actual pixels, so callers can report why an icon looks the way it does. */
  width: number;
  height: number;
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

/** The largest square size a tag declares, using the SMALLER side of each pair. */
function largestDeclaredSize(sizes: string): number {
  let largest = 0;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (match) largest = Math.max(largest, Math.min(Number(match[1]), Number(match[2])));
  }
  return largest;
}

/**
 * Collect declared icon candidates from a page's markup.
 *
 * Returns candidates with their DECLARED size only. Nothing is judged finally
 * here — the winner is decided from downloaded bytes, because `sizes` is
 * routinely absent (ReelGood declares a 120x120 icon with no `sizes` at all)
 * and routinely wrong.
 */
export function collectLinkCandidates(html: string): IconCandidate[] {
  const candidates: IconCandidate[] = [];

  for (const tag of extractLinkTags(html)) {
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1];
    if (!rel) continue;
    const tokens = rel.toLowerCase().split(/\s+/);
    const appleTouch =
      tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed');
    const isIcon = tokens.includes('icon') || appleTouch;
    // mask-icon and monochrome purposes are silhouettes; they render as blobs.
    if (!isIcon || tokens.includes('mask-icon')) continue;

    const href = (/\bhref\s*=\s*["']([^"']+)/i.exec(tag) || [])[1];
    if (!href) continue;

    const type = ((/\btype\s*=\s*["']?([^"'>\s]+)/i.exec(tag) || [])[1] || '').toLowerCase();
    if (type.includes('svg')) continue; // see the note on SVG above

    const sizes = ((/\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1] || '');
    candidates.push({
      href,
      declaredSize: largestDeclaredSize(sizes),
      source: appleTouch ? 'apple-touch' : 'link',
    });
  }

  return candidates;
}

/** The web app manifest URL a page declares, if any. */
export function manifestHref(html: string): string | null {
  for (const tag of extractLinkTags(html)) {
    const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1];
    if (!rel || !rel.toLowerCase().split(/\s+/).includes('manifest')) continue;
    const href = (/\bhref\s*=\s*["']([^"']+)/i.exec(tag) || [])[1];
    if (href) return href;
  }
  return null;
}

/**
 * Icons declared by a web app manifest.
 *
 * These are the assets a site chose for a home-screen tile, so they are square,
 * raster and usually 192px or better — very close to what a key wants.
 */
export function collectManifestCandidates(json: string): IconCandidate[] {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.icons)) return [];

  const candidates: IconCandidate[] = [];
  for (const icon of parsed.icons.slice(0, 40)) {
    if (!icon || typeof icon.src !== 'string' || !icon.src) continue;
    const type = typeof icon.type === 'string' ? icon.type.toLowerCase() : '';
    if (type.includes('svg')) continue;
    /**
     * A "maskable" asset carries a safe-zone margin and renders small and
     * padded inside a square, so it is only used when it also claims "any".
     */
    const purpose = typeof icon.purpose === 'string' ? icon.purpose.toLowerCase() : '';
    if (purpose && !purpose.split(/\s+/).includes('any')) continue;

    candidates.push({
      href: icon.src,
      declaredSize: typeof icon.sizes === 'string' ? largestDeclaredSize(icon.sizes) : 0,
      source: 'manifest',
    });
  }
  return candidates;
}

function toDataUri(body: Buffer, mime: string): string {
  return `data:${mime};base64,${body.toString('base64')}`;
}

type AcceptResult = { ok: true; icon: ResolvedIcon } | { ok: false; reason: IconResolveFailure };

function accept(body: Buffer, sourceUrl: string): AcceptResult {
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
   * decoder still resyncs and honours the real value.
   */
  const dims = imageDimensions(body, mime);
  if (!dims) return { ok: false, reason: 'unsupported_image' };
  if (dims.width > MAX_ICON_DIMENSION || dims.height > MAX_ICON_DIMENSION) {
    return { ok: false, reason: 'image_too_large' };
  }
  if (dims.width <= 0 || dims.height <= 0) return { ok: false, reason: 'unsupported_image' };

  return {
    ok: true,
    icon: {
      dataUri: toDataUri(body, mime),
      sourceUrl,
      mime,
      bytes: body.length,
      width: dims.width,
      height: dims.height,
    },
  };
}

export type Getter = typeof safeGet;

/** Absolute, policy-eligible URL for a candidate, or null. */
function eligibleUrl(href: string, base: string): string | null {
  let absolute: URL;
  try {
    absolute = new URL(href, base);
  } catch (e) {
    return null;
  }
  /**
   * Judged BEFORE it is requested. A page is free to declare an ineligible
   * href, and that is its own problem, not a redirect attack — so it must skip
   * to the next candidate. That distinction is only possible if a policy
   * refusal from `get` can mean one thing: a redirect went somewhere it should
   * not.
   */
  if (hopPolicyFailure(absolute)) return null;
  return absolute.toString();
}

/**
 * Discover and fetch the best icon a site offers.
 *
 * Candidates are ordered by what the page CLAIMS, then downloaded in that order
 * and scored on what actually arrived, keeping the best. Downloading stops
 * early once something ideal for the key turns up, so the common case still
 * costs a single image.
 */
export async function resolveSiteIcon(origin: string, get: Getter = safeGet): Promise<IconResolveResult> {
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  const candidates: IconCandidate[] = [];
  let base = origin;

  try {
    // Truncate rather than fail: many homepages exceed any sane cap, and the
    // <head> we need sits at the very start.
    const page = await get(origin, {
      maxBytes: MAX_HTML_BYTES,
      allowTruncation: true,
      totalTimeoutMs: remaining(),
    });

    /**
     * Deliberately NOT gated on a 2xx status.
     *
     * reelgood.com answers its own homepage with 403 while still serving a
     * complete <head> that declares a 120x120 icon. Discarding that markup is
     * what made it fall through to a 64x64 favicon.ico and look blurry on the
     * key. Nothing is trusted any more than before: every href harvested here
     * is still policy-checked before it is requested.
     */
    if (page.body.length > 0) {
      base = page.finalUrl;
      const html = page.body.toString('utf8');
      candidates.push(...collectLinkCandidates(html));

      const manifest = manifestHref(html);
      if (manifest && remaining() > 0) {
        const manifestUrl = eligibleUrl(manifest, base);
        if (manifestUrl) {
          try {
            const response = await get(manifestUrl, {
              maxBytes: MAX_MANIFEST_BYTES,
              totalTimeoutMs: remaining(),
            });
            if (response.status >= 200 && response.status < 300) {
              for (const candidate of collectManifestCandidates(response.body.toString('utf8'))) {
                // A manifest's srcs resolve against the manifest, not the page.
                const absolute = eligibleUrl(candidate.href, response.finalUrl);
                if (absolute) candidates.push({ ...candidate, href: absolute });
              }
            }
          } catch (e) {
            // A missing or hostile manifest is simply not a source of candidates.
          }
        }
      }
    }
  } catch (e) {
    // The site may refuse the HTML fetch and still serve /favicon.ico.
  }

  const ordered: IconCandidate[] = [];
  for (const candidate of orderCandidates(candidates)) {
    const absolute = eligibleUrl(candidate.href, base);
    if (absolute) ordered.push({ ...candidate, href: absolute });
  }

  /**
   * The conventional fallbacks resolve against the CONFIGURED origin, never the
   * post-redirect URL.
   *
   * A trusted site with an open redirect would otherwise hand its key art to
   * whoever the redirect lands on: `base` becomes the attacker's URL, and the
   * icon fetched from there gets cached under the trusted origin for 14 days.
   * A declared href is the site's own statement about itself and may still be
   * cross-origin; a guessed path must not be.
   */
  for (const href of ['/apple-touch-icon.png', '/favicon.ico']) {
    const absolute = eligibleUrl(href, origin);
    if (absolute && !ordered.some((c) => c.href === absolute)) {
      ordered.push({ href: absolute, declaredSize: 0, source: 'fallback' });
    }
  }
  if (ordered.length === 0) return { ok: false, reason: 'no_candidates' };

  let best: ResolvedIcon | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  /**
   * The most specific reason any candidate gave. Without this, a refusal as
   * precise as "declares 30000x30000" is reported as the generic
   * "unsupported_image", which is misleading in diagnostics.
   */
  let refusal: IconResolveFailure | null = null;
  let fetched = 0;

  for (const candidate of ordered) {
    if (fetched >= MAX_CANDIDATES_FETCHED || remaining() <= 0) break;

    let response;
    try {
      // An image is useless partial, so no truncation here.
      response = await get(candidate.href, { totalTimeoutMs: remaining() });
    } catch (e) {
      if (e instanceof IconFetchError && (e.reason === 'blocked_host' || e.reason === 'blocked_address')) {
        // The candidate itself was eligible, so this can only be a redirect
        // into somewhere it should not go. That ends the attempt.
        return { ok: false, reason: 'fetch_failed' };
      }
      fetched++;
      continue;
    }

    fetched++;
    if (response.status < 200 || response.status >= 300) continue;

    const result = accept(response.body, response.finalUrl);
    if (!result.ok) {
      refusal = result.reason;
      continue;
    }

    const score = scoreActualDimensions(result.icon.width, result.icon.height);
    if (score < bestScore) {
      bestScore = score;
      best = result.icon;
    }

    // Good enough that another download cannot meaningfully improve the key.
    if (isExcellent(result.icon.width, result.icon.height)) break;
  }

  if (best) return { ok: true, icon: best };
  return { ok: false, reason: refusal ?? 'fetch_failed' };
}
