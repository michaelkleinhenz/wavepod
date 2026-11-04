// Watches a running recording for problems and reports them while there is still time to react:
// lost audio (dropouts / buffer overruns), clicks and crackle, clipping, inputs without signal,
// a stalled input device, a disk that is filling up or can't keep up, and write errors.
import type { RecordingEvent, RecordingHealth, RecordingWarning } from '../shared/types';

export interface MonitoredTrack {
  trackId: string;
  name: string;
  /** Device input channels recorded on this track. */
  channels: number[];
}

export interface MonitorOptions {
  sampleRate: number;
  /** Frames per device buffer (the configured buffer size). */
  bufferSize: number;
  tracks: MonitoredTrack[];
  /** Bytes per second the recording adds to the disk. */
  bytesPerSecond: number;
}

/** What the writer and the file system report, passed to tick(). */
export interface WriterState {
  /** Bytes of audio not yet on disk. */
  queuedBytes: number;
  error: string | null;
  droppedFrames: number;
  /** Free space on the recording disk, if known. */
  freeBytes: number | null;
}

// ---- thresholds
/** A sample at or above this is at full scale. */
export const CLIP_LEVEL = 0.999;
/** Samples in a row at full scale that count as clipping. */
const CLIP_RUN = 3;
/** Below this a click is too small to hear (-40 dBFS). */
const CLICK_MIN = 0.01;
/** A click stands out this far from the signal around it. */
const CLICK_RATIO = 10;
/** Samples after a click candidate that must be calm again. */
const CLICK_POST = 64;
/** Clicks in CRACKLE_WINDOW seconds that count as crackle. */
const CRACKLE_CLICKS = 3;
const CRACKLE_WINDOW = 5;
/** -80 dBFS: below this an input is treated as silent. */
const SILENCE_LEVEL = 1e-4;
/** Seconds without any signal since the take started before warning. */
const NO_SIGNAL_START = 5;
/** Seconds of silence after there was signal before warning. */
const NO_SIGNAL_LATER = 60;
/** Seconds without input buffers that count as a stalled device. */
const STALL_SECONDS = 1;
/** How long a passing problem stays on screen. */
const SHOW_SECONDS = 8;
/** Seconds of audio held back by the writer that mean the disk can't keep up. */
const SLOW_DISK_SECONDS = 2;
/** Disk space warnings, in minutes of recording left. */
const DISK_LOW_MIN = 30;
const DISK_CRITICAL_MIN = 5;
/** Events of one kind and track closer than this merge into one. */
const MERGE_SECONDS = 5;
const MAX_EVENTS = 200;

interface ChannelState {
  channel: number;
  x1: number;
  x2: number;
  /** Mean of |second difference| (the signal's "roughness"). */
  env: number;
  cand: { pos: number; mag: number; pre: number; postSum: number; postN: number } | null;
  clipRun: number;
}

interface TrackState {
  track: MonitoredTrack;
  chans: ChannelState[];
  everSignal: boolean;
  /** Frame of the last sample above SILENCE_LEVEL. */
  lastSignal: number;
  clicks: number[];
  lastClip: number;
  lastCrackle: number;
  clipCount: number;
  clickCount: number;
}

/** Wall-clock check for audio the device never delivered. */
class DropoutDetector {
  private t0 = -1;
  private got = 0;
  private windowStart = 0;
  private windowMin = Infinity;
  private baseline: number | null = null;
  constructor(
    private sampleRate: number,
    private threshold: number,
    private windowMs = 1000,
  ) {}

  /** Called after each buffer; returns frames lost since the last window, if any. */
  push(frames: number, nowMs: number): number {
    if (this.t0 < 0) {
      // the clock starts with the first buffer
      this.t0 = nowMs;
      this.windowStart = nowMs;
      return 0;
    }
    this.got += frames;
    const deficit = ((nowMs - this.t0) * this.sampleRate) / 1000 - this.got;
    if (deficit < this.windowMin) this.windowMin = deficit;
    if (nowMs - this.windowStart < this.windowMs) return 0;
    // The smallest deficit in a window ignores buffers that were merely late:
    // only audio that never arrived raises it for good.
    const floor = this.windowMin;
    this.windowStart = nowMs;
    this.windowMin = Infinity;
    if (this.baseline === null) {
      this.baseline = floor;
      return 0;
    }
    const lost = floor - this.baseline;
    this.baseline = floor;
    return lost > this.threshold ? Math.round(lost) : 0;
  }
}

const fmtTime = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

export function formatMinutes(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min`;
  return `${Math.max(0, Math.floor(seconds))} s`;
}

export class RecordingMonitor {
  private tracks: TrackState[];
  /** Frames analysed so far (take-relative). */
  private frame = 0;
  private dropouts: DropoutDetector;
  private lastDropout = -Infinity;
  private droppedTotal = 0;
  private lastBufferMs = -1;
  private stalledSince: number | null = null;
  private writer: WriterState = { queuedBytes: 0, error: null, droppedFrames: 0, freeBytes: null };
  private writerError: { text: string; since: number } | null = null;
  private loggedDropped = 0;
  readonly events: RecordingEvent[] = [];
  /** Bumps whenever events change, so callers can tell when to persist them. */
  revision = 0;

  constructor(private opts: MonitorOptions) {
    const sr = opts.sampleRate;
    this.tracks = opts.tracks.map((track) => ({
      track,
      chans: track.channels.map((channel) => ({ channel, x1: 0, x2: 0, env: 0, cand: null, clipRun: 0 })),
      everSignal: false,
      lastSignal: 0,
      clicks: [],
      lastClip: -Infinity,
      lastCrackle: -Infinity,
      clipCount: 0,
      clickCount: 0,
    }));
    // more than a buffer, and at least 10 ms, must go missing to count
    this.dropouts = new DropoutDetector(sr, Math.max(opts.bufferSize, sr * 0.01));
  }

  get framesAnalysed(): number {
    return this.frame;
  }

  /** Analyses one device buffer. `nowMs` is a monotonic clock (performance.now()). */
  input(interleaved: Float32Array, nch: number, nowMs: number): void {
    const frames = Math.floor(interleaved.length / nch);
    if (frames <= 0) return;
    const sr = this.opts.sampleRate;
    const start = this.frame;
    const lost = this.dropouts.push(frames, nowMs);
    if (lost > 0) {
      this.droppedTotal += lost;
      this.lastDropout = start;
      this.addEvent({
        frame: start,
        kind: 'dropout',
        text: `Dropout: about ${Math.max(1, Math.round((lost / sr) * 1000))} ms of audio lost (all tracks)`,
      });
    }
    this.lastBufferMs = nowMs;
    this.stalledSince = null;
    const alpha = 1 / (0.002 * sr);
    for (const t of this.tracks) {
      let peak = 0;
      for (const c of t.chans) {
        const ch = c.channel;
        if (ch >= nch) continue;
        let { x1, x2, env, cand, clipRun } = c;
        for (let i = 0; i < frames; i++) {
          const x = interleaved[i * nch + ch];
          const ax = x < 0 ? -x : x;
          if (ax > peak) peak = ax;
          // clipping: a run of samples at full scale
          if (ax >= CLIP_LEVEL) {
            if (++clipRun === CLIP_RUN) this.clip(t, start + i);
          } else clipRun = 0;
          // clicks: a second difference that jumps far above the signal before and after it
          const d = x - 2 * x1 + x2;
          const a = d < 0 ? -d : d;
          const n = start + i;
          let inCand = false;
          if (cand) {
            if (n - cand.pos <= 2) {
              if (a > cand.mag) cand.mag = a;
              inCand = true;
            } else {
              cand.postSum += a;
              if (++cand.postN >= CLICK_POST) {
                const post = cand.postSum / cand.postN;
                if (cand.mag > CLICK_RATIO * Math.max(cand.pre, post)) this.click(t, cand.pos);
                cand = null;
              }
            }
          } else if (a > CLICK_MIN && a > CLICK_RATIO * env && n > 2) {
            cand = { pos: n, mag: a, pre: env, postSum: 0, postN: 0 };
            inCand = true;
          }
          if (!inCand) env += (a - env) * alpha;
          x2 = x1;
          x1 = x;
        }
        c.x1 = x1;
        c.x2 = x2;
        c.env = env;
        c.cand = cand;
        c.clipRun = clipRun;
      }
      if (peak > SILENCE_LEVEL) {
        t.everSignal = true;
        t.lastSignal = start + frames;
      }
    }
    this.frame += frames;
  }

  private clip(t: TrackState, frame: number): void {
    t.clipCount++;
    t.lastClip = frame;
    this.addEvent({ frame, kind: 'clipping', trackId: t.track.trackId, text: `Clipping on ${t.track.name}` });
  }

  private click(t: TrackState, frame: number): void {
    t.clickCount++;
    const sr = this.opts.sampleRate;
    t.clicks.push(frame);
    while (t.clicks.length && t.clicks[0] < frame - CRACKLE_WINDOW * sr) t.clicks.shift();
    if (t.clicks.length >= CRACKLE_CLICKS) {
      t.lastCrackle = frame;
      this.addEvent({ frame: t.clicks[0], kind: 'crackle', trackId: t.track.trackId, text: `Crackle on ${t.track.name}` });
    }
  }

  /** Records a problem found elsewhere (e.g. the writer had to be restarted). */
  note(e: RecordingEvent): void {
    this.addEvent(e);
  }

  private addEvent(e: RecordingEvent): void {
    const sr = this.opts.sampleRate;
    const prev = [...this.events].reverse().find((x) => x.kind === e.kind && x.trackId === e.trackId);
    if (prev && e.frame - (prev.lastFrame ?? prev.frame) < MERGE_SECONDS * sr) {
      prev.lastFrame = Math.max(prev.lastFrame ?? prev.frame, e.frame);
      prev.count = (prev.count ?? 1) + 1;
      if (e.kind === 'dropout') prev.text = `Dropouts: audio lost ${prev.count} times (all tracks)`;
      this.revision++;
      return;
    }
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ ...e, count: 1 });
    this.revision++;
  }

  /** Call a few times per second, with or without input, to check the device and the disk. */
  tick(nowMs: number, writer: WriterState): void {
    this.writer = writer;
    if (this.lastBufferMs >= 0 && nowMs - this.lastBufferMs > STALL_SECONDS * 1000) {
      if (this.stalledSince === null) {
        this.stalledSince = this.lastBufferMs;
        this.addEvent({ frame: this.frame, kind: 'stall', text: 'The input device stopped sending audio' });
      }
    }
    if (writer.error && !this.writerError) {
      this.writerError = { text: writer.error, since: this.frame };
      this.addEvent({ frame: this.frame, kind: 'disk', text: `Writing failed: ${writer.error}` });
    } else if (!writer.error) this.writerError = null;
    if (writer.droppedFrames > this.loggedDropped) {
      this.loggedDropped = writer.droppedFrames;
      this.addEvent({ frame: this.frame, kind: 'disk', text: 'Audio lost: the disk stayed unwritable too long' });
    }
  }

  /** What to show now. */
  health(nowMs: number): RecordingHealth {
    const sr = this.opts.sampleRate;
    const now = this.frame;
    const recent = (f: number) => now - f < SHOW_SECONDS * sr;
    const warnings: RecordingWarning[] = [];
    const w = this.writer;
    const bps = this.opts.bytesPerSecond;
    const diskSecondsLeft = w.freeBytes !== null && bps > 0 ? w.freeBytes / bps : null;

    if (w.error) {
      const held = w.queuedBytes / Math.max(1, bps);
      warnings.push({
        key: 'disk-error',
        level: 'critical',
        text: `${w.error}. ${held >= 1 ? `${formatMinutes(held)} of audio is held in memory; ` : ''}free space or fix the disk and it is written automatically.`,
      });
    } else if (bps > 0 && w.queuedBytes / bps > SLOW_DISK_SECONDS) {
      warnings.push({ key: 'disk-slow', level: 'warning', text: `The disk can't keep up: ${formatMinutes(w.queuedBytes / bps)} of audio is waiting to be written.` });
    }
    if (w.droppedFrames > 0) {
      warnings.push({ key: 'disk-dropped', level: 'critical', text: `${formatMinutes(w.droppedFrames / sr)} of audio could not be kept because the disk was unwritable for too long.` });
    }
    if (diskSecondsLeft !== null && diskSecondsLeft < DISK_LOW_MIN * 60) {
      warnings.push({
        key: 'disk-space',
        level: diskSecondsLeft < DISK_CRITICAL_MIN * 60 ? 'critical' : 'warning',
        text: `Disk almost full: about ${formatMinutes(diskSecondsLeft)} of recording left.`,
      });
    }
    if (this.stalledSince !== null) {
      warnings.push({
        key: 'stall',
        level: 'critical',
        text: `No audio from the input for ${formatMinutes((nowMs - this.stalledSince) / 1000)}. Is the device still connected?`,
      });
    }
    if (recent(this.lastDropout)) {
      warnings.push({
        key: 'dropout',
        level: 'warning',
        text: `Audio dropped out at ${fmtTime(this.lastDropout / sr)} (${Math.round((this.droppedTotal / sr) * 1000)} ms lost so far). A larger buffer size in Setup can help.`,
      });
    }
    for (const t of this.tracks) {
      const name = t.track.name;
      const inputs = t.track.channels.map((c) => c + 1).join('+');
      if (!t.everSignal && now > NO_SIGNAL_START * sr) {
        warnings.push({ key: `silent-${t.track.trackId}`, level: 'warning', trackId: t.track.trackId, text: `${name}: no signal on input ${inputs} since the recording started. Muted, or the wrong input?` });
      } else if (t.everSignal && now - t.lastSignal > NO_SIGNAL_LATER * sr) {
        warnings.push({ key: `silent-${t.track.trackId}`, level: 'warning', trackId: t.track.trackId, text: `${name}: input ${inputs} has been silent for ${formatMinutes((now - t.lastSignal) / sr)}.` });
      }
      if (recent(t.lastCrackle)) {
        warnings.push({ key: `crackle-${t.track.trackId}`, level: 'warning', trackId: t.track.trackId, text: `${name}: crackling (${t.clickCount} clicks so far). Check the cable, or try a larger buffer size.` });
      }
      if (recent(t.lastClip)) {
        warnings.push({ key: `clip-${t.track.trackId}`, level: 'warning', trackId: t.track.trackId, text: `${name} is clipping. Turn the input gain down.` });
      }
    }
    return { warnings, diskSecondsLeft, problems: this.events.length };
  }
}
