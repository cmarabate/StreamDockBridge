import { ContextRecord } from './contextStore';

/**
 * Who is allowed to say what the user is currently looking at.
 *
 * The original model was a single global record, so whichever browser posted
 * last won. That worked while exactly one browser was installed and breaks the
 * moment a second one is: Brave's media selection and Chrome's work page would
 * overwrite each other continuously.
 *
 * So context is split into independent CHANNELS, each with its own owner. A
 * media observation can never disturb the page channel, and vice versa. Every
 * observation carries enough identity to be judged rather than simply believed.
 */

export type ContextChannel = 'media' | 'page' | 'project';

export const CONTEXT_CHANNELS: ContextChannel[] = ['media', 'page', 'project'];

/**
 * What a browser installation is for. Set per installation, so the same
 * extension package behaves differently in Brave and in Chrome.
 */
export type BrowserMode = 'MEDIA_BROWSER' | 'WORK_BROWSER' | 'HYBRID' | 'DISABLED';

export const BROWSER_MODES: BrowserMode[] = [
  'MEDIA_BROWSER',
  'WORK_BROWSER',
  'HYBRID',
  'DISABLED',
];

/** Which channels a mode is permitted to publish. */
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

/**
 * Whether this mode exists specifically to serve this channel.
 *
 * HYBRID publishes everything but is dedicated to nothing, so it yields to a
 * browser the owner has actually assigned the job.
 */
export function isDedicatedTo(mode: BrowserMode, channel: ContextChannel): boolean {
  if (mode === 'MEDIA_BROWSER') return channel === 'media';
  if (mode === 'WORK_BROWSER') return channel === 'page' || channel === 'project';
  return false;
}

/**
 * A browser installation.
 *
 * `browserInstanceId` is ROUTING identity, not authentication — it says which
 * installation an observation came from so channels can be kept apart. The
 * secret gate on POST /context is what actually authorizes the write, and that
 * is unchanged.
 */
export interface SourceIdentity {
  browserInstanceId: string;
  /** Descriptive only: brave, chrome, edge… Never used for routing. */
  browserFamily: string;
  displayName: string;
  mode: BrowserMode;
  /**
   * Bumped each time the extension's service worker starts. An observation
   * from an older generation is a message from a connection that no longer
   * exists, and is refused.
   */
  connectionGeneration: number;
}

export interface ProjectContext {
  /** AgentOS registryKey when identity resolved, else null. */
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
  /** What proved it, e.g. 'chatgpt-project' or 'github-url'. */
  evidence: string;
}

/** The payload a channel carries. Media and page carry a page record. */
export type ChannelPayload = ContextRecord | ProjectContext;

export interface Observation {
  source: SourceIdentity;
  channel: ContextChannel;
  /** null releases the channel: this source no longer has anything for it. */
  payload: ChannelPayload | null;
  tabId: number;
  windowId: number;
  /** Monotonic per source. Reordered or replayed observations are refused. */
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

/**
 * How long a silent source keeps its channels.
 *
 * A browser that exits without warning must not own a channel forever, but the
 * window has to be comfortably longer than the extension's own heartbeat or a
 * quiet browser would keep dropping and reclaiming its own channel.
 */
export const SOURCE_TTL_MS = 90_000;

export class ContextChannelStore {
  private sources = new Map<string, SourceState>();
  private channels = new Map<ContextChannel, ChannelState>();

  /**
   * Register or refresh a source.
   *
   * A HIGHER generation supersedes: the extension restarted, so anything still
   * in flight from before belongs to a dead connection.
   */
  registerSource(identity: SourceIdentity, now = Date.now()): boolean {
    const known = this.sources.get(identity.browserInstanceId);
    if (known && identity.connectionGeneration < known.connectionGeneration) return false;

    this.sources.set(identity.browserInstanceId, {
      ...identity,
      lastSeen: now,
      connected: true,
    });

    /**
     * A source that can no longer publish a channel must not keep owning it.
     * Switching a browser to DISABLED, or from HYBRID to MEDIA_BROWSER, has to
     * hand back what it is no longer entitled to.
     */
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
      // Still refresh liveness — the source is alive, just not for this channel.
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
      // Same source: sequence must advance, or this is a replay.
      if (current.connectionGeneration === source.connectionGeneration &&
          observation.observationSequence <= current.observationSequence) {
        return { accepted: false, reason: 'stale_observation' };
      }
    } else if (current) {
      // A different source holds the channel.
      if (observation.payload === null) {
        // Only the owner may release a channel.
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

  /**
   * Whether a challenger takes a channel from its current owner.
   *
   * Deterministic on purpose — never "whichever packet arrived last". The
   * intended setup (Brave media, Chrome work) never competes for a channel at
   * all; this exists so that when two sources DO claim one, the outcome is
   * predictable and does not flap.
   */
  private canTakeOver(current: ChannelState, observation: Observation, now: number): boolean {
    const owner = this.sources.get(current.browserInstanceId);

    // An owner that has gone quiet has forfeited the channel.
    if (!owner || !owner.connected || now - owner.lastSeen > SOURCE_TTL_MS) return true;

    /**
     * A browser configured FOR this channel outranks one that merely also does
     * it.
     *
     * The owner runs Brave as a dedicated media browser and Chrome for work. If
     * Chrome is left on the default HYBRID it competes for media, and with pure
     * recency it wins whenever it happens to be on a page with a video — so a
     * media key reads Chrome instead of Brave. Saying what a browser is for
     * should settle that, rather than whichever tab was touched last.
     */
    const challengerDedicated = isDedicatedTo(observation.source.mode, observation.channel);
    const ownerDedicated = isDedicatedTo(owner.mode, observation.channel);
    if (challengerDedicated !== ownerDedicated) return challengerDedicated;

    /**
     * Neither is dedicated — both are on the default HYBRID, which publishes
     * everything and is assigned to nothing.
     *
     * A general browser may CLAIM a free channel, which is what keeps a
     * single-browser setup working, but it may not TAKE one from a live owner.
     * Recency here would mean a second browser opening any page with a video
     * seizes media from the one actually playing something, which is the
     * original defect wearing a different hat. Whoever holds it keeps it until
     * they release it or go quiet.
     */
    if (!challengerDedicated) return false;

    // Between two dedicated browsers, the more recent user activity wins…
    if (observation.observedAt > current.observedAt) return true;
    if (observation.observedAt < current.observedAt) return false;

    // …and an exact tie is broken by id so the result never depends on timing.
    return observation.source.browserInstanceId > current.browserInstanceId;
  }

  /** Mark a source gone. Its channels are released immediately. */
  disconnect(browserInstanceId: string): void {
    const source = this.sources.get(browserInstanceId);
    if (source) source.connected = false;
    for (const channel of CONTEXT_CHANNELS) {
      const state = this.channels.get(channel);
      if (state && state.browserInstanceId === browserInstanceId) this.channels.delete(channel);
    }
  }

  /** Drop channels whose owner has gone silent. Called on every read. */
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

  getRecord(channel: 'media' | 'page', now = Date.now()): ContextRecord | null {
    const state = this.get(channel, now);
    return state ? (state.payload as ContextRecord) : null;
  }

  getProject(now = Date.now()): ProjectContext | null {
    const state = this.get('project', now);
    return state ? (state.payload as ProjectContext) : null;
  }

  listSources(now = Date.now()): SourceState[] {
    const out: SourceState[] = [];
    for (const source of this.sources.values()) {
      out.push({ ...source, connected: source.connected && now - source.lastSeen <= SOURCE_TTL_MS });
    }
    return out.sort((a, b) => a.browserInstanceId.localeCompare(b.browserInstanceId));
  }

  clear(): void {
    this.sources.clear();
    this.channels.clear();
  }
}

export const contextChannels = new ContextChannelStore();
