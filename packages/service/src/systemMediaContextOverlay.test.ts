import { ContextChannelStore, SourceIdentity } from './contextChannels';
import { ContextRecord } from './contextStore';

function mediaSource(): SourceIdentity {
  return {
    browserInstanceId: 'brave-media-test',
    browserFamily: 'brave',
    displayName: 'Brave',
    mode: 'MEDIA_BROWSER',
    connectionGeneration: 1,
  };
}

function record(title: string): ContextRecord {
  return {
    url: 'https://www.disneyplus.com/play/example',
    hostname: 'www.disneyplus.com',
    rawTitle: title,
    documentTitle: title,
    ogTitle: title,
    twitterTitle: '',
    jsonLdTitle: '',
    jsonLdSeriesTitle: '',
    canonicalTitle: title,
    playbackState: 'playing',
    tabId: 1,
    windowId: 1,
    timestamp: 1_000,
  };
}

describe('VoiceMediaBridge GSMTC title overlay', () => {
  it('uses the GSMTC work title while preserving the browser URL projection', () => {
    const store = new ContextChannelStore(() => ({
      source: 'Brave',
      playbackState: 'playing',
      title: 'Regular Show | Disney+',
    }));

    store.observe({
      source: mediaSource(),
      channel: 'media',
      payload: record('movies, TV shows, sports, and live TV'),
      tabId: 1,
      windowId: 1,
      observationSequence: 1,
      observedAt: 1_000,
    });

    const current = store.getRecord('media', 1_001)!;

    expect(current.url).toBe('https://www.disneyplus.com/play/example');
    expect(current.documentTitle).toBe('Regular Show | Disney+');
    expect(current.canonicalTitle).toBe('Regular Show');
    expect(current.playbackState).toBe('playing');
  });

  it('does not apply system media context to the page channel', () => {
    const store = new ContextChannelStore(() => ({
      source: 'Brave',
      playbackState: 'playing',
      title: 'Regular Show | Disney+',
    }));
    const source: SourceIdentity = {
      ...mediaSource(),
      browserInstanceId: 'chrome-work-test',
      browserFamily: 'chrome',
      displayName: 'Chrome',
      mode: 'WORK_BROWSER',
    };

    store.observe({
      source,
      channel: 'page',
      payload: record('GitHub'),
      tabId: 2,
      windowId: 1,
      observationSequence: 1,
      observedAt: 1_000,
    });

    expect(store.getRecord('page', 1_001)!.canonicalTitle).toBe('GitHub');
  });

  it('falls back to the browser record when VoiceMediaBridge has no usable context', () => {
    const store = new ContextChannelStore(() => null);

    store.observe({
      source: mediaSource(),
      channel: 'media',
      payload: record('Fallback Show'),
      tabId: 1,
      windowId: 1,
      observationSequence: 1,
      observedAt: 1_000,
    });

    expect(store.getRecord('media', 1_001)!.canonicalTitle).toBe('Fallback Show');
  });
});
