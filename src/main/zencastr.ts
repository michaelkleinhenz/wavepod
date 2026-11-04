// Main-process side of the Zencastr import: reads the session ZIP, picks the tracks and unpacks
// them into a temporary folder for the renderer to decode.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planZencastrImport, sessionTitle } from '../core/zencastr';
import { extractZipEntry, listZip } from '../core/zip';

export interface UnpackedZencastr {
  dir: string;
  title: string;
  tracks: Array<{ name: string; soundboard?: boolean; parts: Array<{ path: string; start: number }> }>;
  skipped: string[];
}

export async function unpackZencastrZip(zipFile: string): Promise<UnpackedZencastr> {
  const entries = listZip(zipFile).filter((e) => !e.isDirectory);
  const plan = planZencastrImport(entries.map((e) => e.name));
  if (!plan.tracks.length) throw new Error('No audio tracks found in this ZIP. Download the session from Zencastr’s Library (Recordings → Download).');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavepod-zencastr-'));
  try {
    let n = 0;
    const tracks: UnpackedZencastr['tracks'] = [];
    for (const t of plan.tracks) {
      const parts = [];
      for (const part of t.parts) {
        // numbered names: entry paths come from the ZIP and must not escape the folder
        const dest = path.join(dir, `${++n}${path.extname(part.entry).toLowerCase()}`);
        await extractZipEntry(zipFile, byName.get(part.entry)!, dest);
        parts.push({ path: dest, start: part.start });
      }
      tracks.push({ name: t.name, soundboard: t.soundboard, parts });
    }
    return { dir, title: sessionTitle(path.basename(zipFile)), tracks, skipped: plan.skipped };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
