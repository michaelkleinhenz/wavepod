// Finds installed VST3 effects. Each module is probed by the host helper in its own short-lived
// process, so a plug-in that crashes while loading only drops out of the list.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VstPluginInfo } from '../../shared/types';

export function defaultVstDirs(): string[] {
  const extra = (process.env.SOUNDPOD_VST3_PATH ?? '').split(path.delimiter).filter(Boolean);
  return [...extra, ...platformVstDirs()];
}

/** The standard VST3 folders of the platform (Steinberg's spec). */
function platformVstDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [path.join(home, 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST3'];
    case 'win32': {
      const common = process.env.CommonProgramFiles ?? 'C:\\Program Files\\Common Files';
      const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Common', 'VST3') : null;
      return [path.join(common, 'VST3'), ...(local ? [local] : [])];
    }
    default:
      return [path.join(home, '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3'];
  }
}

/** All `.vst3` modules (bundles or files) below the given folders. */
export function findVstModules(dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name.toLowerCase().endsWith('.vst3')) found.push(p);
      else if ((e.isDirectory() || e.isSymbolicLink()) && depth < 4) walk(p, depth + 1);
    }
  };
  for (const d of dirs) walk(d, 0);
  return [...new Set(found)].sort();
}

interface CacheEntry {
  mtime: number;
  plugins: VstPluginInfo[];
}

function probe(exe: string, modulePath: string): Promise<VstPluginInfo[]> {
  return new Promise((resolve) => {
    execFile(exe, ['--scan-module', modulePath], { timeout: 20000, windowsHide: true, maxBuffer: 1 << 20 }, (_err, stdout) => {
      try {
        const line = stdout.trim().split(/\r?\n/).pop() ?? '[]';
        resolve(JSON.parse(line) as VstPluginInfo[]);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Scans the folders, reusing cached results for modules that haven't changed. */
export async function scanVstPlugins(exe: string, dirs: string[], cacheFile: string, force = false): Promise<VstPluginInfo[]> {
  let cache: Record<string, CacheEntry> = {};
  if (!force) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      cache = {};
    }
  }
  const next: Record<string, CacheEntry> = {};
  for (const mod of findVstModules(dirs)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(mod).mtimeMs;
    } catch {
      continue;
    }
    const hit = cache[mod];
    next[mod] = hit && hit.mtime === mtime ? hit : { mtime, plugins: await probe(exe, mod) };
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(next));
  } catch {
    /* cache is optional */
  }
  return Object.values(next)
    .flatMap((e) => e.plugins)
    .sort((a, b) => a.name.localeCompare(b.name));
}
