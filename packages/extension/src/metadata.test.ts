/**
 * @jest-environment jsdom
 */
import { extractPageMetadata } from './metadata';

describe('extractPageMetadata', () => {
  it('extracts document.title, og:title, twitter:title, and JSON-LD title correctly', () => {
    document.title = 'Test Document Title';

    const ogMeta = document.createElement('meta');
    ogMeta.setAttribute('property', 'og:title');
    ogMeta.setAttribute('content', 'OG Title Test');
    document.head.appendChild(ogMeta);

    const twMeta = document.createElement('meta');
    twMeta.setAttribute('name', 'twitter:title');
    twMeta.setAttribute('content', 'Twitter Title Test');
    document.head.appendChild(twMeta);

    const jsonLdScript = document.createElement('script');
    jsonLdScript.setAttribute('type', 'application/ld+json');
    jsonLdScript.textContent = JSON.stringify({
      '@type': 'TVSeries',
      'name': 'Dandadan',
    });
    document.head.appendChild(jsonLdScript);

    const meta = extractPageMetadata(document);
    expect(meta.documentTitle).toBe('Test Document Title');
    expect(meta.ogTitle).toBe('OG Title Test');
    expect(meta.twitterTitle).toBe('Twitter Title Test');
    expect(meta.jsonLdTitle).toBe('Dandadan');
  });
});
