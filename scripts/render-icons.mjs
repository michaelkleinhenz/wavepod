// Renders build/icon.svg into every PNG/ICO the app, the installers and the web page use.
// Needs Playwright's Chromium (`npm i -D playwright` or a global install) and, for the
// .ico files, ImageMagick's `magick` or `convert`. Run after editing build/icon.svg:
//   node scripts/render-icons.mjs
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const svg = readFileSync('build/icon.svg');

let chromium;
try {
  // require() also finds a global install through NODE_PATH.
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('render-icons: Playwright is not installed. Run `npm i --no-save playwright` first.');
  process.exit(1);
}

// `width` x `height` canvas with the icon centred at `size` pixels (wide tiles get a smaller icon).
async function render(page, size, file, width = size, height = size) {
  await page.setViewportSize({ width, height });
  const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  await page.setContent(`<body style="margin:0;width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.screenshot({ path: file, omitBackground: true });
}

// Microsoft Store (MSIX) tiles and logos, read by electron-builder's appx target from build/appx/.
// Base names are the 100% scale; .scale-200 for high-DPI screens; the .targetsize-* (and unplated)
// Square44x44Logo variants are what the taskbar, Start list and Alt+Tab show.
// [file, icon size, canvas width, canvas height]
const APPX = [
  ['StoreLogo.png', 50],
  ['StoreLogo.scale-200.png', 100],
  ['Square44x44Logo.png', 44],
  ['Square44x44Logo.scale-200.png', 88],
  ['Square150x150Logo.png', 120, 150, 150],
  ['Square150x150Logo.scale-200.png', 240, 300, 300],
  ['Wide310x150Logo.png', 120, 310, 150],
  ['Wide310x150Logo.scale-200.png', 240, 620, 300],
  ...[16, 24, 32, 48, 256].flatMap((s) => [
    [`Square44x44Logo.targetsize-${s}.png`, s],
    [`Square44x44Logo.targetsize-${s}_altform-unplated.png`, s],
  ]),
];

function ico(out, pngs) {
  for (const tool of [['magick'], ['convert']]) {
    try {
      execFileSync(tool[0], [...pngs, out]);
      return;
    } catch { /* try the next one */ }
  }
  console.warn(`render-icons: ImageMagick not found, skipped ${out}`);
}

mkdirSync('build/icons', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of SIZES) await render(page, size, `build/icons/${size}x${size}.png`);
await render(page, 180, 'site/img/apple-touch-icon.png');
mkdirSync('build/appx', { recursive: true });
for (const [file, size, w, h] of APPX) await render(page, size, `build/appx/${file}`, w, h);
await browser.close();

copyFileSync('build/icons/1024x1024.png', 'build/icon.png');
copyFileSync('build/icon.svg', 'site/img/icon.svg');
copyFileSync('build/icons/32x32.png', 'site/img/icon-32.png');
ico('build/icon.ico', [16, 24, 32, 48, 64, 128, 256].map((s) => `build/icons/${s}x${s}.png`));
ico('site/favicon.ico', [16, 32, 48].map((s) => `build/icons/${s}x${s}.png`));
console.log('render-icons: done');
