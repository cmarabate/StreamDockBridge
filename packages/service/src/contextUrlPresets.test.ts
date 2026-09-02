import * as fs from 'fs';
import * as path from 'path';
import {
  CONTEXT_URL_PRESETS,
  PRESET_GROUPS,
  findPreset,
  presetIdForTemplate,
  placeholdersUsedBy,
  ContextUrlPreset,
} from './contextUrlPresets';
import { resolveUrlTemplate, PlaceholderValues, PLACEHOLDERS } from './urlTemplate';
import { deriveSiteOrigin } from './siteIcon';

const CONTEXT: PlaceholderValues = {
  title: 'Gary and His Demons',
  rawTitle: 'Watch Gary and His Demons Season 2 | Prime Video',
  url: 'https://www.amazon.com/gp/video/detail/X',
  hostname: 'www.amazon.com',
  projectName: 'ADHDeploy',
  githubOwner: 'cmarabate',
  githubRepo: 'adhdeploy',
  vercelTeam: 'team_123',
  vercelProject: 'adhdeploy',
  supabaseProjectRef: 'workspace',
  projectDomain: 'adhdeploy.vercel.app',
};

const PI_PATH = path.resolve(
  __dirname,
  '../../vsd-plugin/propertyInspector/contextUrl.html'
);

describe('the preset catalog', () => {
  it('has a unique id and a label for every entry', () => {
    const ids = CONTEXT_URL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of CONTEXT_URL_PRESETS) {
      expect(preset.label.trim()).not.toBe('');
      expect(PRESET_GROUPS).toContain(preset.group);
    }
  });

  /**
   * A preset is only sugar. If any of these failed to resolve, the panel would
   * be offering a key that cannot work.
   */
  it.each(CONTEXT_URL_PRESETS.map((p): [string, ContextUrlPreset] => [p.label, p]))(
    'resolves %s to a valid URL',
    (_label, preset) => {
      const result = resolveUrlTemplate(preset.urlTemplate, CONTEXT);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        const parsed = new URL(result.url);
        expect(['http:', 'https:']).toContain(parsed.protocol);
        expect(parsed.hostname).not.toBe('');
      }
    }
  );

  /** Auto Website Icon has to be able to name the site a preset points at. */
  it.each(
    CONTEXT_URL_PRESETS.filter((p) => !p.urlTemplate.includes('{projectDomain}')).map(
      (p): [string, ContextUrlPreset] => [p.label, p]
    )
  )('derives a static icon origin for %s', (_label, preset) => {
    const derived = deriveSiteOrigin(preset.urlTemplate);
    expect(derived.ok).toBe(true);
    if (derived.ok) expect(derived.site.hostname).toMatch(/\./);
  });

  it('recognizes dynamic host presets as dynamic', () => {
    const prodPreset = CONTEXT_URL_PRESETS.find((p) => p.id === 'project-production');
    expect(prodPreset).toBeDefined();
    const derived = deriveSiteOrigin(prodPreset!.urlTemplate);
    expect(derived).toEqual({ ok: false, reason: 'dynamic_host' });
  });

  it('uses only approved placeholders', () => {
    for (const preset of CONTEXT_URL_PRESETS) {
      const used = placeholdersUsedBy(preset);
      expect(used.length).toBeGreaterThan(0);
      for (const name of used) {
        expect(PLACEHOLDERS).toContain(name);
      }
    }
  });

  /** The migrated built-ins must still be offered, and unchanged. */
  it('keeps the original built-in destinations byte-identical', () => {
    expect(findPreset('imdb')!.urlTemplate).toBe('https://www.imdb.com/find?q={title}');
    expect(findPreset('cast')!.urlTemplate).toBe(
      'https://www.google.com/search?q={title}%20cast'
    );
    expect(findPreset('justwatch')!.urlTemplate).toBe(
      'https://www.justwatch.com/us/search?q={title}'
    );
    expect(findPreset('reddit')!.urlTemplate).toBe('https://www.reddit.com/search/?q={title}');
  });

  it('maps a template back to its preset, and an edited one to nothing', () => {
    expect(presetIdForTemplate('https://www.imdb.com/find?q={title}')).toBe('imdb');
    // One character different is a custom template, not IMDb.
    expect(presetIdForTemplate('https://www.imdb.com/find?q={title}&x=1')).toBeNull();
    expect(presetIdForTemplate('')).toBeNull();
  });

  it('finds nothing for an unknown id', () => {
    expect(findPreset('does-not-exist')).toBeUndefined();
  });
});

/**
 * The Property Inspector is a standalone file:// page and cannot import this
 * module, so it carries its own copy of the catalog. This is the guard that
 * stops the two drifting apart.
 */
describe('the Property Inspector copy of the catalog', () => {
  const html = fs.readFileSync(PI_PATH, 'utf8');

  function parsePanelPresets(): Array<{ id: string; label: string; group: string; urlTemplate: string }> {
    const start = html.indexOf('var PRESETS = [');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf('];', start);
    const body = html.slice(start + 'var PRESETS = ['.length, end);

    const entries: Array<{ id: string; label: string; group: string; urlTemplate: string }> = [];
    const pattern = /\{\s*id:\s*"([^"]*)",\s*label:\s*"([^"]*)",\s*group:\s*"([^"]*)",\s*urlTemplate:\s*"([^"]*)"\s*\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      entries.push({ id: match[1], label: match[2], group: match[3], urlTemplate: match[4] });
    }
    return entries;
  }

  it('matches the service catalog exactly, in the same order', () => {
    const panel = parsePanelPresets();
    expect(panel).toEqual(
      CONTEXT_URL_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        group: p.group,
        urlTemplate: p.urlTemplate,
      }))
    );
  });

  it('offers a Custom option and every group', () => {
    expect(html).toContain('<option value="">Custom</option>');
    for (const group of PRESET_GROUPS) {
      expect(html).toContain(group);
    }
  });

  /**
   * The runtime contract is the template. If the panel ever started sending a
   * preset id INSTEAD of a template, a key would stop working the moment the
   * catalog changed.
   */
  it('always writes a urlTemplate, and treats presetId as provenance only', () => {
    expect(html).toContain('settings.urlTemplate = input.value;');
    // presetId is derived from the template, never the reverse.
    expect(html).toContain('var matched = presetIdForTemplate(input.value);');
    expect(html).toContain('else delete settings.presetId;');
  });
});
