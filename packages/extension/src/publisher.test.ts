import { buildEnvelope, shouldPublish, SequenceCounter, PagePayload } from './publisher';
import { BrowserRole } from './browserRole';

const role = (mode: BrowserRole['mode'], generation = 1): BrowserRole => ({
  browserInstanceId: 'inst-1',
  browserFamily: 'brave',
  displayName: 'Brave Personal',
  mode,
  connectionGeneration: generation,
});

const page: PagePayload = {
  url: 'https://www.disneyplus.com/video/abc',
  hostname: 'www.disneyplus.com',
  rawTitle: 'Brickleberry',
  documentTitle: 'Brickleberry',
  tabId: 7,
  windowId: 3,
};

describe('deciding whether to publish at all', () => {
  it('publishes only what the mode allows', () => {
    expect(shouldPublish(role('MEDIA_BROWSER'), 'media')).toBe(true);
    expect(shouldPublish(role('MEDIA_BROWSER'), 'page')).toBe(false);
    expect(shouldPublish(role('WORK_BROWSER'), 'page')).toBe(true);
    expect(shouldPublish(role('WORK_BROWSER'), 'media')).toBe(false);
    expect(shouldPublish(role('DISABLED'), 'media')).toBe(false);
  });

  /** A forbidden channel produces no body at all, so nothing can be sent. */
  it('builds nothing for a channel the mode forbids', () => {
    expect(buildEnvelope(role('MEDIA_BROWSER'), 'page', 1, page, 1000)).toBeNull();
    expect(buildEnvelope(role('WORK_BROWSER'), 'media', 1, page, 1000)).toBeNull();
    expect(buildEnvelope(role('DISABLED'), 'media', 1, page, 1000)).toBeNull();
  });
});

describe('the observation body', () => {
  it('carries the installation identity and the channel', () => {
    const envelope = buildEnvelope(role('MEDIA_BROWSER'), 'media', 5, page, 1000)!;
    expect(envelope.source.browserInstanceId).toBe('inst-1');
    expect(envelope.source.mode).toBe('MEDIA_BROWSER');
    expect(envelope.source.connectionGeneration).toBe(1);
    expect(envelope.channel).toBe('media');
    expect(envelope.observationSequence).toBe(5);
    expect(envelope.timestamp).toBe(1000);
  });

  it('flattens a page payload where the service expects it', () => {
    const envelope = buildEnvelope(role('HYBRID'), 'page', 1, page, 1000)!;
    expect(envelope.url).toBe(page.url);
    expect(envelope.documentTitle).toBe('Brickleberry');
    expect(envelope.tabId).toBe(7);
    expect(envelope.windowId).toBe(3);
  });

  it('nests a project payload under its own key', () => {
    const envelope = buildEnvelope(
      role('WORK_BROWSER'),
      'project',
      1,
      { projectKey: 'ideaforge', projectName: 'IdeaForge', evidence: 'chatgpt-project' },
      1000
    )!;
    expect(envelope.project).toEqual({
      projectKey: 'ideaforge',
      projectName: 'IdeaForge',
      evidence: 'chatgpt-project',
    });
    expect(envelope.release).toBeUndefined();
  });

  /**
   * Publishing an ABSENCE is how a work browser says the current page proves no
   * project. It must not be confusable with an empty payload, or the service
   * would store a nameless project instead of clearing the channel.
   */
  it('marks a release and carries no payload', () => {
    const envelope = buildEnvelope(role('WORK_BROWSER'), 'project', 9, null, 1000)!;
    expect(envelope.release).toBe(true);
    expect(envelope.project).toBeUndefined();
    expect(envelope.url).toBeUndefined();
  });

  it('reports the generation so a dead worker cannot outrank a live one', () => {
    const first = buildEnvelope(role('HYBRID', 4), 'media', 1, page, 1000)!;
    expect(first.source.connectionGeneration).toBe(4);
  });
});

describe('sequence numbering', () => {
  it('advances on every observation', () => {
    const counter = new SequenceCounter();
    expect(counter.next()).toBe(1);
    expect(counter.next()).toBe(2);
    expect(counter.next()).toBe(3);
    expect(counter.peek()).toBe(3);
  });

  it('never repeats within one worker', () => {
    const counter = new SequenceCounter();
    const seen = new Set(Array.from({ length: 500 }, () => counter.next()));
    expect(seen.size).toBe(500);
  });
});
