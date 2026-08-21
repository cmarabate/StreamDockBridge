import { deriveCanonicalTitle, cleanTitleText } from './titleCleaner';

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
