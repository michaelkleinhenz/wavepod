import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// patch-package applies the audify patch on every platform before the source
// build. A patch that touches build output (e.g. deleting Linux .so files from
// a local build) fails on macOS and Windows, where those files never exist.
describe('audify patch', () => {
  const dir = join(__dirname, '..', 'patches');
  const patches = readdirSync(dir).filter((f) => f.startsWith('audify+'));

  it('exists', () => {
    expect(patches.length).toBeGreaterThan(0);
  });

  it.each(patches)('%s only touches source files', (name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    const files = [...text.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).not.toMatch(/\/build\//);
      expect(f).not.toMatch(/\.(node|so(\.\d+)*|dylib|dll)$/);
    }
    expect(text).not.toMatch(/^Binary files /m);
  });

  // pkg-config's jack_LIBRARIES is just "jack" without its -L folder; on Fedora
  // PipeWire's libjack.so is outside the default path and the link failed.
  it.each(patches)('%s links JACK by full path', (name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    expect(text).toMatch(/^\+\s*list\(APPEND LINKLIBS \$\{jack_LINK_LIBRARIES\}\)/m);
  });
});

// audify's install script (prebuild-install) can swap the patched binary back
// for the upstream prebuilt, which traps under Electron 43+. The build, and so
// every dist target, re-checks the binary first.
describe('audify build step', () => {
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('runs before bundling', () => {
    expect(pkg.scripts.build).toMatch(/^node scripts\/build-audify\.mjs && /);
    for (const name of ['dist', 'dist:linux', 'dist:win', 'dist:mac']) {
      expect(pkg.scripts[name]).toMatch(/^npm run build && /);
    }
  });

  it('only trusts a binary whose hash it recorded', () => {
    const script = readFileSync(join(root, 'scripts', 'build-audify.mjs'), 'utf8');
    expect(script).toMatch(/binaryHash\(\)/);
    expect(script).toMatch(/writeFileSync\(stampFile, stampFor\(\)\)/);
  });
});
