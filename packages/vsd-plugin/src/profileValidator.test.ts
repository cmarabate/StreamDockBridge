import * as fs from 'fs';
import * as path from 'path';

describe('USEFUL v2 Strict Recursive Profile Validation', () => {
  const profileDir = path.resolve(process.cwd(), 'USEFUL v2.sdProfile');
  const topManifestPath = path.join(profileDir, 'manifest.json');

  function getAllJsonFiles(dir: string): string[] {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(getAllJsonFiles(fullPath));
      } else if (file.endsWith('.json')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  it('profile directory, top-level manifest.json, and canonical import package exist', () => {
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(fs.existsSync(topManifestPath)).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), 'USEFUL v2.StreamDockProfile'))).toBe(true);
  });

  it('proves ZERO com.hotspot.streamdock.system.website or emoji actions exist anywhere in any json file recursively', () => {
    const jsonFiles = getAllJsonFiles(profileDir);
    expect(jsonFiles.length).toBeGreaterThan(0);

    for (const jsonFile of jsonFiles) {
      const content = fs.readFileSync(jsonFile, 'utf8');
      expect(content).not.toContain('com.hotspot.streamdock.system.website');
      expect(content).not.toContain('com.mirabox.streamdock.emoji');
      expect(content).not.toContain('touchbar');
      expect(content).not.toContain('127.0.0.1');
      expect(content).not.toContain('secret');
    }
  });

  it('validates top-level manifest is clean and correctly references child page', () => {
    const topManifest = JSON.parse(fs.readFileSync(topManifestPath, 'utf8'));

    expect(topManifest.Name).toBe('USEFUL v2');
    expect(topManifest.DeviceModel).toBe('20GBA9901');
    expect(topManifest.DeviceUUID).toBe('VSDN4Pro');
    expect(topManifest.Pages).toBeDefined();

    // Top-level Actions MUST BE EMPTY!
    expect(Object.keys(topManifest.Actions || {}).length).toBe(0);

    const currentRel = topManifest.Pages.Current;
    expect(currentRel).toBeDefined();

    const childPageDir = path.join(profileDir, 'profiles', currentRel);
    const childManifestPath = path.join(childPageDir, 'manifest.json');

    expect(fs.existsSync(childPageDir)).toBe(true);
    expect(fs.existsSync(childManifestPath)).toBe(true);
  });

  it('validates child page actions, geometry, unique ActionIDs, and image assets', () => {
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

    const actionIds = new Set<string>();

    for (const key of Object.keys(actions)) {
      const act = actions[key];

      if (act.ActionID) {
        expect(actionIds.has(act.ActionID)).toBe(false);
        actionIds.add(act.ActionID);
      }

      if (act.States && Array.isArray(act.States)) {
        for (const state of act.States) {
          if (state.Image) {
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
