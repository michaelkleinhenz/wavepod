// The video file of an export (Export… with "MP4 video" ticked): renders the program (the
// director's switches, framing and dissolves) with the mastered mix as its sound into an MP4. The
// sound is the same mix as the audio files of the export (loudness target, true-peak limiter,
// mono); the picture is decoded from the camera files and encoded with WebCodecs.
import { AudioSample, AudioSampleSource, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, StreamTarget, canEncodeAudio, canEncodeVideo, type Quality } from 'mediabunny';
import type { ExportOptions, ExportSettings, Frames, Project, VideoExportSettings, VideoSettings } from '../../shared/types';
import { programAt, videoSettings } from '../../core/video';
import { formatTimestamp } from '../../shared/time';
import { api } from '../store';
import { FrameReader } from './media';
import { drawProgram, type Picture } from './player';

const QUALITY: Record<VideoExportSettings['quality'], Quality> = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, 'very-high': QUALITY_VERY_HIGH };

/** Width and height of the exported video: the size is its shorter side, in the shape of the first camera (even, as encoders want). */
export function videoFrameSize(project: Project, size: number): VideoSettings {
  const v = videoSettings(project);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return v.height > v.width ? { width: size, height: even((size * v.height) / v.width), fps: v.fps } : { width: even((size * v.width) / v.height), height: size, fps: v.fps };
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

export class VideoCancelled extends Error {}

export interface VideoJob {
  project: Project;
  /** The audio settings of the export: the video's sound is the same mix. */
  settings: ExportSettings;
  video: VideoExportSettings;
  start: Frames;
  end: Frames;
  /** The .mp4 to write. */
  path: string;
  /** A 24-bit WAV of this mix the export already wrote, else a temporary one is rendered. */
  mixWav?: string;
  onProgress(fraction: number, text: string, picture: OffscreenCanvas | null): void;
  cancelled(): boolean;
}

/** Renders one MP4; returns the file written and the sound codec used (AAC, or Opus without an AAC encoder). */
export async function renderVideo(job: VideoJob): Promise<{ file: string; audioCodec: 'aac' | 'opus' }> {
  const { project, start, end } = job;
  const sr = project.sampleRate;
  if (end <= start) throw new Error('There is nothing to export yet');
  const { width, height } = videoFrameSize(project, job.video.size);
  const fps = job.video.fps;
  const check = () => {
    if (job.cancelled()) throw new VideoCancelled('cancelled');
  };

  let tempBase: string | null = null;
  let outId: string | null = null;
  let output: Output | null = null;
  const readers = new Map<string, FrameReader>();
  const t0 = performance.now();
  try {
    // 1. the sound: the export's mix as a WAV
    let wavPath = job.mixWav;
    if (!wavPath) {
      job.onProgress(0, 'Video: mixing the sound', null);
      tempBase = await api().videoTempBase();
      const { video: _video, ...audio } = job.settings;
      const opts: ExportOptions = { ...audio, outputBase: tempBase, formats: ['wav'], stems: false, chapterFiles: false, start, end };
      const res = await api().exportProject(opts);
      wavPath = res.files.find((f) => f.endsWith('.wav'));
      if (!wavPath) throw new Error('The mix could not be rendered');
    }
    check();
    const wav = await readWavHeader(wavPath);

    // 2. the encoders and the file
    const videoCodec = job.video.codec;
    if (!(await canEncodeVideo(videoCodec, { width, height, bitrate: QUALITY[job.video.quality] }))) {
      throw new Error(`This computer can't encode ${videoCodec === 'avc' ? 'H.264' : 'AV1'} video at ${width}×${height}. Try ${videoCodec === 'avc' ? 'AV1' : 'H.264'} or a smaller size.`);
    }
    const audioCodec = (await canEncodeAudio('aac', { numberOfChannels: wav.channels, sampleRate: wav.sampleRate, bitrate: 192_000 })) ? 'aac' : 'opus';
    outId = await api().videoOutOpen(job.path);
    const id = outId;
    const writable = new WritableStream<{ type: 'write'; data: Uint8Array; position: number }>({
      write: (chunk) => api().videoOutWrite(id, chunk.position, chunk.data),
    });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY[job.video.quality], keyFrameInterval: 2 });
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
        const elapsed = (performance.now() - t0) / 1000;
        const speed = (i + 1) / fps / elapsed;
        job.onProgress((i + 1) / frames, `Video: picture ${formatTimestamp(i / fps, false)} of ${formatTimestamp(frames / fps, false)} · ${speed.toFixed(1)}× real time`, canvas);
      }
    }
    await pushAudioUntil(Infinity);
    videoSource.close();
    audioSource.close();
    job.onProgress(1, 'Video: finishing the file', canvas);
    await output.finalize();
    const written = await api().videoOutClose(outId);
    outId = null;
    return { file: written ?? job.path, audioCodec };
  } catch (e) {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => undefined);
    throw e;
  } finally {
    if (outId) await api().videoOutClose(outId, true).catch(() => undefined);
    if (tempBase) await api().removeVideoTemp(tempBase).catch(() => undefined);
    for (const r of readers.values()) r.dispose();
  }
}
