import * as fs from 'fs';
import * as path from 'path';

describe('USEFUL v2 Profile Validation', () => {
  const profileDir = path.resolve(process.cwd(), 'USEFUL v2.sdProfile');
  const manifestPath = path.join(profileDir, 'manifest.json');

  it('profile directory and manifest.json exist', () => {
    expect(fs.existsSync(profileDir)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('validates geometry, action UUIDs, and key placements', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.Name).toBe('USEFUL v2');
    expect(manifest.DeviceModel).toBe('20GBA9901');
    expect(manifest.DeviceUUID).toBe('VSDN4Pro');

    const actions = manifest.Actions;
    expect(actions).toBeDefined();

    // TOP ROW
    expect(actions['0,1']?.UUID).toBe('com.lizard.switchaudio.toggle');
    expect(actions['1,1']?.UUID).toBe('com.hotspot.streamdock.obsstudio.record');
    expect(actions['2,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.imdb');
    expect(actions['3,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.cast');
    expect(actions['4,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.justwatch');

    // BOTTOM ROW
    expect(actions['0,2']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.reddit');

    // Exactly 4 unused LCD keys: 1,2; 2,2; 3,2; 4,2
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

    // Confirm NO Website actions are used
    for (const key of Object.keys(actions)) {
      expect(actions[key].UUID).not.toBe('com.hotspot.streamdock.system.website');
    }
  });

  it('validates ActionID uniqueness and asset existence', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const actions = manifest.Actions;
    const actionIds = new Set<string>();

    const manifestStr = JSON.stringify(manifest);
    expect(manifestStr).not.toContain('secret');
    expect(manifestStr).not.toContain('X-Bridge-Secret');

    for (const key of Object.keys(actions)) {
      const act = actions[key];
      expect(act.ActionID).toBeDefined();
      expect(actionIds.has(act.ActionID)).toBe(false);
      actionIds.add(act.ActionID);

      if (act.States && Array.isArray(act.States)) {
        for (const state of act.States) {
          if (state.Image) {
            const imgPath = path.join(profileDir, state.Image);
            expect(fs.existsSync(imgPath)).toBe(true);
          }
        }
      }
    }
  });
});
