import { ContextRecord } from './contextStore';
import { deriveCanonicalTitle } from './titleCleaner';
import { VoiceMediaContextSnapshot } from './voiceMediaContext';

export type ContextChannel = 'media' | 'page' | 'project';

export const CONTEXT_CHANNELS: ContextChannel[] = ['media', 'page', 'project'];

export type BrowserMode = 'MEDIA_BROWSER' | 'WORK_BROWSER' | 'HYBRID' | 'DISABLED';

export const BROWSER_MODES: BrowserMode[] = [
  'MEDIA_BROWSER',
  'WORK_BROWSER',
  'HYBRID',
  'DISABLED',
];

export function channelsFor(mode: BrowserMode): ContextChannel[] {
  switch (mode) {
    case 'MEDIA_BROWSER':
      return ['media'];
    case 'WORK_BROWSER':
      return ['page', 'project'];
    case 'HYBRID':
      return ['media', 'page', 'project'];
    case 'DISABLED':
    default:
      return [];
  }
}

export function mayPublish(mode: BrowserMode, channel: ContextChannel): boolean {
  return channelsFor(mode).includes(channel);
}

export function isDedicatedTo(mode: BrowserMode, channel: ContextChannel): boolean {
  if (mode === 'MEDIA_BROWSER') return channel === 'media';
  if (mode === 'WORK_BROWSER') return channel === 'page' || channel === 'project';
  return false;
}

export interface SourceIdentity {
  browserInstanceId: string;
  browserFamily: string;
  displayName: string;
  mode: BrowserMode;
  connectionGeneration: number;
}

export interface ProjectContext {
  projectKey: string | null;
  projectName: string;
  localRepoPath?: string | null;
  githubRepo?: string | null;
  githubOwner?: string | null;
  githubRepoName?: string | null;
  vercelTeam?: string;
  vercelProject?: string;
  supabaseProjectRef?: string;
  projectDomain?: string;
  evidence: string;
}

export type ChannelPayload = ContextRecord | ProjectContext;

export interface Observation {
  source: SourceIdentity;
  channel: ContextChannel;
  payload: ChannelPayload | null;
  tabId: number;
  windowId: number;
  observationSequence: number;
  observedAt: number;
}

export interface ChannelState {
  payload: ChannelPayload;
  browserInstanceId: string;
  connectionGeneration: number;
  observationSequence: number;
  tabId: number;
  windowId: number;
  observedAt: number;
}

export interface SourceState extends SourceIdentity {
  lastSeen: number;
  connected: boolean;
}

export type ObserveResult =
  | { accepted: true; channel: ContextChannel; released: boolean }
  | {
      accepted: false;
      reason:
        | 'mode_forbids_channel'
        | 'stale_connection'
        | 'stale_observation'
        | 'not_owner'
        | 'lost_arbitration';
    };

export const SOURCE_TTL_MS = 90_000;

export type SystemMediaContextReader = (now?: number) => VoiceMediaContextSnapshot | null;

function normalizeSourceLabel(value: string): string {
  return value.trim().toLowerCase();
}

export class ContextChannelStore {
  private sources = new Map<string, SourceState>();
  private channels = new Map<ContextChannel, ChannelState>();

  /**
   * The authoritative system-media reader is deliberately opt-in.
   *
   * Pure channel stores, unit tests, and server-library consumers retain raw
   * browser observations. The shipped StreamDockBridge service enables the
   * VoiceMediaBridge/GSMTC overlay explicitly from index.ts. This prevents a
   * missing local native host from silently changing the semantics of every
   * in-memory ContextChannelStore while still making production media lookups
   * fail closed when GSMTC cannot prove media identity.
   */
  constructor(private systemMediaContext: SystemMediaContextReader | null = null) {}

  setSystemMediaContextReader(reader: SystemMediaContextReader | null): void {
    this.systemMediaContext = reader;
  }

  registerSource(identity: SourceIdentity, now = Date.now()): boolean {
    const known = this.sources.get(identity.browserInstanceId);
    if (known && identity.connectionGeneration < known.connectionGeneration) return false;

    if (known && identity.connectionGeneration > known.connectionGeneration) {
      for (const channel of CONTEXT_CHANNELS) {
        const state = this.channels.get(channel);
        if (
          state?.browserInstanceId === identity.browserInstanceId &&
          state.connectionGeneration < identity.connectionGeneration
        ) {
          this.channels.delete(channel);
        }
      }
    }

    this.sources.set(identity.browserInstanceId, {
      ...identity,
      lastSeen: now,
      connected: true,
    });

    for (const channel of CONTEXT_CHANNELS) {
      const state = this.channels.get(channel);
      if (!state || state.browserInstanceId !== identity.browserInstanceId) continue;
      if (!mayPublish(identity.mode, channel)) this.channels.delete(channel);
    }

    return true;
  }

  observe(observation: Observation, now = Date.now()): ObserveResult {
    const { source, channel } = observation;

    if (!mayPublish(source.mode, channel)) {
      this.registerSource(source, now);
      return { accepted: false, reason: 'mode_forbids_channel' };
    }

    const known = this.sources.get(source.browserInstanceId);
    if (known && source.connectionGeneration < known.connectionGeneration) {
      return { accepted: false, reason: 'stale_connection' };
    }

    this.registerSource(source, now);

    const current = this.channels.get(channel);

    if (current && current.browserInstanceId === source.browserInstanceId) {
      if (
        current.connectionGeneration === source.connectionGeneration &&
        observation.observationSequence <= current.observationSequence
      ) {
        return { accepted: false, reason: 'stale_observation' };
      }
    } else if (current) {
      if (observation.payload === null) {
        return { accepted: false, reason: 'not_owner' };
      }
      if (!this.canTakeOver(current, observation, now)) {
        return { accepted: false, reason: 'lost_arbitration' };
      }
    }

    if (observation.payload === null) {
      this.channels.delete(channel);
      return { accepted: true, channel, released: true };
    }

    this.channels.set(channel, {
      payload: observation.payload,
      browserInstanceId: source.browserInstanceId,
      connectionGeneration: source.connectionGeneration,
      observationSequence: observation.observationSequence,
      tabId: observation.tabId,
      windowId: observation.windowId,
      observedAt: observation.observedAt,
    });

    return { accepted: true, channel, released: false };
  }

  private canTakeOver(current: ChannelState, observation: Observation, now: number): boolean {
    const owner = this.sources.get(current.browserInstanceId);
    if (!owner || !owner.connected || now - owner.lastSeen > SOURCE_TTL_MS) return true;

    const challengerDedicated = isDedicatedTo(observation.source.mode, observation.channel);
    const ownerDedicated = isDedicatedTo(owner.mode, observation.channel);
    if (challengerDedicated !== ownerDedicated) return challengerDedicated;

    if (!challengerDedicated) return false;

    if (observation.observedAt > current.observedAt) return true;
    if (observation.observedAt < current.observedAt) return false;

    return observation.source.browserInstanceId > current.browserInstanceId;
  }

  disconnect(browserInstanceId: string): void {
    const source = this.sources.get(browserInstanceId);
    if (source) source.connected = false;
    for (const channel of CONTEXT_CHANNELS) {
      const state = this.channels.get(channel);
      if (state && state.browserInstanceId === browserInstanceId) this.channels.delete(channel);
    }
  }

  private expire(now: number): void {
    for (const channel of CONTEXT_CHANNELS) {
      const state = this.channels.get(channel);
      if (!state) continue;
      const owner = this.sources.get(state.browserInstanceId);
      if (!owner || !owner.connected || now - owner.lastSeen > SOURCE_TTL_MS) {
        this.channels.delete(channel);
      }
    }
  }

  get(channel: ContextChannel, now = Date.now()): ChannelState | null {
    this.expire(now);
    return this.channels.get(channel) ?? null;
  }

  /** Browser URL/tab/window projection without system-media enrichment. */
  getBrowserRecord(channel: 'media' | 'page', now = Date.now()): ContextRecord | null {
    const state = this.get(channel, now);
    return state ? (state.payload as ContextRecord) : null;
  }

  getRecord(channel: 'media' | 'page', now = Date.now()): ContextRecord | null {
    const state = this.get(channel, now);
    if (!state) return null;

    const record = state.payload as ContextRecord;
    if (channel !== 'media' || !this.systemMediaContext) return record;

    /**
     * In the shipped service, VoiceMediaBridge/GSMTC is the sole authority for
     * media identity and playback state. Browser media observations contribute
     * URL/tab/window context only. If VMB cannot prove media for the same browser
     * owner, media searches fail closed rather than using site chrome as a title.
     */
    const systemMedia = this.systemMediaContext(now);
    const owner = this.sources.get(state.browserInstanceId);
    const sourceMatchesOwner =
      !!systemMedia &&
      !!owner &&
      [owner.browserFamily, owner.displayName]
        .map(normalizeSourceLabel)
        .includes(normalizeSourceLabel(systemMedia.source));

    if (!systemMedia?.title || !sourceMatchesOwner) {
      return {
        ...record,
        rawTitle: '',
        documentTitle: '',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        canonicalTitle: '',
        playbackState: undefined,
      };
    }

    const canonicalTitle = deriveCanonicalTitle({
      documentTitle: systemMedia.title,
      rawTitle: systemMedia.title,
    });

    if (!canonicalTitle) {
      return {
        ...record,
        rawTitle: '',
        documentTitle: '',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        canonicalTitle: '',
        playbackState: systemMedia.playbackState,
      };
    }

    return {
      ...record,
      rawTitle: systemMedia.title,
      documentTitle: systemMedia.title,
      ogTitle: '',
      twitterTitle: '',
      jsonLdTitle: '',
      jsonLdSeriesTitle: '',
      canonicalTitle,
      playbackState: systemMedia.playbackState,
    };
  }

  getProject(now = Date.now()): ProjectContext | null {
    const state = this.get('project', now);
    return state ? (state.payload as ProjectContext) : null;
  }

  listSources(now = Date.now()): SourceState[] {
    const out: SourceState[] = [];
    for (const source of this.sources.values()) {
      out.push({
        ...source,
        connected: source.connected && now - source.lastSeen <= SOURCE_TTL_MS,
      });
    }
    return out.sort((a, b) => a.browserInstanceId.localeCompare(b.browserInstanceId));
  }

  clear(): void {
    this.sources.clear();
    this.channels.clear();
  }
}

export const contextChannels = new ContextChannelStore();
