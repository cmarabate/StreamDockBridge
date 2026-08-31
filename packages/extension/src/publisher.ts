import { BrowserRole, channelsFor } from './browserRole';

/**
 * Turning what a browser sees into observations the service can arbitrate.
 *
 * Split out from the background worker so the decisions — which channel, which
 * sequence, whether to publish at all — are testable without a browser or a
 * network.
 */

export type Channel = 'media' | 'page' | 'project';

export interface PagePayload {
  url: string;
  hostname: string;
  rawTitle: string;
  documentTitle: string;
  ogTitle?: string;
  twitterTitle?: string;
  jsonLdTitle?: string;
  jsonLdSeriesTitle?: string;
  tabId: number;
  windowId: number;
}

export interface ProjectPayload {
  projectKey: string | null;
  projectName: string;
  evidence: string;
  githubOwner?: string;
  githubRepo?: string;
}

export interface Envelope {
  source: {
    browserInstanceId: string;
    browserFamily: string;
    displayName: string;
    mode: string;
    connectionGeneration: number;
  };
  channel: Channel;
  observationSequence: number;
  release?: boolean;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * A monotonic counter for one browser installation.
 *
 * Only ever increases within a connection generation; the generation is what
 * distinguishes a fresh worker whose counter restarted from a replayed message
 * belonging to a worker that has since died.
 */
export class SequenceCounter {
  private value = 0;
  next(): number {
    return ++this.value;
  }
  peek(): number {
    return this.value;
  }
}

/**
 * Build the body for one observation.
 *
 * `release` publishes the ABSENCE of something, which is how a work browser
 * says "the page I am on proves no project". It carries no payload precisely so
 * it cannot be confused with an empty one.
 */
export function buildEnvelope(
  role: BrowserRole,
  channel: Channel,
  sequence: number,
  payload: PagePayload | ProjectPayload | null,
  now: number
): Envelope | null {
  if (!channelsFor(role.mode).includes(channel)) return null;

  const envelope: Envelope = {
    source: {
      browserInstanceId: role.browserInstanceId,
      browserFamily: role.browserFamily,
      displayName: role.displayName,
      mode: role.mode,
      connectionGeneration: role.connectionGeneration,
    },
    channel,
    observationSequence: sequence,
    timestamp: now,
  };

  if (payload === null) {
    envelope.release = true;
    return envelope;
  }

  if (channel === 'project') {
    envelope.project = payload as ProjectPayload;
    // The service reads tab/window from the top level for every channel.
    envelope.tabId = 0;
    envelope.windowId = 0;
    return envelope;
  }

  Object.assign(envelope, payload as PagePayload);
  return envelope;
}

/** Whether this installation should publish anything at all right now. */
export function shouldPublish(role: BrowserRole, channel: Channel): boolean {
  return channelsFor(role.mode).includes(channel);
}
