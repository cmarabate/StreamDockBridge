import { PLACEHOLDERS, MAX_TEMPLATE_LENGTH } from './urlTemplate';

/**
 * Deriving the website a Context URL template points at.
 *
 * Pure and network-free. The icon a key shows is a property of the configured
 * SITE, not of whatever is currently playing, so this must be answerable from
 * the template alone — that is what stops a title change from triggering a
 * fetch.
 */

/** A template whose authority contains a placeholder has no knowable host. */
export interface SiteOrigin {
  /** Lowercased hostname, e.g. `www.rottentomatoes.com`. */
  hostname: string;
  /** Scheme + host (+ non-default port), the cache key and fetch base. */
  origin: string;
}

export type OriginResult =
  | { ok: true; site: SiteOrigin }
  | { ok: false; reason: 'dynamic_host' | 'unsupported_scheme' | 'invalid_template' };

/**
 * Placeholders are substituted with a harmless token so a template that is only
 * dynamic in its path or query still yields a stable host. A token that is
 * valid in a hostname is used deliberately: if the authority itself contains a
 * placeholder, the parse still succeeds and we detect it by comparing hosts
 * across two different tokens rather than by guessing at the syntax.
 */
const PROBE_A = 'aaaaaaaa';
const PROBE_B = 'bbbbbbbb';

function substituteAll(template: string, token: string): string {
  return template.replace(/\{([^{}]*)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    return (PLACEHOLDERS as readonly string[]).includes(name) ? token : '';
  });
}

export function deriveSiteOrigin(template: string): OriginResult {
  if (typeof template !== 'string' || !template.trim()) {
    return { ok: false, reason: 'invalid_template' };
  }

  /**
   * The same ceiling the URL-template authority enforces. Checked here too,
   * because this function substitutes and parses the string twice and is
   * reachable from a route that does not go through that authority.
   */
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return { ok: false, reason: 'invalid_template' };
  }

  let a: URL;
  let b: URL;
  try {
    a = new URL(substituteAll(template, PROBE_A));
    b = new URL(substituteAll(template, PROBE_B));
  } catch (e) {
    return { ok: false, reason: 'invalid_template' };
  }

  if (a.protocol !== 'http:' && a.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  /**
   * Two different substitutions producing two different authorities means the
   * host depends on runtime context. Fetching that would be discovery against
   * a target we cannot vet in advance, so it is refused outright rather than
   * guessed at.
   */
  if (a.host !== b.host || a.protocol !== b.protocol) {
    return { ok: false, reason: 'dynamic_host' };
  }

  if (!a.hostname) return { ok: false, reason: 'invalid_template' };

  // Credentials would travel with any request made against this origin.
  if (a.username || a.password) return { ok: false, reason: 'invalid_template' };

  return {
    ok: true,
    site: { hostname: a.hostname.toLowerCase(), origin: a.origin },
  };
}
