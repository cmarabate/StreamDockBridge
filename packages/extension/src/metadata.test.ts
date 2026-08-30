import { extractPageMetadata, extractSeriesTitle } from './metadata';

describe('extractPageMetadata JSON-LD & Title Selection', () => {
  function makeMockDoc(opts: { title?: string; ogTitle?: string; twitterTitle?: string; jsonLd?: any }): Document {
    const scripts: any[] = [];
    if (opts.jsonLd !== undefined) {
      scripts.push({
        textContent: typeof opts.jsonLd === 'string' ? opts.jsonLd : JSON.stringify(opts.jsonLd),
      });
    }

    return {
      title: opts.title || '',
      querySelector: (selector: string) => {
        if (selector.includes('og:title') && opts.ogTitle) {
          return { getAttribute: (a: string) => (a === 'content' ? opts.ogTitle : null) };
        }
        if (selector.includes('twitter:title') && opts.twitterTitle) {
          return { getAttribute: (a: string) => (a === 'content' ? opts.twitterTitle : null) };
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes('ld+json')) return scripts;
        return [];
      },
    } as unknown as Document;
  }

  it('Test A: Organization name + Movie name => Movie wins', () => {
    const doc = makeMockDoc({
      title: 'Movie Title - Site',
      jsonLd: [
        { '@type': 'Organization', name: 'Crunchyroll Corp' },
        { '@type': 'Movie', name: 'Demon Slayer Movie' }
      ]
    });
    const meta = extractPageMetadata(doc);
    expect(meta.jsonLdTitle).toBe('Demon Slayer Movie');
  });

  it('Test B: WebSite name + TVSeries in @graph => TVSeries wins', () => {
    const doc = makeMockDoc({
      title: 'Dandadan Watch Page',
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: 'Crunchyroll' },
          { '@type': 'TVSeries', name: 'Dandadan' }
        ]
      }
    });
    const meta = extractPageMetadata(doc);
    expect(meta.jsonLdTitle).toBe('Dandadan');
  });

  it('Test C: BreadcrumbList + VideoObject => VideoObject wins', () => {
    const doc = makeMockDoc({
      title: 'Video Page',
      jsonLd: [
        { '@type': 'BreadcrumbList', name: 'Home > Videos' },
        { '@type': 'VideoObject', name: 'Chainsaw Man Trailer' }
      ]
    });
    const meta = extractPageMetadata(doc);
    expect(meta.jsonLdTitle).toBe('Chainsaw Man Trailer');
  });

  it('Test D: Only untyped arbitrary object with name => jsonLdTitle is undefined', () => {
    const doc = makeMockDoc({
      title: 'Untyped Page',
      jsonLd: { name: 'Random Site Data', url: 'https://example.com' }
    });
    const meta = extractPageMetadata(doc);
    expect(meta.jsonLdTitle).toBeUndefined();
  });

  it('Test E: Array containing non-media then CreativeWork => CreativeWork wins', () => {
    const doc = makeMockDoc({
      title: 'Book Page',
      jsonLd: [
        { '@type': 'Person', name: 'Author Name' },
        { '@type': 'CreativeWork', name: 'Attack on Titan' }
      ]
    });
    const meta = extractPageMetadata(doc);
    expect(meta.jsonLdTitle).toBe('Attack on Titan');
  });
});

describe('structured series extraction', () => {
  it('reads the series a TVEpisode declares it belongs to', () => {
    expect(
      extractSeriesTitle({
        '@type': 'TVEpisode',
        name: 'Hell Is Other Demons',
        partOfSeries: { '@type': 'TVSeries', name: 'Gary and His Demons' },
      })
    ).toBe('Gary and His Demons');
  });

  it('reaches the series through a season when that is the only path', () => {
    expect(
      extractSeriesTitle({
        '@type': 'TVEpisode',
        name: 'Episode 4',
        partOfSeason: {
          '@type': 'TVSeason',
          seasonNumber: 2,
          partOfSeries: { '@type': 'TVSeries', name: 'Severance' },
        },
      })
    ).toBe('Severance');
  });

  it('treats a TVSeries node as its own series', () => {
    expect(extractSeriesTitle({ '@type': 'TVSeries', name: 'The Bear' })).toBe('The Bear');
  });

  it('falls back to isPartOf only when it is actually a series', () => {
    expect(
      extractSeriesTitle({
        '@type': 'TVEpisode',
        isPartOf: { '@type': 'TVSeries', name: 'Taskmaster' },
      })
    ).toBe('Taskmaster');
  });

  /**
   * isPartOf is the generic containment property and commonly points at the
   * site rather than a series. Untyped, this fed "Prime Video" into the
   * highest-priority title source and every lookup searched for the provider.
   */
  it('refuses an isPartOf that names the website rather than a series', () => {
    expect(
      extractSeriesTitle({
        '@type': 'Movie',
        name: 'Heat',
        isPartOf: { '@type': 'WebSite', name: 'Prime Video' },
      })
    ).toBe('');
    expect(
      extractSeriesTitle({
        '@type': 'NewsArticle',
        isPartOf: { '@type': 'WebPage', name: 'The Guardian' },
      })
    ).toBe('');
    // No @type at all is not evidence of a series either.
    expect(extractSeriesTitle({ '@type': 'TVEpisode', isPartOf: { name: 'Taskmaster' } })).toBe('');
  });

  it('ignores a bare isPartOf URL, which carries no title', () => {
    expect(extractSeriesTitle({ '@type': 'TVEpisode', isPartOf: 'https://example.com/series/1' })).toBe('');
  });

  it('reads series properties emitted as single-element arrays', () => {
    expect(
      extractSeriesTitle({ '@type': 'TVEpisode', partOfSeries: [{ '@type': 'TVSeries', name: 'Severance' }] })
    ).toBe('Severance');
    expect(
      extractSeriesTitle({
        '@type': 'TVEpisode',
        partOfSeason: [{ '@type': 'TVSeason', partOfSeries: [{ '@type': 'TVSeries', name: 'Dark' }] }],
      })
    ).toBe('Dark');
  });

  it('returns nothing for a movie or an unrelated node', () => {
    expect(extractSeriesTitle({ '@type': 'Movie', name: 'Heat' })).toBe('');
    expect(extractSeriesTitle(null)).toBe('');
    expect(extractSeriesTitle({})).toBe('');
  });
});


/**
 * Title and series must be taken from the same node. Filling them independently
 * let a recommendations carousel supply the series while the principal node
 * supplied the title — and since series outranks title downstream, the carousel
 * won.
 */
describe('principal node selection', () => {
  function docWith(blocks: any[]): any {
    const scripts = blocks.map((b) => ({ textContent: JSON.stringify(b) }));
    return {
      title: 'ignored',
      location: { href: 'https://example.com/x' },
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel.indexOf('ld+json') >= 0 ? scripts : [],
    };
  }

  it('does not let a later carousel node supply the series', () => {
    const meta = extractPageMetadata(
      docWith([
        { '@graph': [{ '@type': 'Movie', name: 'Heat' }, { '@type': 'TVSeries', name: 'More Like This: The Bear' }] },
      ])
    );
    expect(meta.jsonLdTitle).toBe('Heat');
    expect(meta.jsonLdSeriesTitle).toBeUndefined();
  });

  it('does not let a second script block supply the series', () => {
    const meta = extractPageMetadata(
      docWith([{ '@type': 'Movie', name: 'Dune' }, { '@type': 'TVSeries', name: 'Squid Game' }])
    );
    expect(meta.jsonLdTitle).toBe('Dune');
    expect(meta.jsonLdSeriesTitle).toBeUndefined();
  });

  it('takes both fields from one principal episode node', () => {
    const meta = extractPageMetadata(
      docWith([
        {
          '@type': 'TVEpisode',
          name: 'Good News About Hell',
          partOfSeries: { '@type': 'TVSeries', name: 'Severance' },
        },
      ])
    );
    expect(meta.jsonLdTitle).toBe('Good News About Hell');
    expect(meta.jsonLdSeriesTitle).toBe('Severance');
  });

  it('never lets a season node become the work title', () => {
    // A TVSeason's own name is "Season 2", which is not a title.
    const meta = extractPageMetadata(
      docWith([
        { '@type': 'TVSeason', name: 'Season 2', partOfSeries: { '@type': 'TVSeries', name: 'Dark' } },
      ])
    );
    expect(meta.jsonLdTitle).toBeUndefined();
    expect(meta.jsonLdSeriesTitle).toBe('Dark');
  });
});
