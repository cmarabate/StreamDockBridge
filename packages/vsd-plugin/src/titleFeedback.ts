export type SetTitle = (context: string, title: string) => void;

export interface TitleFeedback {
  /** Show a title on a button, then restore the user's label after holdMs. */
  flash: (context: string, title: string) => void;
  /** Drop any held title for this button immediately. */
  clearHeld: (context: string) => void;
  /** Number of buttons currently holding a flashed title. */
  pendingCount: () => number;
}

export const DEFAULT_TITLE_HOLD_MS = 2500;

/**
 * Newest press per button wins.
 *
 * Each flash claims a generation for its context; the deferred restore only
 * runs if it still owns the newest one, so a slow earlier press can never
 * clear a title a later press has just set.
 *
 * Generations come from one ever-increasing counter rather than a per-context
 * one. A per-context counter would restart at 1 whenever an entry is pruned,
 * letting a still-pending older timer match a newer press and restore its
 * title early. Globally unique generations make that collision impossible,
 * which is what allows pruning at all.
 */
export function createTitleFeedback(
  setTitle: SetTitle,
  holdMs: number = DEFAULT_TITLE_HOLD_MS
): TitleFeedback {
  const generations = new Map<string, number>();
  let counter = 0;

  const claim = (context: string): number => {
    const generation = ++counter;
    generations.set(context, generation);
    return generation;
  };

  return {
    flash(context: string, title: string) {
      const generation = claim(context);
      setTitle(context, title);
      setTimeout(() => {
        if (generations.get(context) !== generation) return;
        // An empty title restores the user's configured label.
        setTitle(context, '');
        generations.delete(context);
      }, holdMs);
    },

    /**
     * A failure right after a success would otherwise leave the previous
     * press's "Queued" text on the key next to the ✗ until that older timer
     * expired. Claiming a generation both clears the text and invalidates it.
     */
    clearHeld(context: string) {
      if (!generations.has(context)) return;
      claim(context);
      setTitle(context, '');
      generations.delete(context);
    },

    pendingCount: () => generations.size,
  };
}
