// Builds audify (RtAudio bindings) from source after patch-package has fixed it.
//
// audify 1.10.1 allocates its audio buffers with `new int8_t[]` but holds them
// in `std::shared_ptr<int8_t>`, which frees them with scalar `delete`. Electron
// 43+ uses an allocator that checks this and traps (SIGTRAP, no message) on the
// first audio callback. patches/audify+*.patch fixes that, plus:
//  - PulseAudio streams with more than 6 channels (e.g. a 16-channel
//    RØDECaster) failed to open because RtAudio passed no channel map;
//  - one global error callback shared by all streams was released while other
//    streams' audio threads still used it (SIGSEGV when reopening devices);
//  - a JS exception in a stream callback ended in std::terminate (SIGABRT);
//  - PulseAudio playback used a ~2 s buffer refilled in bursts, so audify's
//    write queue underran and playback ran slow and crackled.
//  - an ALSA read error (e.g. EIO from PipeWire's plug-in) made the capture
//    thread spin and report the same error thousands of times a second;
//  - every RtAudio instance that never opened a stream warned "no open stream
//    to close!" when it was garbage collected;
//  - probing ALSA printed "Invalid CTL pulse" on systems without that plug-in.
// The prebuilt binary that audify downloads has none of these fixes, so we
// compile it here.
//
// Skips the build when the module was already built from the current patch.
// The stamp also records the hash of the binary we built: audify's own install
// script (prebuild-install, e.g. on `npm install` or `npm rebuild`) replaces
// build/Release/audify.node with the unpatched prebuilt and leaves the stamp
// alone, and a packaged app with that binary traps at start. Any binary we
// did not build is rebuilt. `npm run build` (and so `make build`, `make start`, `make dist-*`) runs this too.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const audifyDir = dirname(require.resolve('audify/package.json'));
const binary = join(audifyDir, 'build', 'Release', 'audify.node');
const stampFile = join(audifyDir, 'build', 'wavepod-patch.stamp');

const patchDir = join(root, 'patches');
const patches = readdirSync(patchDir).filter((f) => f.startsWith('audify+')).sort();
if (patches.length === 0) {
  console.error('[build-audify] no audify patch found in patches/');
  process.exit(1);
}
const hash = createHash('sha256');
for (const p of patches) hash.update(readFileSync(join(patchDir, p)));
const patchStamp = `${hash.digest('hex')} ${process.platform}-${process.arch}`;
const binaryHash = () => createHash('sha256').update(readFileSync(binary)).digest('hex');
const stampFor = () => `${patchStamp} ${binaryHash()}`;

if (existsSync(binary) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stampFor()) {
  console.log('[build-audify] audify is already built from the current patch');
  process.exit(0);
}
if (existsSync(binary) && existsSync(stampFile) && readFileSync(stampFile, 'utf8').startsWith(patchStamp)) {
  console.log('[build-audify] audify.node was replaced (e.g. by the unpatched prebuilt); rebuilding');
}

// RtAudio's CMake silently drops ALSA/PulseAudio when their headers are
// missing, which would leave WavePod with no Linux audio at all.
if (process.platform === 'linux') {
  const missing = ['alsa', 'libpulse-simple'].filter(
    (pkg) => spawnSync('pkg-config', ['--exists', pkg]).status !== 0,
  );
  if (missing.length) {
    console.error(
      `[build-audify] missing development headers: ${missing.join(', ')}\n` +
        '[build-audify] Debian/Ubuntu: sudo apt install libasound2-dev libpulse-dev pkg-config\n' +
        '[build-audify] Fedora: sudo dnf install alsa-lib-devel pulseaudio-libs-devel pkgconf',
    );
    process.exit(1);
  }
}

console.log('[build-audify] compiling patched audify (CMake + C++ compiler)...');
const cmakeJs = join(dirname(require.resolve('cmake-js/package.json', { paths: [audifyDir] })), 'bin', 'cmake-js');
const result = spawnSync(process.execPath, [cmakeJs, 'rebuild'], { cwd: audifyDir, stdio: 'inherit' });
if (result.status !== 0 || !existsSync(binary)) {
  console.error('[build-audify] building audify failed; see the output above');
  process.exit(1);
}
writeFileSync(stampFile, stampFor());
console.log('[build-audify] done');
