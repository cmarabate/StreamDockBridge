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

  /**
   * A streaming page is heavy and its content script routinely misses a
   * deadline. Silence must not cost the user the switch they just made: a tab
   * already known to be media still takes ownership when activated.
   */
  it('C-under-timeout: a known media tab still wins activation without fresh evidence', () => {
    const tracker = new MediaTabTracker();
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    tracker.noteActivated(MEDIA_B, 1, 'https://primevideo.com/b', true);
    tracker.noteActivated(MEDIA_A, 1, 'https://disneyplus.com/a', true);
    expect(tracker.current()!.tabId).toBe(MEDIA_A);

    // B is activated again; its content script says nothing, but B is already
    // known to be media, so the caller re-activates it as still-eligible.
    tracker.noteActivated(MEDIA_B, 1, 'https://primevideo.com/b', true);
    expect(tracker.current()!.tabId).toBe(MEDIA_B);
  });

  it('forgets a tab it never knew when it closes', () => {
    const tracker = new MediaTabTracker();
    expect(() => tracker.noteClosed(12345)).not.toThrow();
    expect(tracker.current()).toBeNull();
  });

  describe('owner physical reproduction and bootstrap reconstruction hierarchy', () => {
    const THE_VOYEURS = 10;
    const REGULAR_SHOW = 20;

    it('Owner reproduction: active playing tab wins over background paused tab after reload bootstrap', () => {
      const tracker = new MediaTabTracker();

      // Bootstrap discovers The Voyeurs (tab index 0, background, not playing)
      tracker.noteEvidence(THE_VOYEURS, 1, 'https://primevideo.com/the-voyeurs', true, {
        isActive: false,
        isPlaying: false,
        lastAccessed: 1000,
      });

      // Bootstrap discovers Regular Show (tab index 1, active, playing)
      tracker.noteEvidence(REGULAR_SHOW, 1, 'https://disneyplus.com/regular-show', true, {
        isActive: true,
        isPlaying: true,
        lastAccessed: 2000,
      });

      // Deterministic winner MUST be Regular Show
      expect(tracker.current()!.tabId).toBe(REGULAR_SHOW);
    });

    it('Background playing tab wins over active paused tab during bootstrap', () => {
      const tracker = new MediaTabTracker();
      const BG_PLAYING = 30;
      const ACTIVE_PAUSED = 40;

      tracker.noteEvidence(ACTIVE_PAUSED, 1, 'https://netflix.com/paused', true, {
        isActive: true,
        isPlaying: false,
        lastAccessed: 2000,
      });

      tracker.noteEvidence(BG_PLAYING, 1, 'https://youtube.com/playing', true, {
        isActive: false,
        isPlaying: true,
        lastAccessed: 1500,
      });

      expect(tracker.current()!.tabId).toBe(BG_PLAYING);
    });

    it('Active playing tab wins over background playing tab', () => {
      const tracker = new MediaTabTracker();
      const ACTIVE_PLAYING = 50;
      const BG_PLAYING = 60;

      tracker.noteEvidence(BG_PLAYING, 1, 'https://youtube.com/stream', true, {
        isActive: false,
        isPlaying: true,
        lastAccessed: 1000,
      });

      tracker.noteEvidence(ACTIVE_PLAYING, 1, 'https://disneyplus.com/show', true, {
        isActive: true,
        isPlaying: true,
        lastAccessed: 2000,
      });

      expect(tracker.current()!.tabId).toBe(ACTIVE_PLAYING);
    });

    it('Active paused tab wins over background paused tab during bootstrap', () => {
      const tracker = new MediaTabTracker();
      const ACTIVE_PAUSED = 70;
      const BG_PAUSED = 80;

      tracker.noteEvidence(BG_PAUSED, 1, 'https://hulu.com/bg', true, {
        isActive: false,
        isPlaying: false,
        lastAccessed: 1000,
      });

      tracker.noteEvidence(ACTIVE_PAUSED, 1, 'https://disneyplus.com/active', true, {
        isActive: true,
        isPlaying: false,
        lastAccessed: 2000,
      });

      expect(tracker.current()!.tabId).toBe(ACTIVE_PAUSED);
    });

    it('Live tab switching: switching to The Voyeurs makes it owner, switching back returns to Regular Show', () => {
      const tracker = new MediaTabTracker();

      // Bootstrap initial state (Regular Show wins)
      tracker.noteEvidence(THE_VOYEURS, 1, 'https://primevideo.com/the-voyeurs', true, {
        isActive: false,
        isPlaying: false,
      });
      tracker.noteEvidence(REGULAR_SHOW, 1, 'https://disneyplus.com/regular-show', true, {
        isActive: true,
        isPlaying: true,
      });
      expect(tracker.current()!.tabId).toBe(REGULAR_SHOW);

      // User switches to The Voyeurs
      tracker.noteActivated(THE_VOYEURS, 1, 'https://primevideo.com/the-voyeurs', true, false);
      expect(tracker.current()!.tabId).toBe(THE_VOYEURS);

      // User switches back to Regular Show
      tracker.noteActivated(REGULAR_SHOW, 1, 'https://disneyplus.com/regular-show', true, true);
      expect(tracker.current()!.tabId).toBe(REGULAR_SHOW);
    });

    it('Heartbeat/rebuild preserves established owner absent stronger evidence', () => {
      const tracker = new MediaTabTracker();
      tracker.noteActivated(REGULAR_SHOW, 1, 'https://disneyplus.com/regular-show', true, true);
      expect(tracker.current()!.tabId).toBe(REGULAR_SHOW);

      // Rebuild passes background evidence
      tracker.noteEvidence(THE_VOYEURS, 1, 'https://primevideo.com/the-voyeurs', true, {
        isActive: false,
        isPlaying: false,
      });
      tracker.noteEvidence(REGULAR_SHOW, 1, 'https://disneyplus.com/regular-show', true, {
        isActive: true,
        isPlaying: true,
      });

      expect(tracker.current()!.tabId).toBe(REGULAR_SHOW);
    });
  });
});
