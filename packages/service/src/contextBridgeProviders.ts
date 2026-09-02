/**
 * Provider evidence: what a page's own URL proves about the scope it is in.
 *
 * This module answers exactly one question — "does the address bar itself
 * establish that the browser is inside a provider-side scope, and if so which
 * one?" — and it answers it from the URL and nothing else.
 *
 * It deliberately does NOT resolve project identity. The external identifiers
 * returned here belong to the provider (OpenAI), are reported verbatim, and
 * are evidence for a downstream identity authority to consider. Nothing in this
 * file may be promoted to an AgentOS `registryKey`, and nothing here reads the
 * local filesystem, a registry, or any name/alias table.
 */

/** Hosts whose URLs this module knows how to read. */
const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

/**
 * The only path shape that proves ChatGPT project scope.
 *
 * `/g/g-p-<hex>[-<slug>]/...`. The sibling shape `/g/g-<id>-<slug>` is a custom
 * GPT, not a project, and must not match — hence `g-p-` rather than `g-`.
 */
const CHATGPT_PROJECT_SEGMENT = /^g-p-([0-9a-f]{4,})(?:-(.*))?$/i;

/** A ChatGPT conversation id is a UUID. Anything else is not safely established. */
const CHATGPT_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nothing observed from a URL is allowed to be unbounded in a snapshot. */
const MAX_SEGMENT_LENGTH = 256;
const MAX_PATH_LENGTH = 512;
const MAX_URL_LENGTH = 8_192;

export interface ChatGptProjectEvidenceV1 {
  provider: 'chatgpt';
  scope: 'project';
  /**
   * The whole `g-p-...` path segment, byte-for-byte as the browser showed it.
   *
   * It is an OpenAI-side identifier. It is not a project key, not a name, and
   * not a slug to be matched against anything.
   */
  externalProjectId: string;
  /** The slug half of the segment, verbatim and un-prettified, or null. */
  projectDisplayLabel: string | null;
  /** Only when the URL itself carried a well-formed conversation id. */
  conversationId: string | null;
  evidence: {
    proof: 'chatgpt-project-url-path';
    matchedPathSegment: string;
    labelSource: 'chatgpt-project-url-slug' | null;
    conversationSource: 'chatgpt-project-conversation-url-path' | null;
  };
}

export interface ChatGptConversationEvidenceV1 {
  provider: 'chatgpt';
  scope: 'conversation';
  conversationId: string;
  evidence: {
    proof: 'chatgpt-conversation-url-path';
    matchedPathSegment: string;
  };
}

/**
 * On ChatGPT, demonstrably not in a project.
 *
 * This is a positive finding, not an absence. It is what stops a page whose
 * TITLE looks like a project name from being read as ambiguous: the URL proves
 * the browser is on ChatGPT and proves it is not in a project scope.
 */
export interface ChatGptUnscopedEvidenceV1 {
  provider: 'chatgpt';
  scope: 'none';
  evidence: {
    proof: 'chatgpt-host-without-project-path';
    observedPath: string;
  };
}

export type ProviderContextV1 =
  | ChatGptProjectEvidenceV1
  | ChatGptConversationEvidenceV1
  | ChatGptUnscopedEvidenceV1;

function bound(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function normalizeHost(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Provider evidence for a URL, or null when the URL proves nothing.
 *
 * Never throws: a malformed, hostile, or absurdly long URL is simply an address
 * that establishes nothing, which is the same answer as an ordinary page.
 */
export function readProviderContext(url: unknown): ProviderContextV1 | null {
  if (typeof url !== 'string' || !url || url.length > MAX_URL_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!CHATGPT_HOSTS.has(normalizeHost(parsed.hostname))) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const observedPath = bound(parsed.pathname, MAX_PATH_LENGTH);

  const unscoped: ChatGptUnscopedEvidenceV1 = {
    provider: 'chatgpt',
    scope: 'none',
    evidence: { proof: 'chatgpt-host-without-project-path', observedPath },
  };

  if (segments[0] === 'g' && segments[1] && segments[1].length <= MAX_SEGMENT_LENGTH) {
    const match = CHATGPT_PROJECT_SEGMENT.exec(segments[1]);
    if (!match) return unscoped;

    const slug = match[2] ? bound(match[2], MAX_SEGMENT_LENGTH) : null;

    /**
     * A conversation id is read only from `/g/<project>/c/<uuid>`, and only
     * when it is actually UUID-shaped. A conversation the URL does not
     * establish stays null rather than becoming a guess.
     */
    const hasConversation =
      segments[2] === 'c' && !!segments[3] && CHATGPT_CONVERSATION_ID.test(segments[3]);

    return {
      provider: 'chatgpt',
      scope: 'project',
      externalProjectId: segments[1],
      projectDisplayLabel: slug,
      conversationId: hasConversation ? segments[3] : null,
      evidence: {
        proof: 'chatgpt-project-url-path',
        matchedPathSegment: segments[1],
        labelSource: slug ? 'chatgpt-project-url-slug' : null,
        conversationSource: hasConversation
          ? 'chatgpt-project-conversation-url-path'
          : null,
      },
    };
  }

  if (segments[0] === 'c' && segments[1] && CHATGPT_CONVERSATION_ID.test(segments[1])) {
    return {
      provider: 'chatgpt',
      scope: 'conversation',
      conversationId: segments[1],
      evidence: {
        proof: 'chatgpt-conversation-url-path',
        matchedPathSegment: segments[1],
      },
    };
  }

  return unscoped;
}
