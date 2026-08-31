import { ContextRecord } from './contextStore';

/**
 * The one URL-template authority.
 *
 * A template is literal text with `{placeholder}` slots. It is NOT an
 * expression language: there are no property paths, no function calls, no
 * conditionals, and no way to name anything outside the approved set below.
 * Everything this can produce is an http(s) URL handed to the browser.
 */

/** Approved placeholders. Anything else is a configuration error, never a pass-through. */
export const PLACEHOLDERS = [
  'title',
  'rawTitle',
  'url',
  'hostname',
  'projectName',
  'githubOwner',
  'githubRepo',
  'vercelTeam',
  'vercelProject',
  'supabaseProjectRef',
  'projectDomain',
] as const;
export type PlaceholderName = (typeof PLACEHOLDERS)[number];

export type PlaceholderValues = Partial<Record<PlaceholderName, string>>;

export interface ProjectInfoLike {
  projectName?: string;
  githubOwner?: string | null;
  githubRepoName?: string | null;
  githubRepo?: string | null;
  vercelTeam?: string;
  vercelProject?: string;
  supabaseProjectRef?: string;
  projectDomain?: string;
}

/** Templates come from user configuration, but bound the work regardless. */
export const MAX_TEMPLATE_LENGTH = 2000;
/** Browsers and servers stop respecting URLs well beyond this. */
export const MAX_RESOLVED_LENGTH = 4000;

export interface TemplateSuccess {
  ok: true;
  url: string;
}

export interface TemplateFailure {
  ok: false;
  error: string;
  /** HTTP status the bridge service should surface. */
  status: number;
}

export type TemplateResult = TemplateSuccess | TemplateFailure;

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

function fail(error: string, status = 400): TemplateFailure {
  return { ok: false, error, status };
}

/**
 * The values a template may reference, taken from the service's browser or project
 * context. Deliberately a projection rather than the whole record, so adding a
 * field to ContextRecord cannot silently widen what a template can read.
 */
export function placeholderValuesFrom(
  context?: ContextRecord | null,
  project?: ProjectInfoLike | null
): PlaceholderValues {
  let githubOwner = project?.githubOwner || '';
  let githubRepo = project?.githubRepoName || '';
  if (!githubOwner && !githubRepo && project?.githubRepo) {
    const parts = project.githubRepo.split('/');
    if (parts.length === 2) {
      githubOwner = parts[0];
      githubRepo = parts[1];
    }
  }

  return {
    title: context?.canonicalTitle || '',
    rawTitle: context?.rawTitle || '',
    url: context?.url || '',
    hostname: context?.hostname || '',
    projectName: project?.projectName || '',
    githubOwner: githubOwner || '',
    githubRepo: githubRepo || '',
    vercelTeam: project?.vercelTeam || '',
    vercelProject: project?.vercelProject || '',
    supabaseProjectRef: project?.supabaseProjectRef || '',
    projectDomain: project?.projectDomain || '',
  };
}

/**
 * Only http(s) reaches a browser, and only without embedded credentials.
 *
 * This is a navigation primitive: the service never fetches the URL, so the
 * risk is what the browser is told to open, not what the service requests.
 */
export function validateResolvedUrl(candidate: string): TemplateResult {
  if (candidate.length > MAX_RESOLVED_LENGTH) return fail('resolved_url_too_long');

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (e) {
    return fail('invalid_resolved_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // javascript:, data:, file:, chrome:, shell: and every other scheme.
    return fail('unsupported_scheme');
  }

  // Credentials would be handed to whatever the browser contacts.
  if (parsed.username || parsed.password) return fail('credentials_not_allowed');

  if (!parsed.hostname) return fail('invalid_resolved_url');

  /**
   * Return the NORMALIZED serialization, not the raw candidate.
   *
   * The browser is opened through `start "" "<url>"` on cmd, where `\"` is not
   * an escape — a double quote terminates the quoted argument. A template of
   * `https://example.com/?q="&&calc.exe&&"` parses as a valid URL, so returning
   * the raw string would hand cmd a broken-out command line. Normalizing
   * percent-encodes `"` (and space, `<`, `>`), which keeps the quoting intact.
   *
   * Normalization is NOT byte-transparent, and an earlier version of this
   * comment wrongly claimed it was. The WHATWG special-query encode set
   * includes the apostrophe, so a title like "Bob's Burgers" now yields
   * `q=Bob%27s%20Burgers` where it previously emitted a bare `'`. That is
   * semantically identical at every search engine and is accepted
   * deliberately; the normalized form is what actually gets opened, so
   * validating it is what makes the guarantee real.
   */
  const normalized = parsed.toString();

  // Unreachable given the above, but the launcher's safety depends on it.
  if (normalized.includes('"')) return fail('invalid_resolved_url');

  return { ok: true, url: normalized };
}

/**
 * Substitute approved placeholders and validate the result.
 *
 * Each value is percent-encoded on insertion, so a title containing `&`, `?`,
 * `#` or a space cannot alter the shape of the URL the template describes.
 * Literal text in the template is left exactly as written — that is how
 * `?q={title}+trailer` keeps its `+` as a literal separator.
 */
export function resolveUrlTemplate(template: string, values: PlaceholderValues): TemplateResult {
  if (typeof template !== 'string' || !template.trim()) return fail('empty_template');
  if (template.length > MAX_TEMPLATE_LENGTH) return fail('template_too_long');

  let unknown: string | null = null;
  let missing: string | null = null;
  let badValue: string | null = null;

  const resolved = template.replace(PLACEHOLDER_RE, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!PLACEHOLDERS.includes(name as PlaceholderName)) {
      // An unrecognized placeholder is a configuration mistake. Passing it
      // through would silently send `{foo}` to the search engine.
      if (!unknown) unknown = name;
      return '';
    }
    const value = values[name as PlaceholderName];
    if (!value) {
      if (!missing) missing = name;
      return '';
    }
    try {
      return encodeURIComponent(value);
    } catch (e) {
      // encodeURIComponent throws URIError on a lone surrogate, and a page can
      // put one in its <title>. Unguarded this killed the service through the
      // unauthenticated built-in lookup routes, taking every key on the deck
      // down with it.
      if (!badValue) badValue = name;
      return '';
    }
  });

  if (unknown !== null) return fail('unknown_placeholder');
  if (badValue !== null) return fail('unencodable_context_value');
  if (missing !== null) return fail('no_usable_context');

  // An unbalanced brace would otherwise reach the browser as literal text.
  if (/[{}]/.test(resolved)) return fail('malformed_template');

  return validateResolvedUrl(resolved);
}
