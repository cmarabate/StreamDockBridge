import { PLACEHOLDERS } from './urlTemplate';

/**
 * Ready-made Context URL templates.
 *
 * A preset is convenience sugar and nothing more. Choosing one writes a normal
 * `urlTemplate` into the key's settings, and the runtime executes that template
 * exactly as it would a hand-typed one. Nothing at run time reads `presetId` —
 * it is recorded only so the panel can show which entry a template came from,
 * and a key that has been edited since simply stops matching.
 *
 * That constraint is deliberate: the moment the runtime branched on a preset id,
 * presets would be a second configuration authority and we would be back to
 * hard-coding behaviour per site, which is the thing Context URL replaced.
 *
 * Every URL here was requested against the real site before being added.
 */

export type PresetGroup = 'Media' | 'This page';

export interface ContextUrlPreset {
  /** Stable id, recorded for provenance only. Never read at run time. */
  id: string;
  label: string;
  group: PresetGroup;
  urlTemplate: string;
}

export const CONTEXT_URL_PRESETS: ContextUrlPreset[] = [
  // ---- Media: driven by the cleaned work title ------------------------------
  { id: 'imdb', label: 'IMDb', group: 'Media', urlTemplate: 'https://www.imdb.com/find?q={title}' },
  {
    id: 'trailer',
    label: 'Trailer',
    group: 'Media',
    urlTemplate: 'https://www.youtube.com/results?search_query={title}+trailer',
  },
  {
    id: 'rotten-tomatoes',
    label: 'Rotten Tomatoes',
    group: 'Media',
    urlTemplate: 'https://www.rottentomatoes.com/search?search={title}',
  },
  {
    id: 'metacritic',
    label: 'Metacritic',
    group: 'Media',
    urlTemplate: 'https://www.metacritic.com/search/{title}/',
  },
  {
    id: 'letterboxd',
    label: 'Letterboxd',
    group: 'Media',
    urlTemplate: 'https://letterboxd.com/search/{title}/',
  },
  {
    id: 'tmdb',
    label: 'TMDB',
    group: 'Media',
    urlTemplate: 'https://www.themoviedb.org/search?query={title}',
  },
  {
    id: 'reelgood',
    label: 'ReelGood',
    group: 'Media',
    urlTemplate: 'https://reelgood.com/search?q={title}',
  },
  {
    id: 'justwatch',
    label: 'JustWatch',
    group: 'Media',
    urlTemplate: 'https://www.justwatch.com/us/search?q={title}',
  },
  {
    id: 'reddit',
    label: 'Reddit',
    group: 'Media',
    urlTemplate: 'https://www.reddit.com/search/?q={title}',
  },
  {
    id: 'wikipedia',
    label: 'Wikipedia',
    group: 'Media',
    urlTemplate: 'https://en.wikipedia.org/w/index.php?search={title}',
  },
  {
    id: 'cast',
    label: 'Cast',
    group: 'Media',
    // The literal %20 keeps this byte-identical to the original built-in route.
    urlTemplate: 'https://www.google.com/search?q={title}%20cast',
  },
  {
    id: 'soundtrack',
    label: 'Soundtrack',
    group: 'Media',
    urlTemplate: 'https://www.google.com/search?q={title}%20soundtrack',
  },
  {
    id: 'ending-explained',
    label: 'Ending explained',
    group: 'Media',
    urlTemplate: 'https://www.google.com/search?q={title}%20ending%20explained',
  },

  // ---- This page: driven by what the browser is literally showing -----------
  {
    id: 'search-page-title',
    label: 'Google this page title',
    group: 'This page',
    urlTemplate: 'https://www.google.com/search?q={rawTitle}',
  },
  {
    id: 'reddit-page-title',
    label: 'Reddit this page title',
    group: 'This page',
    urlTemplate: 'https://www.reddit.com/search/?q={rawTitle}',
  },
  {
    id: 'youtube-page-title',
    label: 'YouTube this page title',
    group: 'This page',
    urlTemplate: 'https://www.youtube.com/results?search_query={rawTitle}',
  },
];

/** Groups in the order the panel should show them. */
export const PRESET_GROUPS: PresetGroup[] = ['Media', 'This page'];

export function findPreset(id: string): ContextUrlPreset | undefined {
  return CONTEXT_URL_PRESETS.find((preset) => preset.id === id);
}

/** Which preset, if any, a template currently matches. Provenance only. */
export function presetIdForTemplate(urlTemplate: string): string | null {
  const match = CONTEXT_URL_PRESETS.find((preset) => preset.urlTemplate === urlTemplate);
  return match ? match.id : null;
}

/** Every placeholder a preset uses, for assertions. */
export function placeholdersUsedBy(preset: ContextUrlPreset): string[] {
  const used = new Set<string>();
  const pattern = /\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(preset.urlTemplate)) !== null) {
    const name = match[1].trim();
    if ((PLACEHOLDERS as readonly string[]).includes(name)) used.add(name);
  }
  return [...used];
}
