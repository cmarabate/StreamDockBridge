import * as fs from 'fs';
import * as path from 'path';

describe('USEFUL v2 Recursive Profile Validation', () => {
  const profileDir = path.resolve(process.cwd(), 'USEFUL v2.sdProfile');
  const topManifestPath = path.join(profileDir, 'manifest.json');

  it('profile directory and top-level manifest.json exist', () => {
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(fs.existsSync(topManifestPath)).toBe(true);
  });

  it('recursively resolves Pages.Current and Pages.Pages child page manifests', () => {
    const topManifest = JSON.parse(fs.readFileSync(topManifestPath, 'utf8'));

    expect(topManifest.Name).toBe('USEFUL v2');
    expect(topManifest.DeviceModel).toBe('20GBA9901');
    expect(topManifest.DeviceUUID).toBe('VSDN4Pro');
    expect(topManifest.Pages).toBeDefined();

    const currentRel = topManifest.Pages.Current;
    expect(currentRel).toBeDefined();

    const childPageDir = path.join(profileDir, 'profiles', currentRel);
    const childManifestPath = path.join(childPageDir, 'manifest.json');

    expect(fs.existsSync(childPageDir)).toBe(true);
    expect(fs.existsSync(childManifestPath)).toBe(true);

    for (const pageRel of topManifest.Pages.Pages) {
      const pagePath = path.join(profileDir, 'profiles', pageRel, 'manifest.json');
      expect(fs.existsSync(pagePath)).toBe(true);
    }
  });

  it('validates child page actions, geometry, and key placements', () => {
    const topManifest = JSON.parse(fs.readFileSync(topManifestPath, 'utf8'));
    const childPageDir = path.join(profileDir, 'profiles', topManifest.Pages.Current);
    const childManifest = JSON.parse(fs.readFileSync(path.join(childPageDir, 'manifest.json'), 'utf8'));

    const actions = childManifest.Actions;
    expect(actions).toBeDefined();

    // TOP ROW
    expect(actions['0,1']?.UUID).toBe('com.lizard.switchaudio.toggle');
    expect(actions['1,1']?.UUID).toBe('com.hotspot.streamdock.obsstudio.record');
    expect(actions['2,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.imdb');
    expect(actions['3,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.cast');
    expect(actions['4,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.justwatch');

    // BOTTOM ROW
    expect(actions['0,2']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.reddit');

    // Exactly 4 unused LCD keys
    expect(actions['1,2']).toBeUndefined();
    expect(actions['2,2']).toBeUndefined();
    expect(actions['3,2']).toBeUndefined();
    expect(actions['4,2']).toBeUndefined();

    // Knobs and TouchBar blank
    expect(actions['0,0']).toBeUndefined();
    expect(actions['1,0']).toBeUndefined();
    expect(actions['2,0']).toBeUndefined();
    expect(actions['3,0']).toBeUndefined();
    expect(actions['touchbar']).toBeUndefined();
  });

  it('recursively validates ActionID uniqueness, asset existence, and absence of secrets/website fallbacks', () => {
    const topManifest = JSON.parse(fs.readFileSync(topManifestPath, 'utf8'));
    const childPageDir = path.join(profileDir, 'profiles', topManifest.Pages.Current);
    const childManifest = JSON.parse(fs.readFileSync(path.join(childPageDir, 'manifest.json'), 'utf8'));

    const actionIds = new Set<string>();

    const topStr = JSON.stringify(topManifest);
    const childStr = JSON.stringify(childManifest);
    expect(topStr).not.toContain('secret');
    expect(childStr).not.toContain('secret');

    const actions = childManifest.Actions;
    for (const key of Object.keys(actions)) {
      const act = actions[key];
      expect(act.UUID).not.toBe('com.hotspot.streamdock.system.website');

      if (act.ActionID) {
        expect(actionIds.has(act.ActionID)).toBe(false);
        actionIds.add(act.ActionID);
      }

      if (act.States && Array.isArray(act.States)) {
        for (const state of act.States) {
          if (state.Image) {
            // Check image exists in child page directory or top-level profile directory
            const imgPathChild = path.join(childPageDir, state.Image);
            const imgPathTop = path.join(profileDir, state.Image);
            const exists = fs.existsSync(imgPathChild) || fs.existsSync(imgPathTop);
            expect(exists).toBe(true);
          }
        }
      }
    }
  });
});
