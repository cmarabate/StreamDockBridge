import * as fs from 'fs';
import * as path from 'path';

const repoRoot = process.cwd();

/**
 * esbuild and `tsc -b` both emit into the same dist/ directory, so whichever
 * runs last wins. The manifests load the *bundled* outputs
 * (`CodePathWin: dist/main.js`, `service_worker: dist/background.js`), so
 * esbuild has to run last. With the order reversed, a warm build looks fine —
 * `tsc -b` skips emit when tsbuildinfo is current — and only a cold build
 * (fresh clone, CI, wiped dist) replaces the bundle with tsc's unbundled file,
 * which then `require()`s dependencies that do not exist where the artifact is
 * installed. That failure is invisible to every other test, hence this guard.
 */
const bundledPackages = ['extension', 'vsd-plugin'];

describe('bundled package build order', () => {
  for (const pkg of bundledPackages) {
    it(`${pkg} runs tsc before esbuild so the bundle survives a cold build`, () => {
      const manifestPath = path.resolve(repoRoot, 'packages', pkg, 'package.json');
      const buildScript: string = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts.build;

      const tscIndex = buildScript.indexOf('tsc -b');
      const esbuildIndex = buildScript.indexOf('esbuild');

      expect(tscIndex).toBeGreaterThanOrEqual(0);
      expect(esbuildIndex).toBeGreaterThanOrEqual(0);
      expect(tscIndex).toBeLessThan(esbuildIndex);
    });
  }
});
