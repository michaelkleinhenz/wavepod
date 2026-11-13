// Camera video files in the window: reading them (bytes come from the main process in ranges),
// probing, pulling the sound out, and decoding frames in order with WebCodecs (through Mediabunny).
import { ALL_FORMATS, AudioSampleSink, CanvasSink, CustomSource, Input, type InputVideoTrack, type WrappedCanvas } from 'mediabunny';
import { api } from '../store';

/** A camera file as a Mediabunny input; bytes are read through the main process. */
export function openInput(file: string): Input {
  let size: number | null = null;
  const source = new CustomSource({
    getSize: async () => (size ??= await api().fileSize(file)),
    read: async (start, end) => api().readFileRange(file, start, end),
    prefetchProfile: 'fileSystem',
    maxCacheSize: 32 * 1024 * 1024,
  });
  return new Input({ source, formats: ALL_FORMATS });
}

export interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  duration: number;
  codec: string;
  /** Whether this computer can decode the picture. */
  decodable: boolean;
  /** The file has a sound track. */
  hasAudio: boolean;
  /** Time (s) of the first sound sample in the video's clock. */
  audioStart: number;
}

export async function probeVideo(file: string): Promise<VideoProbe> {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('This file has no video');
    const audio = await input.getPrimaryAudioTrack();
    const stats = await video.computePacketStats(120).catch(() => null);
    const duration = await input.computeDuration();
    return {
      width: video.displayWidth,
      height: video.displayHeight,
      fps: stats?.averagePacketRate ? Math.round(stats.averagePacketRate * 1000) / 1000 : 30,
      duration,
      codec: String(video.codec ?? 'unknown'),
      decodable: await video.canDecode(),
      hasAudio: !!audio && (await audio.canDecode()),
      audioStart: audio ? await audio.getFirstTimestamp() : 0,
    };
  } finally {
    input.dispose();
  }
}

/**
 * Decodes a video's sound at `sampleRate` (at most two channels) and hands it on in blocks, so a
 * long recording never has to fit in memory. Sample-rate changes use linear interpolation: this is
 * the camera's reference sound, for syncing and listening along, not the mix.
 */
export async function decodeVideoAudio(
  file: string,
  sampleRate: number,
  onBlock: (channels: Float32Array[]) => Promise<void>,
  onProgress: (fraction: number) => void = () => {},
): Promise<{ channels: number }> {
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This video has no sound');
    const duration = (await input.computeDuration()) || 1;
    const nch = Math.min(2, track.numberOfChannels);
    const ratio = track.sampleRate / sampleRate;
    const resampler = new LinearResampler(nch, ratio);
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples()) {
      try {
        const n = sample.numberOfFrames;
        const planes: Float32Array[] = [];
        for (let c = 0; c < nch; c++) {
          const buf = new Float32Array(n);
          sample.copyTo(buf, { planeIndex: Math.min(c, sample.numberOfChannels - 1), format: 'f32-planar' });
          planes.push(buf);
        }
        const out = resampler.push(planes);
        if (out[0].length) await onBlock(out);
        onProgress(Math.min(1, (sample.timestamp + sample.duration) / duration));
      } finally {
        sample.close();
      }
    }
    return { channels: nch };
  } finally {
    input.dispose();
  }
}

/** Streaming linear-interpolation resampler (ratio = input rate / output rate). */
export class LinearResampler {
  private pos = 0;
  private last: number[];

  constructor(
    private channels: number,
    private ratio: number,
  ) {
    this.last = new Array(channels).fill(0);
  }

  push(input: Float32Array[]): Float32Array[] {
    if (this.ratio === 1) return input;
    const n = input[0].length;
    // input sample i sits at index i + 1 of [last, ...input]
    const out: number[][] = Array.from({ length: this.channels }, () => []);
    while (this.pos < n) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      for (let c = 0; c < this.channels; c++) {
        const a = i === 0 ? this.last[c] : input[c][i - 1];
        const b = input[c][i];
        out[c].push(a + (b - a) * f);
      }
      this.pos += this.ratio;
    }
    this.pos -= n;
    for (let c = 0; c < this.channels; c++) this.last[c] = input[c][n - 1];
    return out.map((o) => Float32Array.from(o));
  }
}

/**
 * Frames of one video, read in order: asking for a time a little after the last one decodes on
 * from there; a time far away (a cut, a seek) starts decoding again from the nearest key frame.
 */
export class FrameReader {
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private cur: WrappedCanvas | null = null;
  private peek: WrappedCanvas | null = null;
  private opening: Promise<void> | null = null;
  /** Failure opening the file (missing, codec not supported). */
  error: string | null = null;
  track: InputVideoTrack | null = null;

  constructor(
    readonly file: string,
    private size: { width?: number; height?: number } = {},
  ) {}

  private open(): Promise<void> {
    this.opening ??= (async () => {
      try {
        this.input = openInput(this.file);
        this.track = await this.input.getPrimaryVideoTrack();
        if (!this.track) throw new Error('no video in the file');
        if (!(await this.track.canDecode())) throw new Error(`this computer can't decode ${this.track.codec ?? 'its'} video`);
        const w = this.size.width && this.track.displayWidth > this.size.width ? this.size.width : undefined;
        this.sink = new CanvasSink(this.track, { ...(w ? { width: w } : {}), fit: 'contain' });
      } catch (e) {
        this.error = (e as Error).message;
      }
    })();
    return this.opening;
  }

  /** The frame showing at `t` seconds (the last frame starting at or before it). */
  async frameAt(t: number): Promise<WrappedCanvas | null> {
    await this.open();
    if (!this.sink) return null;
    const near = this.iter && this.cur && t >= this.cur.timestamp - 1e-3 && t < this.cur.timestamp + 2;
    if (!near) {
      await this.iter?.return(undefined).catch(() => undefined);
      this.iter = this.sink.canvases(Math.max(0, t));
      this.peek = null;
      const first = await this.iter.next();
      this.cur = first.done ? null : first.value;
      if (!this.cur) {
        // past the end: the last frame stays
        this.iter = null;
        return (await this.sink.getCanvas(Math.max(0, t)).catch(() => null)) ?? null;
      }
    }
    for (;;) {
      if (!this.peek) {
        const r = await this.iter!.next();
        if (r.done) break;
        this.peek = r.value;
      }
      if (this.peek.timestamp <= t + 1e-4) {
        this.cur = this.peek;
        this.peek = null;
      } else break;
    }
    return this.cur;
  }

  dispose(): void {
    void this.iter?.return(undefined).catch(() => undefined);
    this.iter = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}

/**
 * Keeps one camera's picture current while the playhead moves: the newest wanted time is decoded
 * as soon as the previous one is done, and drawn into `view`. Slow decoding drops frames, never
 * holds the audio up.
 */
export class LiveFrame {
  readonly view = document.createElement('canvas');
  private reader: FrameReader;
  private wanted: number | null = null;
  private busy = false;
  /** Video time shown in `view`, or null for nothing yet. */
  shown: number | null = null;
  onDraw: () => void = () => {};

  constructor(
    readonly file: string,
    width = 1280,
  ) {
    this.reader = new FrameReader(file, { width });
  }

  get error(): string | null {
    return this.reader.error;
  }

  want(t: number | null): void {
    this.wanted = t;
    if (t === null) {
      if (this.shown !== null) {
        this.shown = null;
        this.onDraw();
      }
      return;
    }
    if (!this.busy) void this.pump();
  }

  private async pump(): Promise<void> {
    this.busy = true;
    try {
      while (this.wanted !== null) {
        const t = this.wanted;
        const frame = await this.reader.frameAt(t);
        if (frame && this.wanted !== null) {
          const src = frame.canvas;
          if (this.view.width !== src.width || this.view.height !== src.height) {
            this.view.width = src.width;
            this.view.height = src.height;
          }
          this.view.getContext('2d')!.drawImage(src, 0, 0);
          this.shown = frame.timestamp;
          this.onDraw();
        }
        if (this.wanted === t || this.reader.error) break;
      }
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.wanted = null;
    this.reader.dispose();
  }
}
