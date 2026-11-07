// Runs the cleanup analysis on the audio (in the export worker): the mix's level for pauses,
// and each hesitation's own track around it to place its cut between words.
import type { CleanupItem, CleanupOptions, Project, TimelineWord } from '../shared/types';
import { Mixer, ReaderCache } from './mixer';
import { projectLength } from './project';
import { LEVEL_HOP_SECONDS, fillerItems, findPauses, levelsDb, pauseItems, refineCut } from './cleanup';
import { findRetakes, retakeSearchRange } from './retakes';

const BLOCK = 8192;

export function scanCleanup(project: Project, dir: string, words: TimelineWord[], opts: CleanupOptions, progress?: (fraction: number) => void): CleanupItem[] {
  const readers = new ReaderCache(dir);
  const mixer = new Mixer(project, readers);
  const sr = project.sampleRate;
  try {
    const items: CleanupItem[] = [];
    // hesitations and retakes are both placed on the quiet points of their own track
    const fillers = [...(opts.fillers ? fillerItems(words) : []), ...(opts.retakes ? findRetakes(words, sr) : [])];
    const total = (opts.pauses ? projectLength(project) : 0) + fillers.length * sr;
    let done = 0;
    if (opts.pauses) {
      const length = projectLength(project);
      const hop = Math.max(1, Math.round(LEVEL_HOP_SECONDS * sr));
      // level per hop, summed as the mix streams by (an hour of audio would not fit in memory)
      const sums = new Float64Array(Math.ceil(length / hop));
      const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let pos = 0; pos < length; pos += BLOCK) {
        const n = Math.min(BLOCK, length - pos);
        mixer.render(pos, n, out);
        for (let i = 0; i < n; i++) {
          const v = (out[0][i] + out[1][i]) / 2;
          sums[Math.floor((pos + i) / hop)] += v * v;
        }
        done += n;
        if (progress && (pos / BLOCK) % 64 === 0) progress(done / Math.max(1, total));
      }
      const levels = new Float32Array(sums.length);
      for (let i = 0; i < sums.length; i++) levels[i] = 10 * Math.log10(sums[i] / Math.min(hop, length - i * hop) + 1e-12);
      const pauses = findPauses(levels, hop, sr, opts.maxPause, opts.keepPause);
      items.push(...pauseItems(pauses, words));
    }
    if (fillers.length) {
      const pad = Math.round(0.2 * sr);
      const hop = Math.max(1, Math.round(0.005 * sr));
      for (const item of fillers) {
        const track = project.tracks.find((t) => t.id === item.trackId);
        if (!track) continue;
        const [a, b] = item.kind === 'retake' ? retakeSearchRange(item, sr) : [item.start, item.end];
        const from = Math.max(0, a - pad);
        const n = b + pad - from;
        const buf = [new Float32Array(n), new Float32Array(n)];
        mixer.renderStems([track], from, n, buf);
        const mono = buf[0].map((v, i) => (v + buf[1][i]) / 2);
        const [start, end] = refineCut(levelsDb(mono, hop), hop, from, a, b, sr);
        items.push({ ...item, start, end });
        done += sr;
        progress?.(done / Math.max(1, total));
      }
    }
    return items.sort((a, b) => a.start - b.start);
  } finally {
    mixer.dispose();
    readers.closeAll();
  }
}
