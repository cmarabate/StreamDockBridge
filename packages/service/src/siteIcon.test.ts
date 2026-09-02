import { deriveSiteOrigin } from './siteIcon';

const origin = (template: string) => {
  const result = deriveSiteOrigin(template);
  if (!result.ok) throw new Error(`expected an origin, got ${result.reason}`);
  return result.site;
};

const refused = (template: string) => {
  const result = deriveSiteOrigin(template);
  if (result.ok) throw new Error(`expected refusal, got ${result.site.origin}`);
  return result.reason;
};

describe('deriving the site a template points at', () => {
  it('derives the host from the acceptance templates', () => {
    expect(origin('https://www.youtube.com/results?search_query={title}+trailer')).toEqual({
      hostname: 'www.youtube.com',
      origin: 'https://www.youtube.com',
    });
    expect(origin('https://www.rottentomatoes.com/search?search={title}')).toEqual({
      hostname: 'www.rottentomatoes.com',
      origin: 'https://www.rottentomatoes.com',
    });
  });

  it('is unaffected by placeholders in the query', () => {
    expect(origin('https://example.com/search?q={title}').hostname).toBe('example.com');
    expect(origin('https://example.com/s?a={title}&b={rawTitle}&c={url}&d={hostname}').hostname).toBe(
      'example.com'
    );
  });

  it('is unaffected by placeholders in the path', () => {
    expect(origin('https://example.com/{title}/reviews').hostname).toBe('example.com');
    expect(origin('https://example.com/a/{title}/b/{rawTitle}').hostname).toBe('example.com');
  });

  /**
   * The icon belongs to the configured site, not the current media. Two keys
   * differing only in query must resolve to the same origin so the cache is
   * shared and neither a title change nor an edit to the query re-fetches.
   */
  it('gives the same origin for templates differing only in path or query', () => {
    const a = origin('https://www.youtube.com/results?search_query={title}+trailer');
    const b = origin('https://www.youtube.com/results?search_query={title}+review');
    const c = origin('https://www.youtube.com/feed/{title}');
    expect(a.origin).toBe(b.origin);
    expect(b.origin).toBe(c.origin);
  });

  it('distinguishes different hosts', () => {
    expect(origin('https://www.youtube.com/x').origin).not.toBe(
      origin('https://www.rottentomatoes.com/x').origin
    );
  });

  it('keeps a non-default port as part of the origin', () => {
    expect(origin('http://example.com:8080/x?q={title}').origin).toBe('http://example.com:8080');
    // Default ports are normalized away, so these share a cache entry.
    expect(origin('https://example.com:443/x').origin).toBe('https://example.com');
  });

  it('lowercases the hostname so casing cannot split the cache', () => {
    expect(origin('https://WWW.YouTube.COM/x').hostname).toBe('www.youtube.com');
  });

  /**
   * A template whose authority depends on runtime context would mean fetching
   * from a target that cannot be vetted in advance. Detected by substituting
   * two different probe tokens and comparing the resulting authority, rather
   * than by pattern-matching the template text.
   */
  it('refuses a template whose host is dynamic', () => {
    expect(refused('https://{hostname}/search?q={title}')).toBe('dynamic_host');
    expect(refused('https://{title}.example.com/')).toBe('dynamic_host');
    expect(refused('http://{hostname}:8080/x')).toBe('dynamic_host');
    expect(refused('https://sub.{hostname}/x')).toBe('dynamic_host');
  });

  it('refuses non-http schemes and unusable templates', () => {
    expect(refused('javascript:alert({title})')).toBe('unsupported_scheme');
    expect(refused('file:///C:/x')).toBe('unsupported_scheme');
    expect(refused('not a url')).toBe('invalid_template');
    expect(refused('')).toBe('invalid_template');
    expect(refused('   ')).toBe('invalid_template');
  });

  it('refuses credential-bearing origins', () => {
    expect(refused('https://user:pass@example.com/?q={title}')).toBe('invalid_template');
    expect(refused('https://user@example.com/')).toBe('invalid_template');
  });

  /**
   * A local template still yields an origin. Refusing the icon FETCH for it is
   * a separate policy — opening a local URL in the browser stays allowed, and
   * a site whose icon cannot be fetched must not break the action.
   */
  it('derives an origin for local hosts, leaving the fetch policy to decide', () => {
    expect(origin('http://localhost:3000/panel').hostname).toBe('localhost');
    expect(origin('http://192.168.1.10/x').hostname).toBe('192.168.1.10');
  });
});
