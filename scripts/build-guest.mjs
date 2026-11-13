// Builds the remote guest page into site/join/v1/ (guest.js and the AudioWorklet module). The
// Pages workflow runs this before publishing site/; the files are not committed.
import * as esbuild from 'esbuild';

const prod = process.env.NODE_ENV !== 'development';
const common = { bundle: true, minify: prod, sourcemap: !prod, logLevel: 'info', target: 'es2022', platform: 'browser', format: 'esm' };

await Promise.all([
  esbuild.build({ ...common, entryPoints: { guest: 'src/guest/guest.ts', 'remote-worklet': 'src/shared/remoteWorklet.ts' }, outdir: 'site/join/v1' }),
]);
