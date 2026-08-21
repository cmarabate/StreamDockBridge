import { extractPageMetadata } from './metadata';

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
