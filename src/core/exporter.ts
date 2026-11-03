// Offline mixdown: loudness measurement, normalisation, WAV/MP3 with ID3 chapters, stems, chapter files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mp3Encoder } from '@breezystack/lamejs';
import type { ExportOptions, ExportProgress, ExportResult, Project, Track } from '../shared/types';
import { dbToGain } from '../shared/time';
import { CHAPTER_FORMATS, exportChapters } from './chapters';
import { buildId3Tag } from './id3';
import { LoudnessMeter, normalizationGain } from './loudness';
import { Mixer, ReaderCache, projectLength } from './mixer';
import { markersToChapters } from './project';
import { WavWriter } from './wav';

const BLOCK = 4096;

export type ProgressFn = (p: ExportProgress) => void;

function renderRange(
  mixer: Mixer,
  start: number,
  end: number,
  tracks: Track[] | null,
  onBlock: (block: Float32Array[], frames: number) => void,
  onProgress?: (fraction: number) => void,
): void {
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const total = Math.max(1, end - start);
  let lastReport = 0;
  for (let pos = start; pos < end; pos += BLOCK) {
    const n = Math.min(BLOCK, end - pos);
    if (tracks) {
      out[0].fill(0);
      out[1].fill(0);
      for (const t of tracks) mixer.renderTrackInto(t, pos, n, out);
    } else {
      mixer.render(pos, n, out);
    }
    onBlock(out, n);
    const f = (pos - start + n) / total;
    if (onProgress && f - lastReport > 0.01) {
      lastReport = f;
      onProgress(f);
    }
  }
}

export function measureLoudness(project: Project, projectDir: string, tracks?: Track[]): { integrated: number; peakDb: number } {
  const readers = new ReaderCache(projectDir);
  try {
    const mixer = new Mixer(project, readers);
    const meter = new LoudnessMeter(project.sampleRate, 2);
    renderRange(mixer, 0, projectLength(project), tracks ?? null, (b, n) => meter.push(b, n));
    return { integrated: meter.integrated(), peakDb: meter.peakDb() };
  } finally {
    readers.closeAll();
  }
}

function toInt16(src: Float32Array, n: number, gain: number, dst: Int16Array): Int16Array {
  for (let i = 0; i < n; i++) {
    let s = src[i] * gain;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    dst[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return dst;
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';
}

export function exportProject(project: Project, projectDir: string, opts: ExportOptions, progress: ProgressFn = () => {}): ExportResult {
  const readers = new ReaderCache(projectDir);
  const files: string[] = [];
  try {
    const mixer = new Mixer(project, readers);
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.max(start, opts.end ?? projectLength(project));
    const durationSeconds = (end - start) / project.sampleRate;
    fs.mkdirSync(path.dirname(opts.outputBase), { recursive: true });

    // Pass 1: loudness of the mix.
    const meter = new LoudnessMeter(project.sampleRate, 2);
    renderRange(mixer, start, end, null, (b, n) => meter.push(b, n), (f) => progress({ phase: 'Measuring loudness', fraction: f }));
    const loudness = meter.integrated();
    const peakDb = meter.peakDb();
    const appliedGainDb = opts.normalize ? normalizationGain(loudness, peakDb, opts.targetLufs, opts.peakCeiling) : 0;
    const gain = dbToGain(appliedGainDb);

    // Pass 2: write outputs.
    const wav = opts.formats.includes('wav') ? new WavWriter(`${opts.outputBase}.wav`, 2, project.sampleRate, 24, 1 << 20) : null;
    let mp3Fd: number | null = null;
    let encoder: Mp3Encoder | null = null;
    const chapters = markersToChapters(project, start).filter((c) => c.start < durationSeconds);
    if (opts.formats.includes('mp3')) {
      const mp3Path = `${opts.outputBase}.mp3`;
      mp3Fd = fs.openSync(mp3Path, 'w');
      const m = project.metadata;
      const tag = buildId3Tag({
        title: m.title || project.name,
        artist: m.author,
        album: m.podcast,
        year: m.year,
        track: m.episode,
        comment: m.description,
        genre: 'Podcast',
        chapters,
        durationSeconds,
      });
      fs.writeSync(mp3Fd, tag);
      encoder = new Mp3Encoder(2, project.sampleRate, opts.mp3Bitrate);
    }
    const l16 = new Int16Array(BLOCK);
    const r16 = new Int16Array(BLOCK);
    const scaled = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    renderRange(
      mixer,
      start,
      end,
      null,
      (b, n) => {
        if (wav) {
          for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) scaled[c][i] = b[c][i] * gain;
          wav.write(scaled, n);
        }
        if (encoder && mp3Fd !== null) {
          const data = encoder.encodeBuffer(toInt16(b[0], n, gain, l16).subarray(0, n), toInt16(b[1], n, gain, r16).subarray(0, n));
          if (data.length) fs.writeSync(mp3Fd, data);
        }
      },
      (f) => progress({ phase: 'Rendering mix', fraction: f }),
    );
    if (wav) {
      wav.close();
      files.push(wav.path);
    }
    if (encoder && mp3Fd !== null) {
      const tail = encoder.flush();
      if (tail.length) fs.writeSync(mp3Fd, tail);
      fs.closeSync(mp3Fd);
      files.push(`${opts.outputBase}.mp3`);
    }

    // Stems: each track on its own, same gain, unnormalised relative balance preserved.
    if (opts.stems) {
      const tracks = project.tracks.filter((t) => t.clips.length > 0);
      tracks.forEach((track, idx) => {
        const stemPath = `${opts.outputBase}-${String(idx + 1).padStart(2, '0')}-${safeName(track.name)}.wav`;
        const w = new WavWriter(stemPath, 2, project.sampleRate, 24, 1 << 20);
        renderRange(mixer, start, end, [track], (b, n) => {
          for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) scaled[c][i] = b[c][i] * gain;
          w.write(scaled, n);
        }, (f) => progress({ phase: `Stem ${track.name}`, fraction: f }));
        w.close();
        files.push(stemPath);
      });
    }

    if (opts.chapterFiles && chapters.length) {
      for (const fmt of CHAPTER_FORMATS) {
        const p = `${opts.outputBase}.${fmt.ext}`;
        fs.writeFileSync(p, exportChapters(chapters, fmt.id, durationSeconds));
        files.push(p);
      }
    }

    progress({ phase: 'Done', fraction: 1 });
    return { files, loudness, peakDb, appliedGainDb };
  } finally {
    readers.closeAll();
  }
}

