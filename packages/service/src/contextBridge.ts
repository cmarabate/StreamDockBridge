import {
  ContextChannel,
  ContextChannelStore,
  ContextRecord,
  ProjectContext,
  SourceState,
  contextChannels,
} from './contextChannels';

export const CONTEXTBRIDGE_SNAPSHOT_VERSION = 'contextbridge-snapshot-1' as const;

export interface ContextBridgeOwner {
  browserInstanceId: string;
  browserFamily: string;
  displayName: string;
  mode: SourceState['mode'];
  connectionGeneration: number;
}

export interface ContextBridgeChannelSnapshot<T> {
  owner: ContextBridgeOwner;
  tabId: number;
  windowId: number;
  observedAt: number;
  ageMs: number;
  fresh: true;
  value: T;
}

export interface ContextBridgeSnapshotV1 {
  contractVersion: typeof CONTEXTBRIDGE_SNAPSHOT_VERSION;
  readAt: number;
  channels: {
    media: ContextBridgeChannelSnapshot<ContextRecord> | null;
    page: ContextBridgeChannelSnapshot<ContextRecord> | null;
    project: ContextBridgeChannelSnapshot<ProjectContext> | null;
  };
}

function ownerFor(
  sources: SourceState[],
  browserInstanceId: string
): ContextBridgeOwner | null {
  const source = sources.find((candidate) => candidate.browserInstanceId === browserInstanceId);
  if (!source || !source.connected) return null;
  return {
    browserInstanceId: source.browserInstanceId,
    browserFamily: source.browserFamily,
    displayName: source.displayName,
    mode: source.mode,
    connectionGeneration: source.connectionGeneration,
  };
}

/**
 * Versioned read-only projection over the existing ContextChannelStore.
 *
 * ContextBridge is a logical boundary, not a second store. Every channel is read
 * against the same `readAt`, so TTL expiry and age calculations cannot disagree
 * within one snapshot. MEDIA uses the store's production media projection (and
 * therefore the VoiceMediaBridge/GSMTC overlay when configured); PAGE and
 * PROJECT expose the already-arbitrated channel payloads.
 */
export function buildContextBridgeSnapshot(
  store: ContextChannelStore = contextChannels,
  readAt = Date.now()
): ContextBridgeSnapshotV1 {
  const sources = store.listSources(readAt);

  const describe = <T>(channel: ContextChannel, value: T | null): ContextBridgeChannelSnapshot<T> | null => {
    const state = store.get(channel, readAt);
    if (!state || value === null) return null;
    const owner = ownerFor(sources, state.browserInstanceId);
    if (!owner) return null;
    return {
      owner,
      tabId: state.tabId,
      windowId: state.windowId,
      observedAt: state.observedAt,
      ageMs: Math.max(0, readAt - state.observedAt),
      fresh: true,
      value,
    };
  };

  const media = store.getRecord('media', readAt);
  const pageState = store.get('page', readAt);
  const projectState = store.get('project', readAt);

  return {
    contractVersion: CONTEXTBRIDGE_SNAPSHOT_VERSION,
    readAt,
    channels: {
      media: describe('media', media),
      page: describe(
        'page',
        pageState ? (pageState.payload as ContextRecord) : null
      ),
      project: describe(
        'project',
        projectState ? (projectState.payload as ProjectContext) : null
      ),
    },
  };
}
