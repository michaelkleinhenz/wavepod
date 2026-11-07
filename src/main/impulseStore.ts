// The user's impulse responses for the convolution reverb: WAV files in Documents/WavePod/Impulse
// responses, shared by all episodes, templates and presets. Filters refer to them by file name.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImpulseRef } from '../shared/types';
import type { ImpulseFile } from '../shared/api';
import { describeImpulse } from '../core/fx/convolution';
import { decodeAiff, isAiff } from '../core/aiff';
import { writeWavFile } from '../core/wav';

const AUDIO = /\.(wav|wave|aif|aiff)$/i;

/** The IR files in `root` (and its subfolders, as "Folder/File.wav"), sorted by name. */
export function listImpulses(root: string): ImpulseFile[] {
  const out: ImpulseFile[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3) walk(path.join(dir, e.name), relPath, depth + 1);
      else if (e.isFile() && /\.(wav|wave)$/i.test(e.name)) {
        const info = describeImpulse(path.join(dir, e.name));
        if (info) out.push({ file: relPath, name: relPath.replace(/\.[^.]+$/, ''), ...info });
      }
    }
  };
  walk(root, '', 0);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Brings an IR file into `root`: a WAV is copied, an AIFF converted to WAV. A file already inside
 * `root` is used where it is. Returns the reference a filter stores.
 */
export function importImpulse(root: string, src: string): ImpulseRef {
  if (!AUDIO.test(src)) throw new Error('Impulse responses must be WAV or AIFF files.');
  const abs = path.resolve(src);
  const rootAbs = path.resolve(root);
  if (abs.startsWith(rootAbs + path.sep) && /\.(wav|wave)$/i.test(abs)) {
    if (!describeImpulse(abs)) throw new Error(`"${path.basename(src)}" is not a WAV file WavePod can read.`);
    const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
    return { file: rel, name: rel.replace(/\.[^.]+$/, '') };
  }
  fs.mkdirSync(root, { recursive: true });
  const stem = path.basename(src).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_ ()+-]+/gu, '_').trim() || 'Impulse response';
  let name = `${stem}.wav`;
  for (let i = 2; fs.existsSync(path.join(root, name)) && !sameFile(path.join(root, name), abs); i++) name = `${stem} ${i}.wav`;
  const dest = path.join(root, name);
  const data = fs.readFileSync(abs);
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  if (isAiff(buf)) {
    const aiff = decodeAiff(buf);
    writeWavFile(dest, aiff.channels.slice(0, 2) as Float32Array[], aiff.sampleRate, 32);
  } else {
    if (!describeImpulse(abs)) throw new Error(`"${path.basename(src)}" is not a WAV file WavePod can read.`);
    fs.copyFileSync(abs, dest);
  }
  return { file: name, name: stem };
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = fs.readFileSync(a);
    const y = fs.readFileSync(b);
    return x.equals(y);
  } catch {
    return false;
  }
}
