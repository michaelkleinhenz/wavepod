import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function tmpDir(prefix = 'wavepod-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sine(freq: number, seconds: number, sampleRate: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}
