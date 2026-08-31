/** @jest-environment jsdom */

import { MediaPlaybackController } from './mediaController';

describe('MediaPlaybackController command acknowledgements', () => {
  let video: HTMLVideoElement;
  let paused: boolean;
  let pauseMock: jest.Mock;
  let playMock: jest.Mock;

  beforeEach(() => {
    document.body.innerHTML = '';
    paused = false;
    video = document.createElement('video');
    video.src = 'https://example.test/show.mp4';
    document.body.appendChild(video);
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => paused },
      ended: { configurable: true, get: () => false },
      currentTime: { configurable: true, get: () => 10 },
      readyState: { configurable: true, get: () => 4 },
      duration: { configurable: true, get: () => 100 },
      currentSrc: { configurable: true, get: () => video.src },
    });
    video.getBoundingClientRect = () =>
      ({ width: 1280, height: 720 } as DOMRect);
    pauseMock = jest.fn(() => {
      paused = true;
      video.dispatchEvent(new Event('pause'));
    });
    playMock = jest.fn(async () => {
      paused = false;
      video.dispatchEvent(new Event('play'));
    });
    video.pause = pauseMock;
    video.play = playMock;
  });

  const pauseRequest = {
    commandId: 'cmd-pause',
    leaseId: 'lease-1',
    command: 'PAUSE' as const,
    expectedDocumentGeneration: 'doc-1',
  };

  it('returns CHANGED only for an exact playing-to-paused transition', async () => {
    const controller = new MediaPlaybackController('doc-1');
    const result = await controller.execute(pauseRequest);
    expect(result).toMatchObject({
      outcome: 'CHANGED',
      initialPlayback: 'playing',
      finalPlayback: 'paused',
      documentGeneration: 'doc-1',
      mediaTargetId: 'media-1',
    });
    expect(pauseMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a pre-paused target and does not call pause()', async () => {
    paused = true;
    const controller = new MediaPlaybackController('doc-1');
    const result = await controller.execute(pauseRequest);
    expect(result).toMatchObject({
      outcome: 'ALREADY_IN_STATE',
      initialPlayback: 'paused',
      finalPlayback: 'paused',
    });
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when no playable element exists', async () => {
    video.remove();
    const controller = new MediaPlaybackController('doc-1');
    expect(await controller.execute(pauseRequest)).toMatchObject({ outcome: 'NOT_FOUND' });
  });

  it('returns FAILED when pause() does not change playback', async () => {
    video.pause = jest.fn();
    const controller = new MediaPlaybackController('doc-1');
    expect(await controller.execute(pauseRequest)).toMatchObject({
      outcome: 'FAILED',
      initialPlayback: 'playing',
      finalPlayback: 'playing',
    });
  });

  it('rejects stale document generations without touching playback', async () => {
    const controller = new MediaPlaybackController('doc-2');
    expect(await controller.execute(pauseRequest)).toMatchObject({ outcome: 'STALE_TARGET' });
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it('resumes only the exact element paused by the exact lease', async () => {
    const controller = new MediaPlaybackController('doc-1');
    const pause = await controller.execute(pauseRequest);
    const resume = await controller.execute({
      commandId: 'cmd-resume',
      leaseId: 'lease-1',
      command: 'RESUME',
      expectedDocumentGeneration: 'doc-1',
      expectedMediaTargetId: pause.mediaTargetId,
    });
    expect(resume).toMatchObject({
      outcome: 'CHANGED',
      initialPlayback: 'paused',
      finalPlayback: 'playing',
      mediaTargetId: pause.mediaTargetId,
    });
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('never resumes a replacement or mismatched media target', async () => {
    const controller = new MediaPlaybackController('doc-1');
    await controller.execute(pauseRequest);
    expect(
      await controller.execute({
        commandId: 'cmd-resume',
        leaseId: 'lease-1',
        command: 'RESUME',
        expectedDocumentGeneration: 'doc-1',
        expectedMediaTargetId: 'media-replacement',
      })
    ).toMatchObject({ outcome: 'STALE_TARGET' });
    expect(playMock).not.toHaveBeenCalled();
  });

  it('reports a command-correlated user override without a timing heuristic', async () => {
    const overrides: unknown[] = [];
    const controller = new MediaPlaybackController('doc-1', (evidence) => overrides.push(evidence));
    await controller.execute(pauseRequest);
    paused = false;
    video.dispatchEvent(new Event('play'));
    expect(overrides).toEqual([
      {
        leaseId: 'lease-1',
        pauseCommandId: 'cmd-pause',
        documentGeneration: 'doc-1',
        mediaTargetId: 'media-1',
      },
    ]);
  });
});
