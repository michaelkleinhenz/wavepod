import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Microsoft Store package (MSIX): electron-builder's appx target, the tiles in build/appx/
// and the release workflow that submits it. Microsoft signs it, so Smart App Control lets it run.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const appx = pkg.build.appx;
const release = readFileSync('.github/workflows/release.yml', 'utf8');

function size(file: string): [number, number] {
  const png = readFileSync(`build/appx/${file}`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe('Microsoft Store package', () => {
  it('builds an MSIX that may use the microphone and cameras', () => {
    expect(appx.artifactName).toMatch(/\.msix$/);
    expect(appx.capabilities).toEqual(expect.arrayContaining(['runFullTrust', 'microphone', 'webcam']));
    expect(pkg.scripts['dist:store']).toContain('--win appx');
  });

  it('leaves the Store identity to Partner Center, not package.json', () => {
    // identityName/publisher come from repository variables (make dist-store), so a fork can't
    // accidentally build packages that claim to be the published app.
    expect(appx.identityName).toBeUndefined();
    expect(appx.publisher).toBeUndefined();
    // \r?\n: Windows checkouts have CRLF line endings.
    const make = readFileSync('Makefile', 'utf8');
    expect(make).toContain('-c.appx.identityName=$(MSSTORE_IDENTITY_NAME)');
    expect(make).toMatch(/^dist-store:.*\r?\n\tnpx electron-builder --win appx .*\$\(STORE_IDENTITY\)/m);
  });

  it('ships every tile at its size, so the Store never shows electron-builder\'s sample logos', () => {
    const want: Record<string, [number, number]> = {
      'StoreLogo.png': [50, 50],
      'StoreLogo.scale-200.png': [100, 100],
      'Square44x44Logo.png': [44, 44],
      'Square44x44Logo.scale-200.png': [88, 88],
      'Square150x150Logo.png': [150, 150],
      'Square150x150Logo.scale-200.png': [300, 300],
      'Wide310x150Logo.png': [310, 150],
      'Wide310x150Logo.scale-200.png': [620, 300],
    };
    for (const s of [16, 24, 32, 48, 256]) {
      want[`Square44x44Logo.targetsize-${s}.png`] = [s, s];
      want[`Square44x44Logo.targetsize-${s}_altform-unplated.png`] = [s, s];
    }
    for (const [file, wh] of Object.entries(want)) expect(size(file), file).toEqual(wh);
    expect(readdirSync('build/appx').sort()).toEqual(Object.keys(want).sort());
  });

  it('is packaged and submitted by the release workflow, but not attached to the GitHub release', () => {
    expect(release).toContain('make dist-store');
    expect(release).toContain('microsoft/microsoft-store-apppublisher@');
    expect(release).toMatch(/msstore publish .*--appId "\$PRODUCT_ID"/);
    expect(release).toContain('pattern: dist-*');
    // pre-releases (v1.2.0-beta.1) never reach the Store
    expect(release.match(/!contains\(github\.ref_name, '-'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('is documented for maintainers', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('### Microsoft Store');
    for (const name of ['MSSTORE_IDENTITY_NAME', 'MSSTORE_PUBLISHER', 'MSSTORE_PUBLISHER_NAME', 'MSSTORE_PRODUCT_ID',
      'MSSTORE_TENANT_ID', 'MSSTORE_SELLER_ID', 'MSSTORE_CLIENT_ID', 'MSSTORE_CLIENT_SECRET']) {
      expect(readme, name).toContain(name);
      expect(release, name).toContain(name);
    }
  });
});
