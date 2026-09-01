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

  it('does not swallow a later user override when the prior resume play event was not observed', async () => {
    const overrides: unknown[] = [];
    const controller = new MediaPlaybackController('doc-1', (evidence) => overrides.push(evidence));
    const firstPause = await controller.execute(pauseRequest);

    video.play = jest.fn(async () => {
      paused = false;
      // Model a player whose non-bubbling play event never reaches the
      // document-level listener.
    });
    await controller.execute({
      commandId: 'cmd-resume-1',
      leaseId: 'lease-1',
      command: 'RESUME',
      expectedDocumentGeneration: 'doc-1',
      expectedMediaTargetId: firstPause.mediaTargetId,
    });

    const secondPause = await controller.execute({
      ...pauseRequest,
      commandId: 'cmd-pause-2',
      leaseId: 'lease-2',
    });
    paused = false;
    video.dispatchEvent(new Event('play'));

    expect(overrides).toEqual([
      {
        leaseId: 'lease-2',
        pauseCommandId: 'cmd-pause-2',
        documentGeneration: 'doc-1',
        mediaTargetId: secondPause.mediaTargetId,
      },
    ]);
  });

  it('returns original PAUSE and RESUME results when commands are replayed', async () => {
    const controller = new MediaPlaybackController('doc-1');
    const firstPause = await controller.execute(pauseRequest);
    const replayedPause = await controller.execute(pauseRequest);
    expect(firstPause.outcome).toBe('CHANGED');
    expect(replayedPause).toEqual(firstPause);
    expect(pauseMock).toHaveBeenCalledTimes(1);

    const resumeRequest = {
      commandId: 'cmd-resume',
      leaseId: 'lease-1',
      command: 'RESUME' as const,
      expectedDocumentGeneration: 'doc-1',
      expectedMediaTargetId: firstPause.mediaTargetId,
    };
    const firstResume = await controller.execute(resumeRequest);
    const replayedResume = await controller.execute(resumeRequest);
    expect(firstResume.outcome).toBe('CHANGED');
    expect(replayedResume).toEqual(firstResume);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent duplicate RESUME delivery into one play mutation', async () => {
    const controller = new MediaPlaybackController('doc-1');
    const pause = await controller.execute(pauseRequest);
    let finishPlay: (() => void) | undefined;
    video.play = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPlay = () => {
            paused = false;
            resolve();
          };
        })
    );
    const resumeRequest = {
      commandId: 'cmd-resume-concurrent',
      leaseId: 'lease-1',
      command: 'RESUME' as const,
      expectedDocumentGeneration: 'doc-1',
      expectedMediaTargetId: pause.mediaTargetId,
    };

    const first = controller.execute(resumeRequest);
    const duplicate = controller.execute(resumeRequest);
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledTimes(1);
    finishPlay?.();

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toMatchObject({ outcome: 'CHANGED' });
    expect(duplicateResult).toEqual(firstResult);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('rejects a PAUSE for the wrong known media target without mutation', async () => {
    const controller = new MediaPlaybackController('doc-1');
    expect(
      await controller.execute({
        ...pauseRequest,
        expectedMediaTargetId: 'media-from-another-document',
      })
    ).toMatchObject({ outcome: 'STALE_TARGET' });
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it('rejects an expired command before touching playback', async () => {
    const controller = new MediaPlaybackController('doc-1');
    expect(await controller.execute({ ...pauseRequest, expiresAt: Date.now() - 1 }))
      .toMatchObject({ outcome: 'STALE_TARGET' });
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it('relinquishes ownership when another video starts in the same document', async () => {
    const overrides: unknown[] = [];
    const controller = new MediaPlaybackController('doc-1', (evidence) => overrides.push(evidence));
    const pause = await controller.execute(pauseRequest);

    const other = document.createElement('video');
    document.body.appendChild(other);
    other.dispatchEvent(new Event('play'));

    expect(overrides).toHaveLength(1);
    expect(
      await controller.execute({
        commandId: 'cmd-resume',
        leaseId: 'lease-1',
        command: 'RESUME',
        expectedDocumentGeneration: 'doc-1',
        expectedMediaTargetId: pause.mediaTargetId,
      })
    ).toMatchObject({ outcome: 'STALE_TARGET' });
    expect(playMock).not.toHaveBeenCalled();
  });
});

describe('MediaPlaybackController playback-state publication', () => {
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

  it('reports a user-driven pause transition even without an owned pause', async () => {
    const changes: boolean[] = [];
    // A controller whose only interest is reporting the state it observes.
    new MediaPlaybackController('doc-1', undefined, (isPlaying) =>
      changes.push(isPlaying)
    );

    paused = true;
    video.dispatchEvent(new Event('pause'));

    expect(changes).toEqual([false]);
    expect(pauseMock).not.toHaveBeenCalled();
  });

  it('reports a user-driven play as playing', async () => {
    const changes: boolean[] = [];
    new MediaPlaybackController('doc-1', undefined, (isPlaying) =>
      changes.push(isPlaying)
    );

    paused = false;
    video.dispatchEvent(new Event('play'));

    expect(changes).toEqual([true]);
    expect(playMock).not.toHaveBeenCalled();
  });

  it('reports the bridge pause transition as paused so context stays authoritative', async () => {
    const changes: boolean[] = [];
    const controller = new MediaPlaybackController('doc-1', undefined, (isPlaying) =>
      changes.push(isPlaying)
    );
    // The bridge pause() fires the pause event and the callback reports it,
    // which is exactly the fresh state the service should hold.
    await controller.execute({
      commandId: 'cmd-pause',
      leaseId: 'lease-1',
      command: 'PAUSE',
      expectedDocumentGeneration: 'doc-1',
    });
    expect(changes).toEqual([false]);
  });

  it('reports an ended media element as paused', async () => {
    const changes: boolean[] = [];
    new MediaPlaybackController('doc-1', undefined, (isPlaying) =>
      changes.push(isPlaying)
    );

    paused = false;
    Object.defineProperty(video, 'ended', { configurable: true, get: () => true });
    video.dispatchEvent(new Event('ended'));

    expect(changes).toEqual([false]);
  });
});
