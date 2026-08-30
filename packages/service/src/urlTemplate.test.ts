import {
  resolveUrlTemplate,
  validateResolvedUrl,
  placeholderValuesFrom,
  PLACEHOLDERS,
  PlaceholderValues,
} from './urlTemplate';
import { ContextRecord } from './contextStore';

/**
 * The owner's real captured context, from the physical canary on 2026-08-30.
 * `title` is the canonicalTitle the existing authority derives — the season
 * qualifier and provider suffix are already gone by the time a template sees it.
 */
const CONTEXT: PlaceholderValues = {
  title: 'Gary and His Demons',
  rawTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
  url: 'https://www.amazon.com/gp/video/detail/0QD2FDHVUZNOEJDT5JE9SSRBQX/ref=atv_plr_detail_play',
  hostname: 'www.amazon.com',
};

const ok = (template: string, values: PlaceholderValues = CONTEXT) => {
  const result = resolveUrlTemplate(template, values);
  if (!result.ok) throw new Error(`expected success, got ${result.error}`);
  return result.url;
};

const err = (template: string, values: PlaceholderValues = CONTEXT) => {
  const result = resolveUrlTemplate(template, values);
  if (result.ok) throw new Error(`expected failure, got ${result.url}`);
  return result.error;
};

describe('placeholder substitution', () => {
  it('substitutes the canonical work title', () => {
    expect(ok('https://example.com/?q={title}')).toBe(
      'https://example.com/?q=Gary%20and%20His%20Demons'
    );
  });

  it('substitutes the raw page title', () => {
    expect(ok('https://example.com/?q={rawTitle}')).toBe(
      'https://example.com/?q=Watch%20Gary%20and%20His%20Demons%20Season%202%20%7C%20Prime%20Video'
    );
  });

  it('substitutes the page URL', () => {
    expect(ok('https://example.com/?u={url}')).toContain(
      'u=https%3A%2F%2Fwww.amazon.com%2Fgp%2Fvideo'
    );
  });

  it('substitutes the hostname', () => {
    expect(ok('https://example.com/?h={hostname}')).toBe('https://example.com/?h=www.amazon.com');
  });

  it('substitutes a placeholder used more than once', () => {
    expect(ok('https://example.com/?title={title}&q={title}')).toBe(
      'https://example.com/?title=Gary%20and%20His%20Demons&q=Gary%20and%20His%20Demons'
    );
  });

  it('percent-encodes values but leaves template text literal', () => {
    // The `+` belongs to the template, so it stays a literal separator while
    // the substituted spaces become %20.
    expect(ok('https://www.google.com/search?q={title}+ending+explained')).toBe(
      'https://www.google.com/search?q=Gary%20and%20His%20Demons+ending+explained'
    );
  });

  it('encodes characters that would otherwise restructure the URL', () => {
    const hostile: PlaceholderValues = {
      ...CONTEXT,
      title: 'A&B?c#d=e /f',
    };
    const resolved = ok('https://example.com/?q={title}&safe=1', hostile);
    expect(resolved).toBe('https://example.com/?q=A%26B%3Fc%23d%3De%20%2Ff&safe=1');
    // The injected value cannot add a parameter or a fragment.
    expect(new URL(resolved).searchParams.get('q')).toBe('A&B?c#d=e /f');
    expect(new URL(resolved).searchParams.get('safe')).toBe('1');
  });

  /** The exact case the owner reported from the N4. */
  it('uses the work title, not the season-qualified page title', () => {
    const resolved = ok('https://www.youtube.com/results?search_query={title}+trailer');
    expect(resolved).toBe(
      'https://www.youtube.com/results?search_query=Gary%20and%20His%20Demons+trailer'
    );
    expect(resolved).not.toContain('Season');
    expect(resolved).not.toContain('Prime');
  });

  it('accepts a static URL with no placeholders', () => {
    expect(ok('https://example.com/dashboard')).toBe('https://example.com/dashboard');
    expect(ok('http://127.0.0.1:8080/panel')).toBe('http://127.0.0.1:8080/panel');
  });

  it('exposes exactly the four approved placeholders', () => {
    expect([...PLACEHOLDERS].sort()).toEqual(['hostname', 'rawTitle', 'title', 'url']);
  });
});

describe('template rejection', () => {
  it('rejects an empty or blank template', () => {
    expect(err('')).toBe('empty_template');
    expect(err('   ')).toBe('empty_template');
  });

  it('rejects an unknown placeholder rather than passing it through', () => {
    // Silently forwarding "{foo}" would search a site for literal braces.
    expect(err('{foo}')).toBe('unknown_placeholder');
    expect(err('https://example.com/?q={foo}')).toBe('unknown_placeholder');
    expect(err('https://example.com/?q={settings.secret}')).toBe('unknown_placeholder');
    expect(err('https://example.com/?q={TITLE}')).toBe('unknown_placeholder');
  });

  it('rejects an unbalanced brace', () => {
    expect(err('https://example.com/{title')).toBe('malformed_template');
    expect(err('https://example.com/}x')).toBe('malformed_template');
  });

  it('rejects a template that resolves to something unparseable', () => {
    expect(err('not a url')).toBe('invalid_resolved_url');
    expect(err('{title}')).toBe('invalid_resolved_url');
  });

  it('reports missing context rather than searching for nothing', () => {
    const empty: PlaceholderValues = { title: '', rawTitle: '', url: '', hostname: '' };
    expect(err('https://example.com/?q={title}', empty)).toBe('no_usable_context');
  });

  it('bounds template and resolved length', () => {
    expect(err('https://example.com/?q=' + 'a'.repeat(3000))).toBe('template_too_long');
    // Under the template cap, but the substituted values push it over.
    const longTitle: PlaceholderValues = { ...CONTEXT, title: 'a'.repeat(2100) };
    expect(err('https://example.com/?q={title}&b={title}', longTitle)).toBe('resolved_url_too_long');
  });
});

describe('URL security policy', () => {
  it('permits only http and https', () => {
    for (const scheme of [
      'javascript:alert(1)',
      'javascript:alert({title})',
      'data:text/html,<h1>x</h1>',
      'file:///C:/Windows/System32/config',
      'chrome://extensions',
      'edge://settings',
      'about:blank',
      'shell:startup',
      'vbscript:msgbox(1)',
      'ftp://example.com/x',
      'ws://example.com/x',
    ]) {
      expect(err(scheme)).toBe('unsupported_scheme');
    }
    expect(ok('https://example.com/x')).toBe('https://example.com/x');
    expect(ok('http://example.com/x')).toBe('http://example.com/x');
  });

  it('rejects credential-bearing URLs', () => {
    expect(err('https://user:pass@example.com/?q={title}')).toBe('credentials_not_allowed');
    expect(err('https://user@example.com/')).toBe('credentials_not_allowed');
  });

  it('re-validates the FINAL resolved URL, not just the template', () => {
    // A template whose literal text is a valid URL can still resolve to a
    // hostile one, so validation happens after substitution.
    expect(validateResolvedUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateResolvedUrl('https://example.com/ok').ok).toBe(true);
    const sneaky: PlaceholderValues = { ...CONTEXT, title: 'x' };
    expect(err('javascript:void({title})', sneaky)).toBe('unsupported_scheme');
  });

  it('cannot be used to name anything outside the approved set', () => {
    // No property paths, no expressions, no nested access.
    for (const t of [
      'https://e.com/?q={context.canonicalTitle}',
      'https://e.com/?q={process.env.SECRET}',
      'https://e.com/?q={__proto__}',
      'https://e.com/?q={constructor}',
      'https://e.com/?q={}',
    ]) {
      expect(err(t)).toBe('unknown_placeholder');
    }
  });
});

describe('placeholderValuesFrom', () => {
  it('projects only the four approved fields from the context record', () => {
    const record: ContextRecord = {
      url: 'https://example.com/watch',
      hostname: 'example.com',
      rawTitle: 'Raw Title',
      documentTitle: 'Doc Title',
      ogTitle: 'og',
      twitterTitle: 'tw',
      jsonLdTitle: 'ld',
      jsonLdSeriesTitle: 'series',
      canonicalTitle: 'Canonical',
      tabId: 1,
      windowId: 2,
      timestamp: 3,
    };

    expect(placeholderValuesFrom(record)).toEqual({
      title: 'Canonical',
      rawTitle: 'Raw Title',
      url: 'https://example.com/watch',
      hostname: 'example.com',
    });
  });

  it('uses the canonical title, never the document title', () => {
    const record = {
      url: 'https://www.amazon.com/x',
      hostname: 'www.amazon.com',
      rawTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
      documentTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
      ogTitle: '',
      twitterTitle: '',
      jsonLdTitle: '',
      jsonLdSeriesTitle: '',
      canonicalTitle: 'Gary and His Demons',
      tabId: 0,
      windowId: 0,
      timestamp: 0,
    } as ContextRecord;

    expect(placeholderValuesFrom(record).title).toBe('Gary and His Demons');
  });
});

/**
 * The browser is opened via `start "" "<url>"` on cmd, where a double quote
 * ends the quoted argument and `\"` is not an escape. A raw quote surviving
 * validation would therefore be a command injection, and Context URL is what
 * first lets an arbitrary template reach that path.
 */
describe('shell-safety of the resolved URL', () => {
  it('never returns a URL containing a raw double quote', () => {
    const injections = [
      'https://example.com/?q="&&calc.exe&&"',
      'https://example.com/?q="',
      'https://example.com/"&&whoami&&"',
      'https://example.com/?a="|calc',
    ];
    for (const template of injections) {
      const result = resolveUrlTemplate(template, CONTEXT);
      if (result.ok) {
        expect(result.url).not.toContain('"');
        // The quote survives only as an inert percent-encoding.
        expect(result.url).toContain('%22');
      }
    }
  });

  it('encodes a quote injected through a placeholder value', () => {
    const hostile: PlaceholderValues = { ...CONTEXT, title: '" && calc.exe && "' };
    const url = ok('https://example.com/?q={title}', hostile);
    expect(url).not.toContain('"');
    expect(new URL(url).searchParams.get('q')).toBe('" && calc.exe && "');
  });

  it('leaves the established destinations byte-identical after normalization', () => {
    // Normalization must not change what the proven built-ins produce.
    const cases: Array<[string, string]> = [
      ['https://www.imdb.com/find?q={title}', 'https://www.imdb.com/find?q=Gary%20and%20His%20Demons'],
      ['https://www.google.com/search?q={title}%20cast', 'https://www.google.com/search?q=Gary%20and%20His%20Demons%20cast'],
      ['https://www.justwatch.com/us/search?q={title}', 'https://www.justwatch.com/us/search?q=Gary%20and%20His%20Demons'],
      ['https://www.reddit.com/search/?q={title}', 'https://www.reddit.com/search/?q=Gary%20and%20His%20Demons'],
      ['https://www.youtube.com/results?search_query={title}+trailer', 'https://www.youtube.com/results?search_query=Gary%20and%20His%20Demons+trailer'],
      ['https://www.rottentomatoes.com/search?search={title}', 'https://www.rottentomatoes.com/search?search=Gary%20and%20His%20Demons'],
    ];
    for (const [template, expected] of cases) {
      expect(ok(template)).toBe(expected);
    }
  });
});

describe('adversarial review regressions', () => {
  /**
   * encodeURIComponent throws URIError on an unpaired surrogate, and a page can
   * put one in its <title>. Unguarded, this crashed the whole service through
   * the built-in lookup routes, which require neither an origin nor a secret —
   * an unauthenticated remote kill that took every key on the deck down.
   */
  it('refuses an unencodable context value instead of throwing', () => {
    const loneSurrogate: PlaceholderValues = { ...CONTEXT, title: 'Movie \ud800 Title' };
    expect(() => resolveUrlTemplate('https://www.imdb.com/find?q={title}', loneSurrogate)).not.toThrow();
    expect(err('https://www.imdb.com/find?q={title}', loneSurrogate)).toBe('unencodable_context_value');

    // Also via the other placeholders, and a trailing lone surrogate.
    const badRaw: PlaceholderValues = { ...CONTEXT, rawTitle: 'x\udfff' };
    expect(err('https://e.com/?q={rawTitle}', badRaw)).toBe('unencodable_context_value');
  });

  /**
   * Normalization is not byte-transparent: the WHATWG special-query encode set
   * includes the apostrophe. An earlier comment claimed byte-identity and the
   * test corpus used only a title without one, so the claim went unchecked.
   */
  it('encodes an apostrophe in a title, which normalization is not transparent to', () => {
    const apostrophe: PlaceholderValues = { ...CONTEXT, title: "Bob's Burgers" };
    expect(ok('https://www.imdb.com/find?q={title}', apostrophe)).toBe(
      'https://www.imdb.com/find?q=Bob%27s%20Burgers'
    );
    // Semantically identical — it decodes back to the original title.
    expect(
      new URL(ok('https://e.com/?q={title}', apostrophe)).searchParams.get('q')
    ).toBe("Bob's Burgers");
  });
});
