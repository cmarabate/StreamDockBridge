/** @jest-environment jsdom */

import { MediaPlaybackReconciler } from './mediaReconciler';

function createVideo(initialPaused: boolean, src: string) {
  let paused = initialPaused;
  const video = document.createElement('video');
  video.src = src;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, get: () => false },
    currentTime: { configurable: true, get: () => 0 },
    readyState: { configurable: true, get: () => 4 },
    duration: { configurable: true, get: () => 100 },
    currentSrc: { configurable: true, get: () => video.src },
  });
  video.getBoundingClientRect = () => ({ width: 1280, height: 720 } as DOMRect);
  return {
    video,
    setPaused(value: boolean) {
      paused = value;
    },
  };
}

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MediaPlaybackReconciler', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('publishes an already-playing replacement even when its play edge was missed', async () => {
    const changes: boolean[] = [];
    const original = createVideo(true, 'https://example.test/episode-a.mp4');
    document.body.appendChild(original.video);

    const reconciler = new MediaPlaybackReconciler((isPlaying) => changes.push(isPlaying));
    reconciler.start();
    expect(changes).toEqual([false]);
    changes.length = 0;

    original.video.remove();
    const replacement = createVideo(false, 'https://example.test/episode-b.mp4');
    document.body.appendChild(replacement.video);

    // Deliberately do NOT dispatch `play`. The replacement is already playing
    // by the time the bridge discovers it.
    await flushMutations();

    expect(changes).toEqual([true]);
    reconciler.stop();
  });

  it('does not falsely publish a paused replacement as playing', async () => {
    const changes: boolean[] = [];
    const reconciler = new MediaPlaybackReconciler((isPlaying) => changes.push(isPlaying));
    reconciler.start();

    const replacement = createVideo(true, 'https://example.test/episode-b.mp4');
    document.body.appendChild(replacement.video);
    await flushMutations();

    expect(changes).toEqual([false]);
    reconciler.stop();
  });

  it('reconciles a reused video from lifecycle state without requiring play', async () => {
    const changes: boolean[] = [];
    const reused = createVideo(true, 'https://example.test/episode-a.mp4');
    document.body.appendChild(reused.video);

    const reconciler = new MediaPlaybackReconciler((isPlaying) => changes.push(isPlaying));
    reconciler.start();
    expect(changes).toEqual([false]);
    changes.length = 0;

    reused.setPaused(false);
    reused.video.dispatchEvent(new Event('loadedmetadata'));
    await flushMutations();

    expect(changes).toEqual([true]);
    reconciler.stop();
  });

  it('ignores unrelated DOM churn when media identity, state, and URL are unchanged', async () => {
    const changes: boolean[] = [];
    const current = createVideo(false, 'https://example.test/episode-a.mp4');
    document.body.appendChild(current.video);

    const reconciler = new MediaPlaybackReconciler((isPlaying) => changes.push(isPlaying));
    reconciler.start();
    expect(changes).toEqual([true]);
    changes.length = 0;

    const unrelated = document.createElement('div');
    unrelated.textContent = 'subtitle/control churn';
    document.body.appendChild(unrelated);
    await flushMutations();

    expect(changes).toEqual([]);
    reconciler.stop();
  });

  it('deduplicates repeated reconciliation of the same video state', () => {
    const changes: boolean[] = [];
    const current = createVideo(false, 'https://example.test/episode-a.mp4');
    document.body.appendChild(current.video);

    const reconciler = new MediaPlaybackReconciler((isPlaying) => changes.push(isPlaying));
    reconciler.start();
    reconciler.reconcile();
    reconciler.reconcile();

    expect(changes).toEqual([true]);
    reconciler.stop();
  });
});
