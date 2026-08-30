import { createTitleFeedback } from './titleFeedback';

const HOLD = 2500;

describe('createTitleFeedback', () => {
  let calls: Array<{ context: string; title: string }>;
  let feedback: ReturnType<typeof createTitleFeedback>;

  beforeEach(() => {
    jest.useFakeTimers();
    calls = [];
    feedback = createTitleFeedback((context, title) => calls.push({ context, title }), HOLD);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the title and restores the user label after the hold', () => {
    feedback.flash('ctx', 'Queued');
    expect(calls).toEqual([{ context: 'ctx', title: 'Queued' }]);

    jest.advanceTimersByTime(HOLD - 1);
    expect(calls).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(calls[1]).toEqual({ context: 'ctx', title: '' });
    expect(feedback.pendingCount()).toBe(0);
  });

  it('lets the newest press win when two land close together', () => {
    feedback.flash('ctx', 'A');
    jest.advanceTimersByTime(500);
    feedback.flash('ctx', 'B');

    // The first press's timer fires here and must not clear B.
    jest.advanceTimersByTime(HOLD - 500);
    expect(calls.map((c) => c.title)).toEqual(['A', 'B']);

    // B's own timer completes the full hold from when B was set.
    jest.advanceTimersByTime(500);
    expect(calls.map((c) => c.title)).toEqual(['A', 'B', '']);
  });

  /**
   * Regression for a generation collision.
   *
   * clearHeld prunes its map entry. With a per-context counter that reset to
   * zero, the next flash would claim generation 1 again and the still-pending
   * timer from the first press — also generation 1 — would match it and
   * restore the label early. Here press 3's title must survive the full hold.
   */
  it('does not let a cleared button collide with an older pending timer', () => {
    feedback.flash('ctx', 'first');
    jest.advanceTimersByTime(500);

    feedback.clearHeld('ctx');
    expect(calls.map((c) => c.title)).toEqual(['first', '']);

    jest.advanceTimersByTime(500);
    feedback.flash('ctx', 'third');

    // The first press's timer fires at HOLD; it must not touch 'third'.
    jest.advanceTimersByTime(HOLD - 1000);
    expect(calls.map((c) => c.title)).toEqual(['first', '', 'third']);

    // 'third' holds for its own full duration, not a truncated one.
    jest.advanceTimersByTime(999);
    expect(calls.map((c) => c.title)).toEqual(['first', '', 'third']);

    jest.advanceTimersByTime(1);
    expect(calls.map((c) => c.title)).toEqual(['first', '', 'third', '']);
  });

  it('clears a held title immediately so a failure does not sit next to stale text', () => {
    feedback.flash('ctx', 'Queued');
    jest.advanceTimersByTime(100);

    feedback.clearHeld('ctx');
    expect(calls[calls.length - 1]).toEqual({ context: 'ctx', title: '' });

    // The original timer must not fire a second restore.
    jest.advanceTimersByTime(HOLD);
    expect(calls.filter((c) => c.title === '')).toHaveLength(1);
  });

  it('does nothing when clearing a button that holds no title', () => {
    feedback.clearHeld('ctx');
    expect(calls).toEqual([]);
  });

  it('keys buttons independently', () => {
    feedback.flash('a', 'A');
    feedback.flash('b', 'B');
    expect(feedback.pendingCount()).toBe(2);

    feedback.clearHeld('a');
    expect(feedback.pendingCount()).toBe(1);

    jest.advanceTimersByTime(HOLD);
    expect(calls.map((c) => `${c.context}:${c.title}`)).toEqual(['a:A', 'b:B', 'a:', 'b:']);
    expect(feedback.pendingCount()).toBe(0);
  });

  it('does not retain entries for buttons pressed many times', () => {
    for (let i = 0; i < 50; i++) {
      feedback.flash(`ctx-${i}`, 'Queued');
    }
    expect(feedback.pendingCount()).toBe(50);

    jest.advanceTimersByTime(HOLD);
    expect(feedback.pendingCount()).toBe(0);
  });
});
