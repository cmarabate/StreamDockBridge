import { findActiveMediaVideo } from './mediaController';

export type PlaybackStatePublisher = (isPlaying: boolean) => void;

function documentUrl(root: Document): string {
  try {
    return root.defaultView?.location?.href || '';
  } catch (_error) {
    return '';
  }
}

function nodeTouchesMedia(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (element.tagName === 'VIDEO' || element.tagName === 'SOURCE') return true;
  return !!element.querySelector?.('video,source');
}

/**
 * DOM churn is only interesting when it can change the media element itself,
 * or when a same-document SPA navigation changed URL and the next mutation is
 * our first chance to reconcile the already-running player.
 */
export function mutationMayAffectMedia(
  records: MutationRecord[],
  previousUrl: string,
  currentUrl: string
): boolean {
  if (previousUrl !== currentUrl) return true;

  for (const record of records) {
    if (nodeTouchesMedia(record.target)) return true;
    for (const node of Array.from(record.addedNodes)) {
      if (nodeTouchesMedia(node)) return true;
    }
    for (const node of Array.from(record.removedNodes)) {
      if (nodeTouchesMedia(node)) return true;
    }
  }
  return false;
}

/**
 * Reconciles current media state in addition to the edge-triggered play/pause
 * events handled by MediaPlaybackController.
 *
 * Streaming SPAs can insert a replacement video that is already playing before
 * the bridge observes its `play` edge. They can also reuse the same video while
 * swapping episode state. Mutation/lifecycle reconciliation makes the current
 * state authoritative without polling or site-specific selectors.
 */
export class MediaPlaybackReconciler {
  private observer: MutationObserver | null = null;
  private reconcileQueued = false;
  private lastVideo: HTMLVideoElement | null = null;
  private lastPlaying: boolean | null = null;
  private lastUrl: string;

  constructor(
    private readonly onPlaybackState: PlaybackStatePublisher,
    private readonly root: Document = document
  ) {
    this.lastUrl = documentUrl(root);
  }

  public start(): void {
    if (this.observer) return;

    // If the content script arrives after autoplay already began, publish the
    // state we can observe now rather than waiting for another media edge.
    this.reconcile();

    const target = this.root.documentElement || this.root.body;
    if (target && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver((records) => {
        const currentUrl = documentUrl(this.root);
        if (!mutationMayAffectMedia(records, this.lastUrl, currentUrl)) return;
        this.scheduleReconcile();
      });
      this.observer.observe(target, { childList: true, subtree: true });
    }

    // These lifecycle events are useful when a streaming app reuses the same
    // video element and changes its source without replacing the DOM node.
    this.root.addEventListener('loadedmetadata', this.onMediaLifecycle, true);
    this.root.addEventListener('loadeddata', this.onMediaLifecycle, true);
    this.root.addEventListener('durationchange', this.onMediaLifecycle, true);
  }

  public stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.root.removeEventListener('loadedmetadata', this.onMediaLifecycle, true);
    this.root.removeEventListener('loadeddata', this.onMediaLifecycle, true);
    this.root.removeEventListener('durationchange', this.onMediaLifecycle, true);
  }

  /**
   * Read-only reconciliation. It never calls play() or pause().
   */
  public reconcile(): void {
    const video = findActiveMediaVideo(this.root);
    const currentUrl = documentUrl(this.root);

    if (!video) {
      this.lastVideo = null;
      this.lastPlaying = null;
      this.lastUrl = currentUrl;
      return;
    }

    const isPlaying = !video.paused && !video.ended;
    if (
      video === this.lastVideo &&
      isPlaying === this.lastPlaying &&
      currentUrl === this.lastUrl
    ) {
      return;
    }

    this.lastVideo = video;
    this.lastPlaying = isPlaying;
    this.lastUrl = currentUrl;
    this.onPlaybackState(isPlaying);
  }

  private scheduleReconcile(): void {
    if (this.reconcileQueued) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      this.reconcile();
    });
  }

  private readonly onMediaLifecycle = (event: Event): void => {
    const target = event.target as HTMLVideoElement | null;
    if (!target || target.tagName !== 'VIDEO') return;
    this.scheduleReconcile();
  };
}
