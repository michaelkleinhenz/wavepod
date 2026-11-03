// Dev launcher for `make start`, `make demo` and `npm start`.
//
// On Linux, Chromium sandboxes its renderers with unprivileged user namespaces
// or, when those are blocked, with the setuid `chrome-sandbox` helper. npm
// installs that helper owned by the user rather than root, so on distros that
// restrict user namespaces (Ubuntu 23.10+ via AppArmor, hardened kernels)
// Electron aborts with SIGTRAP before a window opens. This script detects that
// case and explains the fixes instead. It never turns the sandbox off by
// itself: WAVEPOD_NO_SANDBOX=1 is an explicit opt-in for local development.
// Packaged builds do not go through this script.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron'); // path to the Electron binary
const args = ['.', ...process.argv.slice(2)];

function readSysctl(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function suidHelperUsable(helper) {
  try {
    const st = statSync(helper);
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

// True if an AppArmor profile in /etc/apparmor.d names this Electron binary
// (such as the one from README.md), which grants it user namespaces.
function apparmorProfileFor(binary) {
  try {
    return readdirSync('/etc/apparmor.d', { withFileTypes: true }).some((e) => {
      if (!e.isFile()) return false;
      try {
        return readFileSync(join('/etc/apparmor.d', e.name), 'utf8').includes(binary);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// Why user namespaces can't back the sandbox, or null if they can.
function userNamespaceProblem() {
  if (readSysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1') {
    if (apparmorProfileFor(electron)) return null;
    return 'AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)';
  }
  if (readSysctl('/proc/sys/kernel/unprivileged_userns_clone') === '0') {
    return 'unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)';
  }
  if (readSysctl('/proc/sys/user/max_user_namespaces') === '0') {
    return 'user namespaces are disabled (user.max_user_namespaces=0)';
  }
  const probe = spawnSync('unshare', ['--user', '--map-root-user', 'true'], { stdio: 'ignore' });
  if (!probe.error && probe.status !== 0) return 'creating a user namespace failed';
  return null;
}

if (process.platform === 'linux' && !args.includes('--no-sandbox')) {
  if (process.env.WAVEPOD_NO_SANDBOX === '1') {
    args.push('--no-sandbox');
    console.warn('[wavepod] WAVEPOD_NO_SANDBOX=1: starting without the Chromium sandbox (dev only).');
  } else {
    const helper = join(dirname(electron), 'chrome-sandbox');
    const problem = suidHelperUsable(helper) ? null : userNamespaceProblem();
    if (problem) {
      const rel = relative(process.cwd(), helper);
      console.error(
        [
          `WavePod can't start Electron's Chromium sandbox: ${problem},`,
          `and ${rel} is not a root-owned setuid helper.`,
          '',
          'Pick one (see "Linux: Chromium sandbox" in README.md):',
          `  - Keep the sandbox (redo after every npm ci):`,
          `      sudo chown root:root ${rel} && sudo chmod 4755 ${rel}`,
          '  - Keep the sandbox for good: install the AppArmor profile from the README.',
          '  - Dev only, no sandbox:  WAVEPOD_NO_SANDBOX=1 make start',
        ].join('\n'),
      );
      process.exit(1);
    }
  }
}

const child = spawn(electron, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  // Report a crash as an exit code rather than re-raising the signal, so the
  // system's crash log points at Electron and not at this launcher.
  if (signal) {
    console.error(`[wavepod] Electron exited with ${signal}`);
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 0);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
