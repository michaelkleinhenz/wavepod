// Waveform drawing at any zoom: min/max bars from the matching peak level, min/max bars from
// raw samples below the finest level, and a line through the individual samples (with a dot
// per sample once they are far enough apart) when a sample is wider than a pixel.
import type { PeakLevel, WaveformPeaks } from '../shared/types';
import { chooseWaveSource } from '../core/peaks';
import type { WaveCache } from './waveCache';

/** Samples get a dot once they are at least this many pixels apart. */
const SAMPLE_DOT_PX = 6;

export interface WaveLayout {
  /** Visible pixel columns to draw, [x0, x1). */
  x0: number;
  x1: number;
  /** x of source frame `srcStart`. */
  originX: number;
  /** Source frames drawn, [srcStart, srcEnd). */
  srcStart: number;
  srcEnd: number;
  framesPerPx: number;
  /** Centre line and half height for full scale. */
  mid: number;
  half: number;
  /** Vertical clamp. */
  top: number;
  bottom: number;
  color: string;
  /** Gain at a source frame (fades, volume line), drawn into the waveform. */
  gain?: (src: number) => number;
}

/** Min/max buckets of one resolution; values are full scale at ±scale. */
interface Buckets {
  spp: number;
  count: number;
  scale: number;
  min(k: number): number;
  max(k: number): number;
  /** Single value per item (raw samples, where min and max are the same). */
  value?(k: number): number;
}

function levelBuckets(l: PeakLevel): Buckets {
  const d = l.data;
  return { spp: l.samplesPerPeak, count: d.length >> 1, scale: 127, min: (k) => d[k * 2], max: (k) => d[k * 2 + 1] };
}

/** Visible source range of a layout. */
function visibleSource(p: WaveLayout): [number, number] {
  const a = p.srcStart + Math.max(0, p.x0 - p.originX) * p.framesPerPx;
  const b = Math.min(p.srcEnd, p.srcStart + (p.x1 - p.originX) * p.framesPerPx);
  return [Math.max(p.srcStart, a), b];
}

/** One vertical min/max bar per pixel column. `connect` joins neighbouring columns (raw samples). */
function drawBars(ctx: CanvasRenderingContext2D, p: WaveLayout, src: Buckets, connect: boolean): void {
  ctx.fillStyle = p.color;
  const amp = p.half / src.scale;
  const fpp = p.framesPerPx;
  for (let x = p.x0; x < p.x1; x++) {
    const fa = Math.max(p.srcStart, p.srcStart + (x - p.originX) * fpp);
    const fb = Math.min(p.srcEnd, p.srcStart + (x + 1 - p.originX) * fpp);
    if (fb <= fa) {
      if (fa >= p.srcEnd) break;
      continue;
    }
    let a = Math.floor(fa / src.spp);
    const b = Math.min(src.count, Math.max(a + 1, Math.ceil(fb / src.spp)));
    if (a >= src.count) break;
    if (connect && a > Math.floor(p.srcStart / src.spp)) a--;
    let mn = Infinity;
    let mx = -Infinity;
    if (src.value) {
      for (let k = a; k < b; k++) {
        const v = src.value(k);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    } else {
      for (let k = a; k < b; k++) {
        const lo = src.min(k);
        const hi = src.max(k);
        if (lo < mn) mn = lo;
        if (hi > mx) mx = hi;
      }
    }
    if (!connect) {
      // peak bars always include the centre line, as before
      if (mn > 0) mn = 0;
      if (mx < 0) mx = 0;
    }
    const g = p.gain ? p.gain(fa) : 1;
    const top = Math.max(p.top, p.mid - mx * amp * g);
    const bot = Math.min(p.bottom, p.mid - mn * amp * g);
    ctx.fillRect(x, top, 1, Math.max(1, bot - top));
  }
}

/** A line through the samples, each one drawn at its own x; dots once they are far apart. */
function drawSampleLine(ctx: CanvasRenderingContext2D, p: WaveLayout, sample: (i: number) => number): void {
  const fpp = p.framesPerPx;
  const first = Math.max(Math.ceil(p.srcStart), Math.floor(p.srcStart + (p.x0 - p.originX) * fpp) - 1);
  const last = Math.min(Math.ceil(p.srcEnd) - 1, Math.ceil(p.srcStart + (p.x1 - p.originX) * fpp) + 1);
  if (last < first) return;
  const xOf = (i: number) => p.originX + (i - p.srcStart) / fpp;
  const yOf = (i: number) => Math.max(p.top, Math.min(p.bottom, p.mid - sample(i) * p.half * (p.gain ? p.gain(i) : 1)));
  // zero line, so the sample values read against it
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  const zx0 = Math.max(p.x0, xOf(first));
  ctx.fillRect(zx0, Math.round(p.mid), Math.max(0, Math.min(p.x1, xOf(last)) - zx0), 1);
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = first; i <= last; i++) {
    if (i === first) ctx.moveTo(xOf(i), yOf(i));
    else ctx.lineTo(xOf(i), yOf(i));
  }
  ctx.stroke();
  ctx.lineWidth = 1;
  if (1 / fpp >= SAMPLE_DOT_PX) {
    ctx.fillStyle = p.color;
    const r = 1 / fpp >= 2 * SAMPLE_DOT_PX ? 2 : 1.5;
    for (let i = first; i <= last; i++) {
      const x = xOf(i);
      if (x < p.x0 - r || x > p.x1 + r) continue;
      ctx.fillRect(x - r, yOf(i) - r, 2 * r, 2 * r);
    }
  }
}

/** The coarsest in-memory level that is at most `framesPerPx` per bucket (else the finest). */
function coarseLevel(levels: PeakLevel[], framesPerPx: number): PeakLevel | undefined {
  let best = levels[0];
  for (const l of levels) if (l.samplesPerPeak <= framesPerPx) best = l;
  return best;
}

/**
 * Draws a media file's waveform at the resolution the zoom needs. Data that is not loaded
 * yet is requested and drawn from the next coarser level meanwhile.
 */
export function drawFileWaveform(ctx: CanvasRenderingContext2D, cache: WaveCache, file: string, peaks: WaveformPeaks, p: WaveLayout): void {
  if (p.x1 <= p.x0) return;
  const tiled = [...(peaks.tiled ?? [])].sort((a, b) => a - b);
  const choice = chooseWaveSource(p.framesPerPx, [...tiled, ...peaks.levels.map((l) => l.samplesPerPeak)]);
  const [va, vb] = visibleSource(p);
  if (vb <= va) return;
  let spp = choice.kind === 'peaks' ? choice.samplesPerPeak : undefined;
  if (choice.kind === 'samples') {
    const a = Math.max(0, Math.floor(va) - 2);
    const span = cache.sampleSpan(file, a, Math.ceil(vb) + 2);
    if (span) {
      if (p.framesPerPx <= 1) drawSampleLine(ctx, p, (i) => span.at(i));
      else {
        const value = (k: number) => span.at(k);
        drawBars(ctx, p, { spp: 1, count: Math.ceil(peaks.length), scale: 1, min: value, max: value, value }, true);
      }
      return;
    }
    spp = tiled[0];
  }
  if (spp !== undefined && tiled.includes(spp)) {
    const span = cache.peakSpan(file, spp, Math.floor(va / spp), Math.ceil(vb / spp) + 1);
    if (span) {
      drawBars(ctx, p, { spp, count: Math.ceil(peaks.length / spp), scale: 127, min: (k) => span.at(k, 0), max: (k) => span.at(k, 1) }, false);
      return;
    }
  }
  const level = coarseLevel(peaks.levels, p.framesPerPx);
  if (level?.data.length) drawBars(ctx, p, levelBuckets(level), false);
}

/** Draws a waveform from in-memory levels only (the take being recorded). */
export function drawLevelsWaveform(ctx: CanvasRenderingContext2D, levels: PeakLevel[], p: WaveLayout): void {
  if (p.x1 <= p.x0 || !levels.length) return;
  const level = coarseLevel(levels, p.framesPerPx);
  if (level?.data.length) drawBars(ctx, p, levelBuckets(level), false);
}
