// Offline mixdown: loudness measurement, normalisation, WAV/MP3 with ID3 chapters, stems, chapter files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mp3Encoder } from '@breezystack/lamejs';
import type { ExportOptions, ExportProgress, ExportResult, ExportWave, LiveLoudness, LoudnessStats, Project, Track } from '../shared/types';
import { dbToGain } from '../shared/time';
import { CHAPTER_FORMATS, exportChapters } from './chapters';
import { buildId3Tag, imageMime, type Id3Chapter, type Id3Picture } from './id3';
import { LoudnessMeter, normalizationGain } from './loudness';
import { Mixer, ReaderCache, projectLength } from './mixer';
import { markersToChapters } from './project';
import { WavWriter } from './wav';
import { FlacWriter } from './flac';
import { OpusWriter } from './opus';
import { TruePeakLimiter } from './truePeakLimiter';
import { STEM_GROUPS, stemFilePath, stemIndex } from './stems';

const BLOCK = 4096;
/** Width of the export waveform in columns, whatever the length of the export. */
export const WAVE_COLUMNS = 1000;
/** Progress is reported at most this often (ms), plus once at the end of each pass. */
const REPORT_INTERVAL = 50;

export type ProgressFn = (p: ExportProgress) => void;

/**
 * Follows the rendered mix for the progress display: a waveform (min/max per column)
 * and the loudness so far. `take()` hands over what is new since the last call.
 */
export class LiveTap {
  private peaks: Float32Array;
  private pos = 0;
  private sent = 0;
  private readonly scale: number;

  constructor(total: number, readonly meter: LoudnessMeter, readonly columns = WAVE_COLUMNS) {
    this.peaks = new Float32Array(columns * 2);
    this.scale = columns / Math.max(1, total);
  }

  /** Adds rendered audio (also measured by `meter`). */
  push(block: Float32Array[], frames: number): void {
    this.meter.push(block, frames);
    const [l, r] = block;
    const peaks = this.peaks;
    const last = this.columns - 1;
    for (let i = 0; i < frames; i++) {
      const c = Math.min(last, Math.floor((this.pos + i) * this.scale)) * 2;
      const a = l[i];
      const b = r[i];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      if (lo < peaks[c]) peaks[c] = lo;
      if (hi > peaks[c + 1]) peaks[c + 1] = hi;
    }
    this.pos += frames;
  }

  take(): { wave: ExportWave; live: LiveLoudness } {
    // the column being filled is sent again next time
    const done = Math.min(this.columns, Math.ceil(this.pos * this.scale));
    const start = Math.max(0, Math.min(this.sent, done - 1));
    const wave = { columns: this.columns, start, peaks: Array.from(this.peaks.subarray(start * 2, done * 2)) };
    this.sent = Math.max(start, Math.floor(this.pos * this.scale));
    const m = this.meter;
    return { wave, live: { momentary: m.momentary(), shortTerm: m.shortTerm(), integrated: m.integrated(), truePeak: m.truePeakDb() } };
  }
}

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
  let lastTime = Date.now();
  for (let pos = start; pos < end; pos += BLOCK) {
    const n = Math.min(BLOCK, end - pos);
    if (tracks) {
      mixer.renderStems(tracks, pos, n, out);
    } else {
      mixer.render(pos, n, out);
    }
    onBlock(out, n);
    const f = (pos - start + n) / total;
    if (onProgress && f > lastReport && (f >= 1 || Date.now() - lastTime >= REPORT_INTERVAL)) {
      lastReport = f;
      lastTime = Date.now();
      onProgress(f);
    }
  }
}

export function measureLoudness(project: Project, projectDir: string, tracks?: Track[]): LoudnessStats {
  const readers = new ReaderCache(projectDir);
  const mixer = new Mixer(project, readers);
  try {
    const meter = new LoudnessMeter(project.sampleRate, 2);
    renderRange(mixer, 0, projectLength(project), tracks ?? null, (b, n) => meter.push(b, n));
    return meter.stats();
  } finally {
    mixer.dispose();
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

export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'track';
}

/** Reads a JPEG or PNG from the project folder; null if it is missing or another format. */
export function loadPicture(projectDir: string, rel: string | undefined): Id3Picture | null {
  if (!rel) return null;
  try {
    const data = fs.readFileSync(path.resolve(projectDir, rel));
    const mime = imageMime(data);
    return mime ? { mime, data } : null;
  } catch {
    return null;
  }
}

/**
 * Copies chapter images next to the export ("<base>-chapter-01.jpg", …) and returns the chapters
 * with `image` set to those file names, for the chapter files. Missing images are left out.
 */
function exportChapterImages(chapters: Id3Chapter[], projectDir: string, outputBase: string, files: string[]): Id3Chapter[] {
  return chapters.map((c, i) => {
    if (!c.image) return c;
    const src = path.resolve(projectDir, c.image);
    if (!c.picture || !fs.existsSync(src)) {
      const { image: _i, ...rest } = c;
      return rest;
    }
    const name = `${path.basename(outputBase)}-chapter-${String(i + 1).padStart(2, '0')}${c.picture.mime === 'image/png' ? '.png' : '.jpg'}`;
    const dest = path.join(path.dirname(outputBase), name);
    fs.copyFileSync(src, dest);
    files.push(dest);
    return { ...c, image: name };
  });
}

/** The export limiter holds true peaks a hair under the ceiling, so rounding and the meter's own estimate stay below it. */
function makeLimiter(sampleRate: number, ceilingDb: number): TruePeakLimiter {
  return new TruePeakLimiter(sampleRate, dbToGain(ceilingDb - 0.05));
}

/** Passes over the mix that may be spent getting the limited loudness onto the target. */
const MAX_FIT_PASSES = 3;
const FIT_TOLERANCE_LU = 0.1;

/** Integrated loudness of the mix with `gainDb` applied and its peaks limited at `ceilingDb`. */
function limitedLoudness(mixer: Mixer, start: number, end: number, sampleRate: number, gainDb: number, ceilingDb: number, onProgress: (f: number) => void): number {
  const meter = new LoudnessMeter(sampleRate, 2);
  const lim = makeLimiter(sampleRate, ceilingDb);
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const g = dbToGain(gainDb);
  renderRange(mixer, start, end, null, (b, n) => {
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) b[c][i] *= g;
    lim.process(b[0], b[1], n, out[0], out[1]);
    meter.push(out, n);
  }, onProgress);
  const tail = [new Float32Array(lim.latency), new Float32Array(lim.latency)];
  lim.flush(tail[0], tail[1]);
  meter.push(tail, lim.latency);
  return meter.integrated();
}

/**
 * Writes the dialogue, music and effects stems (and the M&E mix when asked) in one pass over the
 * timeline: every audible track goes to the stem of its Track.stem, with ducking and the automix
 * working as in the mix, so the stems add up to the mix before the master filters and the limiter.
 * All three files are written even when a stem has no tracks, as delivery specs expect a full set.
 */
const MUSIC = STEM_GROUPS.findIndex((g) => g.id === 'music');
const EFFECTS = STEM_GROUPS.findIndex((g) => g.id === 'effects');

function writeDmeStems(mixer: Mixer, project: Project, opts: ExportOptions, start: number, end: number, gain: number, files: string[], progress: ProgressFn): void {
  const flacStem = opts.stemFormat === 'flac';
  const ext = flacStem ? 'flac' : 'wav';
  const open = (p: string, title: string) => (flacStem ? new FlacWriter(p, 2, project.sampleRate, 24, { title }) : new WavWriter(p, 2, project.sampleRate, 24, 1 << 20));
  const title = project.metadata.title || project.name;
  const writers = STEM_GROUPS.map((g) => open(stemFilePath(opts.outputBase, g.id, ext), `${title} (${g.label})`));
  const me = opts.stemMe ? open(stemFilePath(opts.outputBase, 'me', ext), `${title} (Music & effects)`) : null;
  // one buffer per stem, plus one for the tracks left out (they still drive ducking and the automix)
  const bufs = [...STEM_GROUPS, null].map(() => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
  const drop = STEM_GROUPS.length;
  const route = (t: Track) => {
    const i = stemIndex(t);
    return i < 0 ? drop : i;
  };
  const mix = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const total = Math.max(1, end - start);
  let lastTime = Date.now();
  for (let pos = start; pos < end; pos += BLOCK) {
    const n = Math.min(BLOCK, end - pos);
    mixer.renderSplit(pos, n, bufs, route);
    writers.forEach((w, k) => {
      const [l, r] = bufs[k];
      for (let i = 0; i < n; i++) {
        l[i] *= gain;
        r[i] *= gain;
      }
      w.write(bufs[k], n);
    });
    if (me) {
      const music = bufs[MUSIC];
      const fx = bufs[EFFECTS];
      for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) mix[c][i] = music[c][i] + fx[c][i];
      me.write(mix, n);
    }
    const f = (pos - start + n) / total;
    if (f >= 1 || Date.now() - lastTime >= REPORT_INTERVAL) {
      lastTime = Date.now();
      progress({ phase: 'Stems (dialogue, music, effects)', fraction: f });
    }
  }
  for (const w of [...writers, ...(me ? [me] : [])]) {
    w.close();
    files.push(w.path);
  }
}

export function exportProject(project: Project, projectDir: string, opts: ExportOptions, progress: ProgressFn = () => {}): ExportResult {
  const readers = new ReaderCache(projectDir);
  const files: string[] = [];
  const mixer = new Mixer(project, readers);
  try {
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.max(start, opts.end ?? projectLength(project));
    const durationSeconds = (end - start) / project.sampleRate;
    fs.mkdirSync(path.dirname(opts.outputBase), { recursive: true });

    // Pass 1: loudness of the mix.
    const meter = new LoudnessMeter(project.sampleRate, 2);
    const measureTap = new LiveTap(end - start, meter);
    // the mix is measured for normalisation and rendered for mix files; stems alone need neither
    const mixFiles = opts.formats.length > 0;
    if (mixFiles || opts.normalize) {
      renderRange(mixer, start, end, null, (b, n) => measureTap.push(b, n), (f) => progress({ phase: 'Measuring loudness', fraction: f, ...measureTap.take() }));
    }
    const loudness = meter.integrated();
    const peakDb = meter.peakDb();
    // The ceiling is in dBTP, like the loudness analysis: the peaks between samples count too.
    // Gain alone stops where the loudest peak meets the ceiling, which for speech is often well
    // short of the target; a true-peak limiter then holds the peaks so the target is reached.
    let appliedGainDb = 0;
    let limiting = false;
    if (opts.normalize && Number.isFinite(loudness)) {
      appliedGainDb = opts.targetLufs - loudness;
      limiting = meter.truePeakDb() + appliedGainDb > opts.peakCeiling;
      if (limiting && mixFiles) {
        // limiting takes a little loudness off: measure the limited mix and make up for it,
        // again if the make-up gain itself got limited enough to miss
        for (let pass = 1; pass <= MAX_FIT_PASSES; pass++) {
          const reached = limitedLoudness(mixer, start, end, project.sampleRate, appliedGainDb, opts.peakCeiling, (f) =>
            progress({ phase: pass === 1 ? 'Fitting the limiter' : `Fitting the limiter (${pass})`, fraction: f }),
          );
          const short = opts.targetLufs - reached;
          if (!Number.isFinite(short) || Math.abs(short) <= FIT_TOLERANCE_LU) break;
          appliedGainDb += Math.max(-6, Math.min(short, 6));
        }
      }
    } else if (opts.normalize) {
      appliedGainDb = normalizationGain(loudness, meter.truePeakDb(), opts.targetLufs, opts.peakCeiling);
    }
    const gain = dbToGain(appliedGainDb);
    const limiter = limiting ? makeLimiter(project.sampleRate, opts.peakCeiling) : null;

    // Pass 2: write outputs.
    const wav = opts.formats.includes('wav') ? new WavWriter(`${opts.outputBase}.wav`, 2, project.sampleRate, 24, 1 << 20) : null;
    let mp3Fd: number | null = null;
    let encoder: Mp3Encoder | null = null;
    const chapters: Id3Chapter[] = markersToChapters(project, start)
      .filter((c) => c.start < durationSeconds)
      .map((c) => {
        const picture = loadPicture(projectDir, c.image);
        return picture ? { ...c, picture } : c;
      });
    const cover = loadPicture(projectDir, project.metadata.artwork);
    const m0 = project.metadata;
    const textTags = {
      title: m0.title || project.name,
      artist: m0.author,
      album: m0.podcast,
      date: m0.year,
      track: m0.episode,
      description: m0.description,
      genre: m0.category || 'Podcast',
      chapters,
      ...(cover ? { cover } : {}),
    };
    const flac = opts.formats.includes('flac') ? new FlacWriter(`${opts.outputBase}.flac`, 2, project.sampleRate, 24, textTags) : null;
    const opus = opts.formats.includes('opus') ? new OpusWriter(`${opts.outputBase}.opus`, project.sampleRate, opts.opusBitrate ?? 64, textTags) : null;
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
        genre: m.category || 'Podcast',
        ...(cover ? { cover } : {}),
        chapters,
        durationSeconds,
      });
      fs.writeSync(mp3Fd, tag);
      encoder = new Mp3Encoder(2, project.sampleRate, opts.mp3Bitrate);
    }
    const l16 = new Int16Array(BLOCK);
    const r16 = new Int16Array(BLOCK);
    const scaled = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // waveform and loudness of the audio as written (after normalisation)
    const renderTap = new LiveTap(end - start, new LoudnessMeter(project.sampleRate, 2));
    const emit = (out: Float32Array[], n: number): void => {
      if (n <= 0) return;
      renderTap.push(out, n);
      if (wav) wav.write(out, n);
      if (flac) flac.write(out, n);
      if (opus) opus.write(out, n);
      if (encoder && mp3Fd !== null) {
        const data = encoder.encodeBuffer(toInt16(out[0], n, 1, l16).subarray(0, n), toInt16(out[1], n, 1, r16).subarray(0, n));
        if (data.length) fs.writeSync(mp3Fd, data);
      }
    };
    // the limiter's output lags its input; the first frames out are its delay, the last come from flush()
    let skip = limiter ? limiter.latency : 0;
    const limited = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    if (mixFiles) {
      renderRange(
        mixer,
        start,
        end,
        null,
        (b, n) => {
          for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) scaled[c][i] = b[c][i] * gain;
          if (!limiter) return emit(scaled, n);
          limiter.process(scaled[0], scaled[1], n, limited[0], limited[1]);
          const drop = Math.min(skip, n);
          skip -= drop;
          emit([limited[0].subarray(drop), limited[1].subarray(drop)], n - drop);
        },
        (f) => progress({ phase: 'Rendering mix', fraction: f, ...renderTap.take() }),
      );
      if (limiter) {
        const tail = [new Float32Array(limiter.latency), new Float32Array(limiter.latency)];
        limiter.flush(tail[0], tail[1]);
        // what is still to skip here is left over from a render shorter than the delay
        emit([tail[0].subarray(skip), tail[1].subarray(skip)], limiter.latency - skip);
      }
    }
    if (wav) {
      wav.close();
      files.push(wav.path);
    }
    if (flac) {
      flac.close();
      files.push(flac.path);
    }
    if (opus) {
      opus.close();
      files.push(opus.path);
    }
    if (encoder && mp3Fd !== null) {
      const tail = encoder.flush();
      if (tail.length) fs.writeSync(mp3Fd, tail);
      fs.closeSync(mp3Fd);
      files.push(`${opts.outputBase}.mp3`);
    }

    // Stems: same gain as the mix (no limiter), so their unnormalised balance is preserved.
    if (opts.stems && opts.stemMode === 'dme') {
      writeDmeStems(mixer, project, opts, start, end, gain, files, progress);
    } else if (opts.stems) {
      // each track on its own
      const tracks = project.tracks.filter((t) => t.clips.length > 0);
      tracks.forEach((track, idx) => {
        const flacStem = opts.stemFormat === 'flac';
        const stemPath = `${opts.outputBase}-${String(idx + 1).padStart(2, '0')}-${safeName(track.name)}.${flacStem ? 'flac' : 'wav'}`;
        const w = flacStem ? new FlacWriter(stemPath, 2, project.sampleRate, 24, { title: track.name }) : new WavWriter(stemPath, 2, project.sampleRate, 24, 1 << 20);
        renderRange(mixer, start, end, [track], (b, n) => {
          for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) scaled[c][i] = b[c][i] * gain;
          w.write(scaled, n);
        }, (f) => progress({ phase: `Stem ${track.name}`, fraction: f }));
        w.close();
        files.push(stemPath);
      });
    }

    if (opts.chapterFiles && chapters.length) {
      const listed = exportChapterImages(chapters, projectDir, opts.outputBase, files);
      for (const fmt of CHAPTER_FORMATS) {
        const p = `${opts.outputBase}.${fmt.ext}`;
        fs.writeFileSync(p, exportChapters(listed, fmt.id, durationSeconds));
        files.push(p);
      }
    }

    progress({ phase: 'Done', fraction: 1 });
    const written = renderTap.meter;
    return {
      files,
      loudness,
      peakDb,
      appliedGainDb,
      ...(mixFiles ? { outputLoudness: written.integrated(), outputTruePeakDb: written.truePeakDb() } : {}),
      limiterReductionDb: limiter ? limiter.maxReductionDb : 0,
    };
  } finally {
    mixer.dispose();
    readers.closeAll();
  }
}

