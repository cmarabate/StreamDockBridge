export interface VideoScoringResult {
  video: HTMLVideoElement;
  score: number;
  isActivePlaying: boolean;
}

export function getAllVideosInSubtree(root: Document | ShadowRoot | Element): HTMLVideoElement[] {
  const videos: HTMLVideoElement[] = [];
  if (!root || typeof (root as any).querySelectorAll !== 'function') return videos;

  const direct = (root as any).querySelectorAll('video');
  direct.forEach((v: HTMLVideoElement) => videos.push(v));

  if (typeof document !== 'undefined' && document.createTreeWalker) {
    try {
      const walker = document.createTreeWalker(
        root instanceof Document ? root.documentElement : (root as Node),
        NodeFilter.SHOW_ELEMENT,
        null
      );

      let node = walker.currentNode as Element | null;
      while (node) {
        if (node.shadowRoot) {
          videos.push(...getAllVideosInSubtree(node.shadowRoot));
        }
        node = walker.nextNode() as Element | null;
      }
    } catch (e) {
      // TreeWalker fallback
    }
  }

  return Array.from(new Set(videos));
}

export function evaluateVideoCandidate(video: HTMLVideoElement): VideoScoringResult {
  let score = 0;

  if (!video.isConnected) {
    return { video, score: -1, isActivePlaying: false };
  }

  let isVisible = true;
  let rect = { width: 100, height: 100 };
  if (typeof window !== 'undefined' && video.getBoundingClientRect) {
    rect = video.getBoundingClientRect();
    const style = window.getComputedStyle(video);
    isVisible =
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      parseFloat(style.opacity || '1') > 0.05 &&
      rect.width >= 48 &&
      rect.height >= 48;
  }

  if (!isVisible) {
    return { video, score: -1, isActivePlaying: false };
  }

  const surfaceArea = rect.width * rect.height;
  score += Math.min(surfaceArea / 1000, 500);

  const isPlaying = !video.paused && !video.ended;
  const hasStarted = video.currentTime > 0;
  const hasBuffer = video.readyState >= 2; // HAVE_CURRENT_DATA
  const hasValidDuration =
    typeof video.duration === 'number' &&
    (video.duration > 0 || video.duration === Infinity || isNaN(video.duration));

  if (isPlaying && hasStarted && hasBuffer && hasValidDuration) {
    score += 1000;
  } else if (!video.paused && hasBuffer) {
    score += 500;
  } else if (hasStarted && hasBuffer) {
    score += 100;
  }

  if (!video.muted && video.volume > 0.05) {
    score += 300;
  }

  if (video.currentSrc || video.src) {
    score += 50;
  }

  return {
    video,
    score,
    isActivePlaying: isPlaying && isVisible && hasBuffer,
  };
}

export function findActiveMediaVideo(root: Document | ShadowRoot = document): HTMLVideoElement | null {
  const videos = getAllVideosInSubtree(root);
  if (videos.length === 0) return null;

  const scored = videos
    .map(evaluateVideoCandidate)
    .filter((res) => res.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].video : null;
}

export class MediaPlaybackController {
  private lastProgrammaticActionTime = 0;
  private readonly PROGRAMMATIC_WINDOW_MS = 350;
  private isPausedByExtension = false;

  constructor(private readonly onUserOverride?: () => void) {
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('play', this.onVideoPlay.bind(this), true);
    document.addEventListener('pause', this.onVideoPause.bind(this), true);
  }

  public async pause(): Promise<boolean> {
    const video = findActiveMediaVideo();
    if (!video || video.paused) return false;

    this.lastProgrammaticActionTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.isPausedByExtension = true;
    video.pause();
    return true;
  }

  public async resume(): Promise<boolean> {
    const video = findActiveMediaVideo();
    if (!video) return false;

    this.lastProgrammaticActionTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.isPausedByExtension = false;

    try {
      const p = video.play();
      if (p !== undefined) {
        await p;
      }
      return true;
    } catch (err: any) {
      return false;
    }
  }

  private onVideoPlay(event: Event): void {
    const target = event.target as HTMLMediaElement;
    if (!target || target.tagName !== 'VIDEO') return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const isProgrammatic = now - this.lastProgrammaticActionTime < this.PROGRAMMATIC_WINDOW_MS;

    if (isProgrammatic) {
      return;
    }

    if (this.isPausedByExtension) {
      this.isPausedByExtension = false;
      if (this.onUserOverride) {
        this.onUserOverride();
      }
    }
  }

  private onVideoPause(event: Event): void {
    const target = event.target as HTMLMediaElement;
    if (!target || target.tagName !== 'VIDEO') return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const isProgrammatic = now - this.lastProgrammaticActionTime < this.PROGRAMMATIC_WINDOW_MS;

    if (!isProgrammatic) {
      this.isPausedByExtension = false;
    }
  }
}
