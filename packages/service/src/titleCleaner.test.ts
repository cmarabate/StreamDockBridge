import { deriveCanonicalTitle, cleanTitleText, MAX_TITLE_LENGTH } from './titleCleaner';

describe('titleCleaner', () => {
  it('prioritizes jsonLdTitle over ogTitle, twitterTitle, documentTitle, and rawTitle', () => {
    const result = deriveCanonicalTitle({
      jsonLdTitle: 'Dandadan',
      ogTitle: 'Dandadan - OG Title',
      twitterTitle: 'Dandadan - Twitter Title',
      documentTitle: 'Dandadan - Doc Title',
      rawTitle: 'Dandadan - Raw Title',
    });
    expect(result).toBe('Dandadan');
  });

  it('prioritizes ogTitle over twitterTitle, documentTitle, and rawTitle if jsonLd is missing', () => {
    const result = deriveCanonicalTitle({
      ogTitle: 'Chainsaw Man',
      twitterTitle: 'Chainsaw Man - Twitter',
      documentTitle: 'Chainsaw Man - Doc',
      rawTitle: 'Chainsaw Man - Raw',
    });
    expect(result).toBe('Chainsaw Man');
  });

  it('falls back to twitterTitle if jsonLd and ogTitle are missing', () => {
    const result = deriveCanonicalTitle({
      twitterTitle: 'Jujutsu Kaisen',
      documentTitle: 'Jujutsu Kaisen - Doc',
      rawTitle: 'Jujutsu Kaisen - Raw',
    });
    expect(result).toBe('Jujutsu Kaisen');
  });

  it('falls back to cleaned documentTitle if previous metadata is missing', () => {
    const result = deriveCanonicalTitle({
      documentTitle: 'Bleach: Thousand-Year Blood War - Watch on Crunchyroll',
      rawTitle: 'Bleach - Raw',
    });
    expect(result).toBe('Bleach: Thousand-Year Blood War');
  });

  it('falls back to rawTitle if no other metadata exists', () => {
    const result = deriveCanonicalTitle({
      rawTitle: 'Attack on Titan',
    });
    expect(result).toBe('Attack on Titan');
  });

  it('handles absent metadata cleanly by returning empty string', () => {
    expect(deriveCanonicalTitle({})).toBe('');
  });

  it('cleans Crunchyroll-style titles', () => {
    expect(cleanTitleText('Dandadan - Watch on Crunchyroll')).toBe('Dandadan');
    expect(cleanTitleText('Frieren: Beyond Journey\'s End | Crunchyroll')).toBe('Frieren: Beyond Journey\'s End');
  });

  it('cleans IMDb-style titles', () => {
    expect(cleanTitleText('Dandadan (TV Series 2024– ) - IMDb')).toBe('Dandadan');
    expect(cleanTitleText('The Batman (Movie 2022) - IMDb')).toBe('The Batman');
    expect(cleanTitleText('Inception - IMDb')).toBe('Inception');
  });

  it('preserves punctuation and normal titles', () => {
    expect(cleanTitleText('Spider-Man: Across the Spider-Verse')).toBe('Spider-Man: Across the Spider-Verse');
    expect(cleanTitleText('Blade Runner 2049')).toBe('Blade Runner 2049');
  });

  it('does not over-clean unrelated normal titles', () => {
    expect(cleanTitleText('How to Build a Web App')).toBe('How to Build a Web App');
  });
});

/**
 * Regression fixture from the owner's physical canary on 2026-08-30.
 *
 * The N4 IMDb key fired correctly and opened a search, but the query was the
 * whole flattened page title, so IMDb could not surface the show.
 */
const PRIME_VIDEO_TV_TITLE = 'Watch Gary and His Demons Season 2 | Prime Video';

describe('work-level title for episodic content', () => {
  it('reduces the failing Prime Video TV title to the series name', () => {
    expect(cleanTitleText(PRIME_VIDEO_TV_TITLE)).toBe('Gary and His Demons');
  });

  it('derives the same work title through the full metadata chain', () => {
    // The real context carried no og/twitter/JSON-LD at all — only the title.
    expect(
      deriveCanonicalTitle({
        rawTitle: PRIME_VIDEO_TV_TITLE,
        documentTitle: PRIME_VIDEO_TV_TITLE,
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
      })
    ).toBe('Gary and His Demons');
  });

  it('removes season qualifiers in the spellings providers actually use', () => {
    expect(cleanTitleText('The Bear Season 3')).toBe('The Bear');
    expect(cleanTitleText('The Bear Season Three')).toBe('The Bear');
    expect(cleanTitleText('The Bear S03')).toBe('The Bear');
    expect(cleanTitleText('The Bear S03E04')).toBe('The Bear');
    expect(cleanTitleText('The Bear S3 E4')).toBe('The Bear');
    expect(cleanTitleText('The Bear Season 2 Episode 4')).toBe('The Bear');
    expect(cleanTitleText('The Bear Episode 4')).toBe('The Bear');
    expect(cleanTitleText('The Bear: Season 2')).toBe('The Bear');
    expect(cleanTitleText('The Bear - Season 2')).toBe('The Bear');
    // UK and localised usage
    expect(cleanTitleText('Taskmaster Series 12')).toBe('Taskmaster');
    expect(cleanTitleText('Dark Staffel 2')).toBe('Dark');
  });

  it('strips provider suffixes, including the one that was missing', () => {
    expect(cleanTitleText('Gary and His Demons | Prime Video')).toBe('Gary and His Demons');
    expect(cleanTitleText('Severance | Apple TV+')).toBe('Severance');
    expect(cleanTitleText('Shogun | Hulu')).toBe('Shogun');
    expect(cleanTitleText('Andor | Disney+')).toBe('Andor');
    expect(cleanTitleText('The Last of Us | Max')).toBe('The Last of Us');
    expect(cleanTitleText('Dandadan | Crunchyroll')).toBe('Dandadan');
    expect(cleanTitleText('Squid Game | Netflix')).toBe('Squid Game');
  });

  it('only drops a leading Watch/Stream verb on a provider page', () => {
    expect(cleanTitleText('Watch Severance | Apple TV+')).toBe('Severance');
    expect(cleanTitleText('Stream Andor | Disney+')).toBe('Andor');
    // No provider suffix, so the verb is treated as part of the work's name.
    expect(cleanTitleText('Watch Out')).toBe('Watch Out');
    expect(cleanTitleText('Watchmen')).toBe('Watchmen');
  });

  it('prefers structured series metadata over any flattened display title', () => {
    expect(
      deriveCanonicalTitle({
        jsonLdSeriesTitle: 'Gary and His Demons',
        jsonLdTitle: 'Hell Is Other Demons',
        ogTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
        documentTitle: PRIME_VIDEO_TV_TITLE,
      })
    ).toBe('Gary and His Demons');

    // An episode title would otherwise win and search for the wrong thing.
    expect(
      deriveCanonicalTitle({
        jsonLdSeriesTitle: 'Severance',
        jsonLdTitle: 'Good News About Hell',
      })
    ).toBe('Severance');
  });

  it('falls back cleanly when no structured series metadata exists', () => {
    expect(
      deriveCanonicalTitle({ jsonLdSeriesTitle: '', ogTitle: 'The Bear Season 3' })
    ).toBe('The Bear');
    expect(deriveCanonicalTitle({ jsonLdSeriesTitle: '   ', documentTitle: 'Heat' })).toBe('Heat');
  });
});

describe('legitimate titles are not damaged', () => {
  it('preserves works whose names end in numbers', () => {
    for (const title of [
      'District 9',
      '1923',
      'Catch-22',
      '9-1-1',
      'Se7en',
      'Toy Story 3',
      'Apollo 13',
      'Ocean\'s 11',
      'Fantastic 4',
      'Area 51',
      'M3GAN',
      'Blade Runner 2049',
    ]) {
      expect(cleanTitleText(title)).toBe(title);
    }
  });

  it('preserves works containing season-like or episode-like words', () => {
    expect(cleanTitleText('Season of the Witch')).toBe('Season of the Witch');
    expect(cleanTitleText('A Season for Miracles')).toBe('A Season for Miracles');
    expect(cleanTitleText('Star Wars: Episode IV - A New Hope')).toBe(
      'Star Wars: Episode IV - A New Hope'
    );
    expect(cleanTitleText('The Final Season')).toBe('The Final Season');
  });

  it('leaves Part and Vol qualifiers alone, since real titles use them', () => {
    // Not safely separable from season numbering, so deliberately untouched.
    expect(cleanTitleText('Kill Bill: Vol. 2')).toBe('Kill Bill: Vol. 2');
    expect(cleanTitleText('Harry Potter and the Deathly Hallows: Part 2')).toBe(
      'Harry Potter and the Deathly Hallows: Part 2'
    );
    expect(cleanTitleText('Dune: Part Two')).toBe('Dune: Part Two');
  });

  it('never reduces a title to nothing', () => {
    for (const title of ['Season 2', 'S02', 'Episode 4', 'Season Two']) {
      expect(cleanTitleText(title)).toBe(title);
    }
  });

  /**
   * Both were caught by these tests during development. "Ocean's 11" lost its
   * tail because the S-code pattern matched the `s 11` inside `Ocean's`, and
   * "Preseason 2" would lose its head for the same reason. A qualifier now has
   * to start at a word gap.
   */
  it('does not bite into a word that merely ends like a qualifier', () => {
    expect(cleanTitleText("Ocean's 11")).toBe("Ocean's 11");
    expect(cleanTitleText("Ocean's Eleven")).toBe("Ocean's Eleven");
    expect(cleanTitleText('Preseason 2')).toBe('Preseason 2');
    expect(cleanTitleText('Reseason 3')).toBe('Reseason 3');
  });

  it('keeps ordinary movie titles untouched', () => {
    for (const title of ['Heat', 'The Godfather', 'Mad Max', 'Arrival', 'Whiplash']) {
      expect(cleanTitleText(title)).toBe(title);
    }
  });
});

/**
 * Templates observed on the providers themselves. Several were captured live;
 * the rest come from search-indexed titles for real title pages. They exist
 * because the original bug was a provider ("Prime Video") simply missing from
 * the suffix list, and because Prime Video alone emits four different shapes.
 */
describe('provider title templates', () => {
  const cases: Array<[string, string]> = [
    ['Watch Gary and His Demons Season 2 | Prime Video', 'Gary and His Demons'],
    // primevideo.com uses an EN DASH, not a pipe or hyphen.
    ['Watch Gary and His Demons Season 2 – Prime Video', 'Gary and His Demons'],
    // …and sometimes leads with the brand instead of trailing it.
    ['Prime Video: Gary and His Demons Season 2', 'Gary and His Demons'],
    ['Gary and His Demons, Season 1', 'Gary and His Demons'],
    // Apple TV prefixes document.title with U+200E, which \s does not match.
    ['‎Watch Severance - Show - Apple TV', 'Severance'],
    ['Watch Full Swing | Netflix Official Site', 'Full Swing'],
    ['Watch Paradise Streaming Online | Hulu', 'Paradise'],
    ['Watch Storm Over Europe Streaming Online | Tubi Free TV', 'Storm Over Europe'],
    ['9-1-1 | Watch Full Episodes | Disney+', '9-1-1'],
    ['24 | Watch Full Episodes | Disney+', '24'],
    ['Watch Supernatural Season 13 | Max', 'Supernatural'],
    ['Tracker Seasons & Episodes - Watch on Paramount+', 'Tracker'],
    ['Watch Us Season 1 Streaming Online | Peacock', 'Us'],
    ['JUJUTSU KAISEN Season 3 Episode 59 - Watch on Crunchyroll', 'JUJUTSU KAISEN'],
    ['Watch Gachiakuta - Crunchyroll', 'Gachiakuta'],
    ['Gary and His Demons - Wikipedia', 'Gary and His Demons'],
  ];

  for (const [input, expected] of cases) {
    it(`reduces ${JSON.stringify(input)}`, () => {
      expect(cleanTitleText(input)).toBe(expected);
    });
  }
});

describe('title normalization safety', () => {
  it('keeps a single common word from being treated as chrome', () => {
    // "Show" is only chrome when a separator sets it apart, as Apple TV does.
    expect(cleanTitleText('The Truman Show')).toBe('The Truman Show');
    expect(cleanTitleText('The Truman Show | Netflix')).toBe('The Truman Show');
  });

  it('survives adversarial input without pathological backtracking', () => {
    const inputs = [
      'A'.repeat(5000) + ' Season ' + '9'.repeat(200),
      ' '.repeat(20000) + 'x',
      '-'.repeat(5000) + 'Season 2',
      '|'.repeat(5000) + 'Prime Video',
      ' -'.repeat(5000) + ' Season 2',
    ];
    for (const input of inputs) {
      const started = Date.now();
      cleanTitleText(input);
      // Page titles are attacker-influenced input into a long-running service.
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('handles empty and punctuation-only input without throwing', () => {
    expect(cleanTitleText('')).toBe('');
    expect(cleanTitleText('   ')).toBe('');
    // Punctuation-only input is returned as-is: dangling separators are only
    // tidied when this function itself exposed them, which is what keeps the
    // real film "-30-" from being reduced to "30".
    expect(cleanTitleText('|')).toBe('|');
    expect(cleanTitleText('-30-')).toBe('-30-');
    expect(cleanTitleText('‎')).toBe('');
    expect(cleanTitleText('🎬 Movie Night')).toBe('🎬 Movie Night');
  });

  /**
   * KNOWN LIMITATION, deliberately asserted so the tradeoff is visible.
   *
   * "Open Season 2" is a real film, and nothing in the string distinguishes it
   * from a show called "Open" in its second season. There is no string-level
   * fix. Structured series metadata resolves it wherever a provider supplies
   * any — which Prime Video, the provider that prompted this work, does not.
   */
  it('documents the unavoidable false positive on a title that ends in a season phrase', () => {
    expect(cleanTitleText('Open Season 2')).toBe('Open');

    // Structured metadata resolves it: a declared series name is work-level
    // already, so qualifier stripping is not applied to it at all.
    expect(
      deriveCanonicalTitle({ jsonLdSeriesTitle: 'Open Season 2', documentTitle: 'Open Season 2' })
    ).toBe('Open Season 2');

    // The same protection for a genuine series whose name ends in a number.
    expect(deriveCanonicalTitle({ jsonLdSeriesTitle: '1923' })).toBe('1923');
    expect(cleanTitleText('Open Season 2', { stripQualifiers: false })).toBe('Open Season 2');
  });
});

/**
 * Every case below is a defect an adversarial review found in an earlier draft
 * of this normalizer. They are the reason the rules look the way they do.
 */
describe('adversarial review regressions', () => {
  it('normalizes titles in non-Latin scripts', () => {
    // An ASCII-only substance check silently disabled every rule for these,
    // returning the raw title with the provider name still attached.
    expect(cleanTitleText('千と千尋の神隠し | Netflix')).toBe('千と千尋の神隠し');
    expect(cleanTitleText('오징어 게임 | Netflix')).toBe('오징어 게임');
    expect(cleanTitleText('Слово пацана | Netflix')).toBe('Слово пацана');
    expect(cleanTitleText('Ζορμπάς | Netflix')).toBe('Ζορμπάς');
    expect(cleanTitleText('مسلسل رمضان | Netflix')).toBe('مسلسل رمضان');
    expect(cleanTitleText('鬼滅の刃 Season 2 | Netflix')).toBe('鬼滅の刃');
  });

  it('does not behead a title that merely starts with a provider word', () => {
    // A prefix rule needs only a colon to fire, so it uses a much narrower
    // provider list than the separator-gated suffix rule.
    expect(cleanTitleText('Max: The Curse of Brotherhood')).toBe('Max: The Curse of Brotherhood');
    expect(cleanTitleText('Plex: The Movie')).toBe('Plex: The Movie');
    expect(cleanTitleText('Peacock: A Bird Story')).toBe('Peacock: A Bird Story');
    // The one verified prefix form still works.
    expect(cleanTitleText('Prime Video: Gary and His Demons Season 2')).toBe('Gary and His Demons');
  });

  it('re-examines the title after a strip exposes another marker', () => {
    // Single-pass stripping left these half-cleaned.
    expect(cleanTitleText('Show | Netflix Season 2')).toBe('Show');
    expect(cleanTitleText('The Bear - Hulu Season 3')).toBe('The Bear');
    expect(cleanTitleText('The Boys - Season 4 - Prime Video | Amazon.com')).toBe('The Boys');
  });

  it('leaves punctuation alone in a title it did not otherwise touch', () => {
    // "-30-" is a real 1959 film; tidying separators unconditionally ate it.
    expect(cleanTitleText('-30-')).toBe('-30-');
    expect(cleanTitleText('Alien:')).toBe('Alien:');
  });

  it('bounds work by title length so a hostile page cannot stall the service', () => {
    // Page titles are attacker-influenced input to a single-threaded service the
    // hardware button depends on. Unbounded, punctuation runs went quadratic:
    // 80k characters took over 15 seconds.
    for (const n of [20000, 200000]) {
      const started = Date.now();
      cleanTitleText('A' + '-'.repeat(n) + ' Zzz');
      expect(Date.now() - started).toBeLessThan(250);
    }
    expect(MAX_TITLE_LENGTH).toBeLessThanOrEqual(400);
  });
});
