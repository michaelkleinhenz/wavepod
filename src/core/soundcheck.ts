// Soundcheck before recording, after Ultraschall's: warnings a podcaster wants to see before pressing record.
import type { Project } from '../shared/types';
import { projectLength } from './project';

export type SoundcheckId =
  | 'no-input'
  | 'no-armed'
  | 'sample-rate'
  | 'shared-input'
  | 'builtin-mic'
  | 'disk-space'
  | 'mid-project';

export interface SoundcheckIssue {
  id: SoundcheckId;
  /** 'error': recording cannot start. 'warn': it can, but probably shouldn't. */
  level: 'error' | 'warn';
  message: string;
}

export interface SoundcheckContext {
  project: Project;
  /** Sample rate the device runs at. */
  deviceSampleRate: number;
  inputOpen: boolean;
  inputDeviceName?: string;
  /** Free bytes on the disk of the project folder, if known. */
  freeBytes?: number | null;
  /** Where recording would start. */
  position: number;
  /** Checks the user chose to skip for this project. */
  ignored?: string[];
}

/** Recording time that should fit on the disk before we warn. */
export const MIN_RECORDING_MINUTES = 120;
const BUILTIN_MIC = /built-?in|internal|macbook|integrated|webcam|camera/i;

/** Bytes per minute when recording the armed tracks (WAV, project bit depth). */
export function recordingBytesPerMinute(project: Project, sampleRate: number): number {
  const channels = project.tracks.filter((t) => t.armed).reduce((n, t) => n + t.inputChannels.length, 0);
  return channels * sampleRate * (project.bitDepth / 8) * 60;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function runSoundcheck(ctx: SoundcheckContext): SoundcheckIssue[] {
  const { project } = ctx;
  const out: SoundcheckIssue[] = [];
  const armed = project.tracks.filter((t) => t.armed && t.inputChannels.length > 0);

  if (!ctx.inputOpen) out.push({ id: 'no-input', level: 'error', message: 'No input device is open. Pick your interface on the Audio tab in Setup.' });
  if (!armed.length) out.push({ id: 'no-armed', level: 'error', message: 'No track is armed. Arm the tracks you want to record (the R button on each track).' });

  if (ctx.deviceSampleRate !== 48000) {
    out.push({
      id: 'sample-rate',
      level: 'warn',
      message: `The interface runs at ${ctx.deviceSampleRate / 1000} kHz. Podcasts are usually recorded at 48 kHz.`,
    });
  }

  const byChannel = new Map<number, string[]>();
  for (const t of armed) for (const c of t.inputChannels) byChannel.set(c, [...(byChannel.get(c) ?? []), t.name]);
  for (const [c, names] of byChannel) {
    if (names.length > 1) {
      out.push({ id: 'shared-input', level: 'warn', message: `${names.join(' and ')} record the same input (${c + 1}), so you get the same audio twice.` });
    }
  }

  if (ctx.inputOpen && ctx.inputDeviceName && BUILTIN_MIC.test(ctx.inputDeviceName)) {
    out.push({ id: 'builtin-mic', level: 'warn', message: `The input is "${ctx.inputDeviceName}", which looks like a built-in microphone, not your interface.` });
  }

  const perMinute = recordingBytesPerMinute(project, ctx.deviceSampleRate);
  if (ctx.freeBytes != null && perMinute > 0 && ctx.freeBytes < perMinute * MIN_RECORDING_MINUTES) {
    const minutes = Math.floor(ctx.freeBytes / perMinute);
    out.push({ id: 'disk-space', level: 'warn', message: `The disk has room for about ${minutes} minutes of recording on ${armed.length} track${armed.length === 1 ? '' : 's'}.` });
  }

  const length = projectLength(project);
  const sr = project.sampleRate;
  // half a second of slack: starting right at the end is fine
  if (length > 0 && ctx.position < length - sr / 2) {
    out.push({
      id: 'mid-project',
      level: 'warn',
      message: `You are about to record at ${clock(ctx.position / sr)}, before the end of the episode (${clock(length / sr)}). The new take goes over the existing audio.`,
    });
  }

  const ignored = new Set(ctx.ignored ?? []);
  return out.filter((i) => i.level === 'error' || !ignored.has(i.id));
}
