import {
  BrowserMode,
  ContextChannelStore,
  ProjectContext,
  SourceIdentity,
  SOURCE_TTL_MS,
} from './contextChannels';
import { ContextRecord } from './contextStore';
import {
  buildContextBridgeSnapshot,
  CONTEXTBRIDGE_SNAPSHOT_VERSION,
} from './contextBridge';

function source(id: string, mode: BrowserMode): SourceIdentity {
  return {
    browserInstanceId: id,
    browserFamily: id.startsWith('brave') ? 'brave' : 'chrome',
    displayName: id,
    mode,
    connectionGeneration: 1,
  };
}

function page(title: string, url: string): ContextRecord {
  return {
    url,
    hostname: new URL(url).hostname,
    rawTitle: title,
    documentTitle: title,
    ogTitle: '',
    twitterTitle: '',
    jsonLdTitle: '',
    jsonLdSeriesTitle: '',
    canonicalTitle: title,
    tabId: 1,
    windowId: 2,
    timestamp: 1_000,
  };
}

describe('ContextBridge snapshot', () => {
  it('projects the existing channel store with one read time', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    const chrome = source('chrome-work', 'WORK_BROWSER');

    store.observe(
      {
        source: brave,
        channel: 'media',
        payload: page('Show', 'https://example.com/show'),
        tabId: 10,
        windowId: 20,
        observationSequence: 1,
        observedAt: 900,
      },
      900
    );
    store.observe(
      {
        source: chrome,
        channel: 'page',
        payload: page('Repo', 'https://github.com/cmarabate/StreamDockBridge'),
        tabId: 30,
        windowId: 40,
        observationSequence: 1,
        observedAt: 950,
      },
      950
    );

    const project: ProjectContext = {
      projectKey: 'streamdockbridge',
      projectName: 'StreamDockBridge',
      githubRepo: 'cmarabate/StreamDockBridge',
      evidence: 'github-repo:cmarabate/streamdockbridge',
    };
    store.observe(
      {
        source: chrome,
        channel: 'project',
        payload: project,
        tabId: 30,
        windowId: 40,
        observationSequence: 2,
        observedAt: 960,
      },
      960
    );

    const snapshot = buildContextBridgeSnapshot(store, 1_000);
    expect(snapshot.contractVersion).toBe(CONTEXTBRIDGE_SNAPSHOT_VERSION);
    expect(snapshot.readAt).toBe(1_000);
    expect(snapshot.channels.media?.owner.browserInstanceId).toBe('brave-media');
    expect(snapshot.channels.media?.ageMs).toBe(100);
    expect(snapshot.channels.page?.owner.browserInstanceId).toBe('chrome-work');
    expect(snapshot.channels.page?.ageMs).toBe(50);
    expect(snapshot.channels.project?.value.projectKey).toBe('streamdockbridge');
    expect(snapshot.channels.project?.ageMs).toBe(40);
    expect(snapshot.channels.media?.fresh).toBe(true);
    expect(snapshot.channels.page?.fresh).toBe(true);
    expect(snapshot.channels.project?.fresh).toBe(true);
  });

  it('omits expired channels rather than presenting stale context as fresh', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    store.observe(
      {
        source: brave,
        channel: 'media',
        payload: page('Show', 'https://example.com/show'),
        tabId: 1,
        windowId: 1,
        observationSequence: 1,
        observedAt: 1_000,
      },
      1_000
    );

    const snapshot = buildContextBridgeSnapshot(store, 1_000 + SOURCE_TTL_MS + 1);
    expect(snapshot.channels.media).toBeNull();
  });

  it('contains no secret or unrelated page-body surface', () => {
    const snapshot = buildContextBridgeSnapshot(new ContextChannelStore(), 5_000);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('secret');
    expect(encoded).not.toContain('cookie');
    expect(encoded).not.toContain('body');
  });
});
