// Renders clips that can't be fused losslessly into a new file (see core/fuse.ts). Node only.
import * as fs from 'node:fs';
import type { Project, Track } from '../shared/types';
import { checkFuse, clipsToRender, outerClips } from './fuse';
import { Mixer, ReaderCache } from './mixer';
import { WavWriter } from './wav';

const BLOCK = 1 << 16;

/**
 * Renders the clips into a new WAV at `dest` (32-bit float, so a clip gain above 0 dB can't clip):
 * the audio as it plays on the track, with crossfades, volume lines and sound design, but without
 * the track's own filters, gain, pan, automation and mute regions, which keep working on the fused
 * clip. Mono unless one of the clips is stereo. Returns its length in frames.
 */
export function renderFused(project: Project, dir: string, ids: string[], dest: string, onProgress?: (fraction: number) => void): { frames: number; channels: number } {
  const check = checkFuse(project, ids);
  if (!check.ok) throw new Error(check.reason);
  const { track, clips, start, end } = check;
  const solo: Track = {
    ...track,
    clips: clipsToRender(clips, start, end),
    gain: 0,
    pan: 0,
    fx: [],
    mute: false,
    solo: false,
  };
  for (const k of ['automation', 'muteRegions', 'duck', 'automix', 'folderId', 'takes'] as const) delete solo[k];
  const p: Project = { ...project, tracks: [solo], masterFx: [], masterGain: 0, folders: [] };
  const readers = new ReaderCache(dir);
  const missing = clips.find((c) => !readers.get(c.file));
  if (missing) {
    readers.closeAll();
    throw new Error(`Can't read ${missing.file.split('/').pop()}`);
  }
  const channels = clips.some((c) => (readers.get(c.file)?.info.channels ?? 1) >= 2) ? 2 : 1;
  const mixer = new Mixer(p, readers);
  // an outer fade moves to the fused clip: no declick where it was, as before
  const { first, last } = outerClips(clips, start, end);
  if (first.fadeIn > 0) mixer.noDeclickIn = new Set([first.id]);
  if (last.fadeOut > 0) mixer.noDeclickOut = new Set([last.id]);
  const tmp = `${dest}.part`;
  const writer = new WavWriter(tmp, channels, project.sampleRate, 32, 1 << 20, 0, { rf64: true });
  const total = end - start;
  const buf = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  try {
    for (let done = 0; done < total; done += BLOCK) {
      const n = Math.min(BLOCK, total - done);
      buf[0].fill(0);
      buf[1].fill(0);
      mixer.renderTrackInto(solo, start + done, n, buf);
      writer.write(channels === 2 ? buf : [buf[0]], n);
      onProgress?.((done + n) / total);
    }
    writer.close();
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      writer.close();
    } catch {
      // already closed
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    mixer.dispose();
    readers.closeAll();
  }
  return { frames: total, channels };
}
