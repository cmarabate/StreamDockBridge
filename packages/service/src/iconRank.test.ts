import {
  scoreActualDimensions,
  scoreDeclared,
  orderCandidates,
  isExcellent,
  IconCandidate,
  KEY_PIXELS,
  MIN_USEFUL_PIXELS,
} from './iconRank';

const candidate = (
  href: string,
  declaredSize = 0,
  source: IconCandidate['source'] = 'link'
): IconCandidate => ({ href, declaredSize, source });

/** Lower score wins, so "better than" means a strictly smaller score. */
const betterThan = (a: [number, number], b: [number, number]) =>
  scoreActualDimensions(a[0], a[1]) < scoreActualDimensions(b[0], b[1]);

describe('scoring an icon by the pixels that actually arrived', () => {
  /**
   * The defect this whole ranking exists to prevent: ReelGood's 64x64
   * favicon.ico beat its declared 120x120 icon and looked blurry upscaled to a
   * ~126px key.
   */
  it('prefers ReelGood\'s 120x120 icon over its 64x64 favicon', () => {
    expect(betterThan([120, 120], [64, 64])).toBe(true);
  });

  it('prefers the smallest asset that still covers the key', () => {
    expect(betterThan([144, 144], [512, 512])).toBe(true);
    expect(betterThan([128, 128], [1024, 1024])).toBe(true);
    // ...but a covering asset always beats one that must be upscaled.
    expect(betterThan([512, 512], [96, 96])).toBe(true);
  });

  it('prefers larger among assets that cannot cover the key', () => {
    expect(betterThan([120, 120], [96, 96])).toBe(true);
    expect(betterThan([64, 64], [32, 32])).toBe(true);
    expect(betterThan([32, 32], [16, 16])).toBe(true);
  });

  it('ranks the usual real-world sizes in a sensible order', () => {
    const sizes: Array<[number, number]> = [
      [16, 16],
      [32, 32],
      [64, 64],
      [96, 96],
      [120, 120],
      [180, 180],
      [144, 144],
      [512, 512],
    ];
    const ranked = [...sizes].sort(
      (a, b) => scoreActualDimensions(a[0], a[1]) - scoreActualDimensions(b[0], b[1])
    );
    // 144 and 180 cover the key; 144 is closest to it, so it leads.
    expect(ranked[0]).toEqual([144, 144]);
    expect(ranked[1]).toEqual([180, 180]);
    expect(ranked[2]).toEqual([512, 512]);
    // Then the ones that must be upscaled, largest first.
    expect(ranked[3]).toEqual([120, 120]);
    expect(ranked[4]).toEqual([96, 96]);
    expect(ranked[ranked.length - 1]).toEqual([16, 16]);
  });

  /** A square asset fills a square key; a banner letterboxes. */
  it('prefers a square asset over a lopsided one of the same height', () => {
    expect(betterThan([160, 160], [400, 160])).toBe(true);
    // But only as a tiebreaker — it never outweighs a whole band.
    expect(betterThan([400, 160], [64, 64])).toBe(true);
  });

  it('uses the smaller side, because that is what bounds a square key', () => {
    // 400x64 is only 64px tall, so it is no better than a 64x64.
    expect(scoreActualDimensions(400, 64)).toBeGreaterThan(scoreActualDimensions(128, 128));
  });

  it('refuses degenerate dimensions', () => {
    expect(scoreActualDimensions(0, 100)).toBe(Number.POSITIVE_INFINITY);
    expect(scoreActualDimensions(100, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(scoreActualDimensions(-1, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('knows when a candidate is good enough to stop downloading', () => {
    expect(isExcellent(128, 128)).toBe(true);
    expect(isExcellent(180, 180)).toBe(true);
    expect(isExcellent(256, 256)).toBe(true);
    // Too small to cover the key.
    expect(isExcellent(64, 64)).toBe(false);
    expect(isExcellent(120, 120)).toBe(false);
    // Bigger than needed — keep looking for something closer to the key.
    expect(isExcellent(512, 512)).toBe(false);
    // Not square.
    expect(isExcellent(200, 130)).toBe(false);
    expect(KEY_PIXELS).toBe(126);
  });
});

describe('download order from what the page declared', () => {
  it('tries a declared covering size first, smallest such leading', () => {
    const ordered = orderCandidates([
      candidate('/a.png', 16),
      candidate('/b.png', 144),
      candidate('/c.png', 512),
    ]);
    expect(ordered.map((c) => c.href)).toEqual(['/b.png', '/c.png', '/a.png']);
  });

  /**
   * The ReelGood shape: a good icon that declares no size at all. Burying
   * undeclared candidates behind every 16x16 that bothered to declare itself is
   * exactly how the blurry icon was chosen.
   */
  it('tries an undeclared candidate before a declared tiny one', () => {
    const ordered = orderCandidates([candidate('/tiny.png', 16), candidate('/unknown.png', 0)]);
    expect(ordered[0].href).toBe('/unknown.png');
  });

  it('prefers apple-touch and manifest sources when nothing declares a size', () => {
    const ordered = orderCandidates([
      candidate('/fallback.ico', 0, 'fallback'),
      candidate('/plain.png', 0, 'link'),
      candidate('/manifest.png', 0, 'manifest'),
      candidate('/touch.png', 0, 'apple-touch'),
    ]);
    expect(ordered.map((c) => c.href)).toEqual([
      '/touch.png',
      '/manifest.png',
      '/plain.png',
      '/fallback.ico',
    ]);
  });

  it('drops duplicate hrefs so one asset is never downloaded twice', () => {
    const ordered = orderCandidates([
      candidate('/same.png', 180),
      candidate('/same.png', 0, 'fallback'),
      candidate('/other.png', 180),
    ]);
    expect(ordered).toHaveLength(2);
  });

  it('keeps a declared covering size ahead of every undeclared guess', () => {
    expect(scoreDeclared(candidate('/big.png', 180))).toBeLessThan(
      scoreDeclared(candidate('/touch.png', 0, 'apple-touch'))
    );
    expect(MIN_USEFUL_PIXELS).toBe(96);
  });
});
