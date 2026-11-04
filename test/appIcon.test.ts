import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// One icon for the app, the installers and the web page: build/icon.svg is the source,
// everything else is rendered from it by scripts/render-icons.mjs.
describe('app icon', () => {
  it('uses the same SVG on the web page as in the app', () => {
    expect(readFileSync('site/img/icon.svg', 'utf8')).toBe(readFileSync('build/icon.svg', 'utf8'));
  });

  it('has every rendered size electron-builder and the launcher need', () => {
    for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      const png = readFileSync(`build/icons/${s}x${s}.png`);
      expect(png.readUInt32BE(16), `${s}px width`).toBe(s);
      expect(png.readUInt32BE(20), `${s}px height`).toBe(s);
    }
    for (const f of ['build/icon.png', 'build/icon.ico', 'site/favicon.ico', 'site/img/icon-32.png', 'site/img/apple-touch-icon.png']) {
      expect(existsSync(f), f).toBe(true);
    }
  });

  it('ships a desktop entry whose icon and window class match the packaged app', () => {
    // Split into lines so a CRLF checkout (Windows without .gitattributes) still passes.
    const entry = readFileSync('build/linux/wavepod.desktop', 'utf8').split(/\r?\n/);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const id = pkg.desktopName.replace(/\.desktop$/, '');
    expect(entry).toContain(`Icon=${id}`);
    expect(entry).toContain(`StartupWMClass=${id}`);
    expect(entry).toContain(`Name=${pkg.productName}`);
  });
});
