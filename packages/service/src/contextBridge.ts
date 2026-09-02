import {
  BrowserMode,
  ContextChannelStore,
  SourceState,
  SOURCE_TTL_MS,
  contextChannels,
} from './contextChannels';
import { ContextRecord } from './contextStore';
import { ProviderContextV1, readProviderContext } from './contextBridgeProviders';

/**
 * ContextBridge: the read-only evidence boundary.
 *
 * ContextBridge is a logical boundary inside StreamDockBridge, not a second
 * store, process, port or registry. It projects the existing
 * `ContextChannelStore` — which already owns generation fencing, monotonic
 * sequence, TTL expiry, arbitration and owner-only release — into one versioned
 * snapshot whose whole content was read at a single instant.
 *
 * What it publishes is EVIDENCE: which browser said what, when, about which
 * page, and what that page's own URL proves about provider-side scope. It does
 * not resolve project identity, does not consult AgentOS, does not read the
 * filesystem, and nothing on this path imports `ProjectRegistryService`. An
 * `externalProjectId` here is an OpenAI-side identifier reported verbatim; it
 * is never an AgentOS `registryKey`.
 */

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 'contextbridge.snapshot.v1' as const;

/** The channels whose payload is a browser page observation. */
export type ContextEvidenceChannel = 'media' | 'page';

export const CONTEXT_EVIDENCE_CHANNELS: ContextEvidenceChannel[] = ['media', 'page'];

/**
 * Who published this observation.
 *
 * `role` is the browser's declared publication role (its channel mode). It says
 * what that browser is allowed to publish — not that its window is in front.
 * ContextBridge makes no claim about OS foreground or window handles.
 */
export interface ContextSourceV1 {
  sourceInstanceId: string;
  browserFamily: string;
  displayName: string;
  role: BrowserMode;
  connectionGeneration: number;
}

export interface ContextObservationV1 {
  /** The publisher's own monotonic counter, as accepted by the channel store. */
  sequence: number;
  observedAt: number;
  ageMs: number;
  ttlMs: number;
  /**
   * Always true. An owner past its TTL, disconnected, or fenced out by a newer
   * connection generation is omitted from the snapshot entirely rather than
   * being presented as stale-but-present.
   */
  fresh: true;
}

/** Bounded page metadata. No page body, history, cookies or credentials. */
export interface ContextPageV1 {
  url: string;
  hostname: string;
  rawTitle: string;
  documentTitle: string;
  tabId: number;
  windowId: number;
}

export interface ContextEvidenceV1 {
  source: ContextSourceV1;
  observation: ContextObservationV1;
  page: ContextPageV1;
  /** What the page's URL proves about provider scope, or null when nothing. */
  providerContext: ProviderContextV1 | null;
}

export interface ContextSnapshotV1 {
  schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  /** One read instant for the entire snapshot, so ages cannot disagree. */
  readAt: number;
  channels: Record<ContextEvidenceChannel, ContextEvidenceV1 | null>;
}

function sourceFor(sources: SourceState[], sourceInstanceId: string): ContextSourceV1 | null {
  const found = sources.find((candidate) => candidate.browserInstanceId === sourceInstanceId);
  if (!found || !found.connected) return null;
  return {
    sourceInstanceId: found.browserInstanceId,
    browserFamily: found.browserFamily,
    displayName: found.displayName,
    role: found.mode,
    connectionGeneration: found.connectionGeneration,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Build the versioned read-only snapshot.
 *
 * MEDIA is read through `getBrowserRecord`, not `getRecord`: the latter applies
 * the VoiceMediaBridge/GSMTC media-identity overlay, which is a media-authority
 * decision about what is playing. ContextBridge reports what the BROWSER
 * observed. VoiceMediaBridge remains the media identity/playback authority for
 * the media surfaces that consume it; ContextBridge does not restate its
 * verdict and does not regain media-control authority.
 */
export function buildContextSnapshotV1(
  store: ContextChannelStore = contextChannels,
  readAt = Date.now()
): ContextSnapshotV1 {
  const sources = store.listSources(readAt);

  const describe = (channel: ContextEvidenceChannel): ContextEvidenceV1 | null => {
    const state = store.get(channel, readAt);
    if (!state) return null;

    const source = sourceFor(sources, state.browserInstanceId);
    if (!source) return null;

    /**
     * Fencing, restated at read time rather than trusted.
     *
     * The store already drops a channel whose owner reconnected with a higher
     * generation, but a snapshot that silently attributed an old observation to
     * a new connection would be a lie about provenance, so it is checked here
     * too and the entry is omitted rather than mislabelled.
     */
    if (state.connectionGeneration !== source.connectionGeneration) return null;

    const record = store.getBrowserRecord(channel, readAt);
    if (!record) return null;

    return {
      source,
      observation: {
        sequence: state.observationSequence,
        observedAt: state.observedAt,
        ageMs: Math.max(0, readAt - state.observedAt),
        ttlMs: SOURCE_TTL_MS,
        fresh: true,
      },
      page: pageOf(record, state.tabId, state.windowId),
      providerContext: readProviderContext(record.url),
    };
  };

  return {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    readAt,
    channels: {
      media: describe('media'),
      page: describe('page'),
    },
  };
}

/**
 * The allowlist, written as a construction rather than a deletion.
 *
 * Only these fields leave the boundary. A field added to `ContextRecord` later
 * cannot leak into a snapshot by default — it has to be named here first.
 */
function pageOf(record: ContextRecord, tabId: number, windowId: number): ContextPageV1 {
  return {
    url: text(record.url),
    hostname: text(record.hostname),
    rawTitle: text(record.rawTitle),
    documentTitle: text(record.documentTitle),
    tabId: integer(tabId),
    windowId: integer(windowId),
  };
}

export type { ProviderContextV1 } from './contextBridgeProviders';
