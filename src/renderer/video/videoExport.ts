// File › Export Video…: renders the program (the director's switches, framing and dissolves) and
// the mastered mix into an MP4. The sound is the same mix as the audio export (loudness target,
// true-peak limiter, mono); the picture is decoded from the camera files and encoded with WebCodecs.
import { AudioSample, AudioSampleSource, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, StreamTarget, canEncodeAudio, canEncodeVideo, type Quality } from 'mediabunny';
import type { ExportOptions, Project, VideoSettings } from '../../shared/types';
import { DEFAULT_EXPORT_SETTINGS } from '../../core/exportSettings';
import { clipsEnd } from '../../core/project';
import { programAt, videoSettings } from '../../core/video';
import { formatTimestamp } from '../../shared/time';
import { errorMessage, h, toast } from '../dom';
import { api, store } from '../store';
import { FrameReader } from './media';
import { drawProgram, type Picture } from './player';

export interface VideoExportChoice {
  size: VideoSettings;
  quality: 'medium' | 'high' | 'very-high';
  codec: 'avc' | 'av1';
  range: 'all' | 'selection';
}

const SIZES: Array<{ label: string; height: number }> = [
  { label: '720p', height: 720 },
  { label: '1080p', height: 1080 },
  { label: '1440p', height: 1440 },
  { label: '4K', height: 2160 },
];
const RATES = [24, 25, 30, 50, 60];

const QUALITY: Record<VideoExportChoice['quality'], Quality> = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, 'very-high': QUALITY_VERY_HIGH };

/** Width for a height at the episode's aspect ratio (even, as encoders want). */
function widthFor(v: VideoSettings, height: number): number {
  return Math.round((height * v.width) / v.height / 2) * 2;
}

export function openVideoExport(): void {
  const p = store.project;
  if (!p.cameras?.length) return toast('Import a camera video first (File › Import Camera Video…)');
  if (store.transport.state === 'recording') return toast('Stop recording first');
  const v = videoSettings(p);
  const choice: VideoExportChoice = { size: { ...v }, quality: 'high', codec: 'avc', range: 'all' };
  const sel = store.selection.range;
  const hasSel = !!sel && sel[1] > sel[0];
  const portrait = v.height > v.width;
  const sizeSel = h(
    'select',
    {
      onchange: (e: Event) => {
        const height = Number((e.target as HTMLSelectElement).value);
        choice.size = portrait ? { width: height, height: Math.round((height * v.height) / v.width / 2) * 2, fps: choice.size.fps } : { width: widthFor(v, height), height, fps: choice.size.fps };
      },
    },
    ...SIZES.map((s) => h('option', { value: String(s.height), selected: (portrait ? v.width : v.height) === s.height }, s.label)),
  );
  if (![...sizeSel.options].some((o) => o.selected)) sizeSel.append(h('option', { value: String(portrait ? v.width : v.height), selected: true }, `${v.width}×${v.height}`));
  const fpsSel = h(
    'select',
    { onchange: (e: Event) => (choice.size.fps = Number((e.target as HTMLSelectElement).value)) },
    ...[...new Set([...RATES, Math.round(v.fps)])].sort((a, b) => a - b).map((r) => h('option', { value: String(r), selected: Math.round(v.fps) === r }, `${r} fps`)),
  );
  const qualitySel = h(
    'select',
    { onchange: (e: Event) => (choice.quality = (e.target as HTMLSelectElement).value as VideoExportChoice['quality']) },
    h('option', { value: 'medium' }, 'Smaller file'),
    h('option', { value: 'high', selected: true }, 'High (YouTube)'),
    h('option', { value: 'very-high' }, 'Very high (for further editing)'),
  );
  const codecSel = h(
    'select',
    { onchange: (e: Event) => (choice.codec = (e.target as HTMLSelectElement).value as VideoExportChoice['codec']) },
    h('option', { value: 'avc', selected: true }, 'H.264 (plays everywhere)'),
    h('option', { value: 'av1' }, 'AV1 (smaller, royalty-free, slower)'),
  );
  const rangeSel = h(
    'select',
    { onchange: (e: Event) => (choice.range = (e.target as HTMLSelectElement).value as VideoExportChoice['range']) },
    h('option', { value: 'all', selected: true }, 'Whole episode'),
    h('option', { value: 'selection', disabled: !hasSel }, hasSel ? `Selection (${formatTimestamp((sel![1] - sel![0]) / store.sampleRate, false)})` : 'Selection (select a range first)'),
  );
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const row = (label: string, el: HTMLElement) => h('label', { class: 'video-export-row' }, h('span', null, label), el);
  const audio = p.exportSettings ?? DEFAULT_EXPORT_SETTINGS;
  const overlay = h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog narrow' },
      h('h2', null, 'Export video'),
      h('p', { class: 'muted' }, `${p.cameras.length} camera${p.cameras.length === 1 ? '' : 's'}, switched as in the director lane. MP4 file.`),
      row('Size', sizeSel),
      row('Frame rate', fpsSel),
      row('Quality', qualitySel),
      row('Video format', codecSel),
      row('Range', rangeSel),
      h(
        'p',
        { class: 'muted' },
        `Sound: the mix as in the audio export${audio.normalize ? `, loudness ${audio.targetLufs} LUFS, peaks below ${audio.peakCeiling} dBTP` : ''}${audio.mono ? ', mono' : ''} (change it in Export…).`,
      ),
      h(
        'div',
        { class: 'row end' },
        h('button', { onclick: close }, 'Cancel'),
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              close();
              void runVideoExport(choice);
            },
          },
          'Export…',
        ),
      ),
    ),
  );
  document.body.append(overlay);
}

/** A parsed PCM WAV (the mix the audio exporter wrote). */
interface WavData {
  dataStart: number;
  dataBytes: number;
  channels: number;
  sampleRate: number;
  bits: number;
  float: boolean;
}

async function readWavHeader(path: string): Promise<WavData> {
  const head = await api().readFileRange(path, 0, 4096);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (o: number) => String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('The rendered mix is not a WAV file');
  let o = 12;
  let fmt: Omit<WavData, 'dataStart' | 'dataBytes'> | null = null;
  while (o + 8 <= head.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      const format = dv.getUint16(o + 8, true);
      const sub = format === 0xfffe ? dv.getUint16(o + 32, true) : format;
      fmt = { channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true), float: sub === 3 };
    } else if (id === 'data') {
      if (!fmt) break;
      const total = await api().fileSize(path);
      return { ...fmt, dataStart: o + 8, dataBytes: Math.min(size || Infinity, total - o - 8) };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('The rendered mix has no audio data');
}

/** Frames [from, to) of the WAV as planar float32. */
async function readWavFrames(path: string, w: WavData, from: number, to: number): Promise<Float32Array> {
  const bps = w.bits / 8;
  const frameBytes = bps * w.channels;
  const total = Math.floor(w.dataBytes / frameBytes);
  const a = Math.min(total, from);
  const b = Math.min(total, to);
  const n = Math.max(0, b - a);
  const out = new Float32Array(n * w.channels);
  if (!n) return out;
  const bytes = await api().readFileRange(path, w.dataStart + a * frameBytes, w.dataStart + b * frameBytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < w.channels; c++) {
      const o = i * frameBytes + c * bps;
      let v: number;
      if (w.float) v = dv.getFloat32(o, true);
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) v = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8) / 8388608;
      else v = dv.getInt32(o, true) / 2147483648;
      out[c * n + i] = v;
    }
  }
  return out;
}

class Cancelled extends Error {}

async function runVideoExport(choice: VideoExportChoice): Promise<void> {
  const project: Project = store.project;
  const sr = project.sampleRate;
  const sel = store.selection.range;
  const start = choice.range === 'selection' && sel && sel[1] > sel[0] ? Math.round(sel[0]) : 0;
  const end = choice.range === 'selection' && sel && sel[1] > sel[0] ? Math.round(sel[1]) : clipsEnd(project);
  if (end <= start) return toast('There is nothing to export yet');
  const { width, height, fps } = choice.size;
  const name = (project.metadata.title || project.name || 'episode').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'episode';
  const path = await api().chooseVideoExportPath(`${name}.mp4`);
  if (!path) return;

  let cancelled = false;
  const preview = h('canvas', { class: 'video-export-preview' });
  preview.width = 480;
  preview.height = Math.round((480 * height) / width);
  const status = h('div', { class: 'muted' }, 'Mixing the sound…');
  const fill = h('div', { class: 'video-import-fill' });
  const busy = h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog narrow' },
      h('h2', null, 'Exporting video'),
      preview,
      h('div', { class: 'video-import-bar' }, fill),
      status,
      h('div', { class: 'row end' }, h('button', { onclick: () => (cancelled = true) }, 'Cancel')),
    ),
  );
  document.body.append(busy);
  const check = () => {
    if (cancelled) throw new Cancelled('cancelled');
  };

  let tempBase: string | null = null;
  let outId: string | null = null;
  let output: Output | null = null;
  const readers = new Map<string, FrameReader>();
  const unsub = api().onExportProgress((pr) => {
    fill.style.width = `${Math.round(pr.fraction * 20)}%`;
    status.textContent = `Mixing the sound: ${pr.phase}`;
  });
  const t0 = performance.now();
  try {
    // 1. the sound: the same mix as the audio export, as a temporary WAV
    tempBase = await api().videoTempBase();
    const audio = project.exportSettings ?? DEFAULT_EXPORT_SETTINGS;
    const opts: ExportOptions = { ...audio, outputBase: tempBase, formats: ['wav'], stems: false, chapterFiles: false, start, end };
    const res = await api().exportProject(opts);
    unsub();
    check();
    const wavPath = res.files.find((f) => f.endsWith('.wav'));
    if (!wavPath) throw new Error('The mix could not be rendered');
    const wav = await readWavHeader(wavPath);

    // 2. the encoders and the file
    const videoCodec = choice.codec;
    if (!(await canEncodeVideo(videoCodec, { width, height, bitrate: QUALITY[choice.quality] }))) {
      throw new Error(`This computer can't encode ${videoCodec === 'avc' ? 'H.264' : 'AV1'} video at ${width}×${height}. Try ${videoCodec === 'avc' ? 'AV1' : 'H.264'} or a smaller size.`);
    }
    const audioCodec = (await canEncodeAudio('aac', { numberOfChannels: wav.channels, sampleRate: wav.sampleRate, bitrate: 192_000 })) ? 'aac' : 'opus';
    outId = await api().videoOutOpen(path);
    const id = outId;
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      write: (chunk) => api().videoOutWrite(id, chunk.position, chunk.data),
    });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY[choice.quality], keyFrameInterval: 2 });
    const audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: audioCodec === 'aac' ? 192_000 : 128_000 });
    output.addVideoTrack(videoSource, { frameRate: fps });
    output.addAudioTrack(audioSource);
    const meta = project.metadata;
    output.setMetadataTags({
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.author ? { artist: meta.author } : {}),
      ...(meta.podcast ? { album: meta.podcast } : {}),
      ...(meta.description ? { comment: meta.description } : {}),
    });
    await output.start();

    // 3. frame by frame, with the sound interleaved a second at a time
    const frames = Math.ceil(((end - start) / sr) * fps);
    const totalAudio = Math.floor(wav.dataBytes / (wav.channels * (wav.bits / 8)));
    let audioDone = 0;
    const pushAudioUntil = async (seconds: number) => {
      const upTo = Math.min(totalAudio, Math.round(seconds * wav.sampleRate));
      while (audioDone < upTo) {
        const n = Math.min(upTo - audioDone, wav.sampleRate);
        const data = await readWavFrames(wavPath, wav, audioDone, audioDone + n);
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: wav.channels, sampleRate: wav.sampleRate, timestamp: audioDone / wav.sampleRate });
        await audioSource.add(sample);
        sample.close();
        audioDone += n;
      }
    };
    const pctx = preview.getContext('2d')!;
    for (let i = 0; i < frames; i++) {
      check();
      const t = start + Math.round((i / fps) * sr);
      const frame = programAt(project, t);
      const pictures = new Map<string, Picture | null>();
      for (const layer of [frame.a, frame.b]) {
        if (!layer) continue;
        const cam = project.cameras!.find((c) => c.id === layer.camera)!;
        let reader = readers.get(cam.id);
        if (!reader) {
          reader = new FrameReader(cam.file);
          readers.set(cam.id, reader);
        }
        const f = await reader.frameAt(layer.time);
        if (reader.error) throw new Error(`${cam.name}: ${reader.error}`);
        pictures.set(cam.id, f?.canvas ?? null);
      }
      drawProgram(ctx, project, frame, (id) => pictures.get(id) ?? null, width, height);
      await videoSource.add(i / fps, 1 / fps);
      await pushAudioUntil((i + 1) / fps + 1);
      if (i % 10 === 0) {
        pctx.drawImage(canvas, 0, 0, preview.width, preview.height);
        const done = (i + 1) / frames;
        fill.style.width = `${20 + Math.round(done * 80)}%`;
        const elapsed = (performance.now() - t0) / 1000;
        const speed = ((i + 1) / fps) / elapsed;
        status.textContent = `Picture ${formatTimestamp(i / fps, false)} of ${formatTimestamp(frames / fps, false)} · ${speed.toFixed(1)}× real time`;
      }
    }
    await pushAudioUntil(Infinity);
    videoSource.close();
    audioSource.close();
    status.textContent = 'Finishing the file…';
    await output.finalize();
    const written = await api().videoOutClose(outId);
    outId = null;
    const minutes = ((performance.now() - t0) / 60000).toFixed(1);
    toast(`Exported ${written ?? path} in ${minutes} min${audioCodec === 'opus' ? ' (sound as Opus: this computer has no AAC encoder)' : ''}`);
    if (written) void api().revealFile(written);
  } catch (e) {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => undefined);
    if (!(e instanceof Cancelled)) toast(`Video export failed: ${errorMessage(e)}`, 'error');
    else toast('Video export cancelled');
  } finally {
    unsub();
    if (outId) await api().videoOutClose(outId, true).catch(() => undefined);
    if (tempBase) await api().removeVideoTemp(tempBase).catch(() => undefined);
    for (const r of readers.values()) r.dispose();
    busy.remove();
  }
}
