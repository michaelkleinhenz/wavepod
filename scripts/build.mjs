// Bundles main, preload, worker and renderer with esbuild.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.env.NODE_ENV === 'production';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info', target: 'es2022' };

const configs = [
  {
    ...common,
    entryPoints: { main: 'src/main/main.ts', exportWorker: 'src/main/exportWorker.ts', vstBridge: 'src/main/vst/bridgeWorker.ts', recordWorker: 'src/main/recordWorker.ts' },
    outdir: 'dist/main',
    platform: 'node',
    format: 'cjs',
    // opusscript loads its .wasm next to its own files, so it stays in node_modules
    external: ['electron', 'audify', 'opusscript'],
  },
  {
    ...common,
    entryPoints: { preload: 'src/preload/preload.ts' },
    outdir: 'dist/preload',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: { index: 'src/renderer/index.ts' },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
  },
];

function copyStatic() {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
  // Window and taskbar icon on Linux and Windows (macOS takes it from the bundle).
  cpSync('build/icons/512x512.png', 'dist/icon.png');
}

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
  copyStatic();
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  copyStatic();
}
