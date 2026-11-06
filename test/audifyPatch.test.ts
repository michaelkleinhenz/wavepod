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
});
