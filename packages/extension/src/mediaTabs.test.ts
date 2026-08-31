import { MediaTabTracker, looksLikeMedia } from './mediaTabs';

/**
 * The exact selection semantics the owner relies on, written as the scenarios
 * they described rather than as unit trivia.
 */

describe('deciding a page is something being watched', () => {
  it('accepts Open Graph video types', () => {
    expect(looksLikeMedia({ ogType: 'video.movie' })).toBe(true);
    expect(looksLikeMedia({ ogType: 'video.episode' })).toBe(true);
    expect(looksLikeMedia({ ogType: 'video.other' })).toBe(true);
  });

  it('accepts structured screen-work types', () => {
    expect(looksLikeMedia({ jsonLdType: 'Movie' })).toBe(true);
    expect(looksLikeMedia({ jsonLdType: 'TVEpisode' })).toBe(true);
    expect(looksLikeMedia({ jsonLdType: 'TVSeries' })).toBe(true);
    expect(looksLikeMedia({ jsonLdType: 'VideoObject' })).toBe(true);
  });

  /** A self-hosted player declares nothing, so the element itself is evidence. */
  it('accepts a page that actually has a video element', () => {
    expect(looksLikeMedia({ hasVideo: true })).toBe(true);
  });

  it('rejects ordinary pages', () => {
    expect(looksLikeMedia({ ogType: 'website' })).toBe(false);
    expect(looksLikeMedia({ jsonLdType: 'Article' })).toBe(false);
    expect(looksLikeMedia({ hasVideo: false })).toBe(false);
    expect(looksLikeMedia({})).toBe(false);
    expect(looksLikeMedia(null)).toBe(false);
    expect(looksLikeMedia(undefined)).toBe(false);
  });
});

describe('which tab owns media', () => {
  const MEDIA_A = 101;
  const MEDIA_B = 102;
  const UNRELATED = 200;

  it('A. activating a media tab makes it the owner', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    expect(tracker.current()!.tabId).toBe(MEDIA_A);
  });

  /** The behaviour that makes the key usable: reading email does not clear it. */
  it('B. activating an unrelated tab leaves media alone', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(UNRELATED, 1, 'https://mail.example.com', false);

    expect(tracker.current()!.tabId).toBe(MEDIA_A);
  });

  it('C. activating a second media tab transfers ownership', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(MEDIA_B, 1, 'https://primevideo.com/b', true);
    expect(tracker.current()!.tabId).toBe(MEDIA_B);
  });

  it('D. closing the owner falls back to the next most recent eligible tab', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(MEDIA_B, 1, 'https://primevideo.com/b', true);
    expect(tracker.current()!.tabId).toBe(MEDIA_B);

    tracker.noteClosed(MEDIA_B);
    expect(tracker.current()!.tabId).toBe(MEDIA_A);
  });

  it('E. closing the last eligible tab clears media', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteClosed(MEDIA_A);
    expect(tracker.current()).toBeNull();
    expect(tracker.size()).toBe(0);
  });

  /**
   * F. The browser losing OS focus is not an event this tracker ever sees, and
   * that is the point — nothing about focus can disturb ownership.
   */
  it('F. is unaffected by anything other than tab activation and removal', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    const before = tracker.current();

    // Whatever else happens in other windows, the owner stands.
    tracker.noteActivated(UNRELATED, 2, 'https://news.example.com', false);
    tracker.noteEvidence(999, 3, 'https://other.example.com', false);

    expect(tracker.current()).toEqual(before);
  });

  /** A tab that navigates away from media stops being a candidate. */
  it('drops a tab that navigates to something that is not media', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(MEDIA_B, 1, 'https://primevideo.com/b', true);

    // A navigates away while in the background.
    tracker.noteEvidence(MEDIA_A, 1, 'https://shopping.example.com', false);
    tracker.noteClosed(MEDIA_B);

    expect(tracker.current()).toBeNull();
  });

  /** Background playback must not steal the channel from the active choice. */
  it('does not let a background tab outrank the activated owner', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteEvidence(MEDIA_B, 1, 'https://primevideo.com/b', true);

    expect(tracker.current()!.tabId).toBe(MEDIA_A);

    // But it is a valid fallback once the owner goes.
    tracker.noteClosed(MEDIA_A);
    expect(tracker.current()!.tabId).toBe(MEDIA_B);
  });

  it('keeps a re-activated tab as the newest owner', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(MEDIA_B, 1, 'https://primevideo.com/b', true);
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    expect(tracker.current()!.tabId).toBe(MEDIA_A);
  });

  it('tracks tabs across several windows of the same browser', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(MEDIA_B, 2, 'https://primevideo.com/b', true);
    expect(tracker.current()!.windowId).toBe(2);

    tracker.noteClosed(MEDIA_B);
    expect(tracker.current()!.windowId).toBe(1);
  });

  it('forgets a tab it never knew when it closes', () => {
    const tracker = new MediaTabTracker();
    expect(() => tracker.noteClosed(12345)).not.toThrow();
    expect(tracker.current()).toBeNull();
  });
});
