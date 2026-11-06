// Decides when a problem during a recording is an emergency that must reach the user even when
// WavePod is in the background: the input device stopped delivering audio (unplugged, reset, the
// sound server lost it) or the take can't be written. Everything else the monitor finds (dropouts,
// crackle, clipping) stays in the warning bar, and a silent input is never an emergency.
import type { RecordingAlert, RecordingWarning } from '../shared/types';

/** Problems that belong together: a stalled input and a lost device are one emergency. */
export type AlarmGroup = 'input' | 'disk';

/** The emergency group of a live warning, or null if it is not one. */
export function alarmGroup(w: RecordingWarning): AlarmGroup | null {
  if (w.level !== 'critical') return null;
  if (w.key === 'stall' || w.key === 'input-lost') return 'input';
  if (w.key.startsWith('disk')) return 'disk';
  return null;
}

/** A group that comes back this soon after the last system notification for it updates the alert without a new notification. */
export const NOTIFY_COOLDOWN_MS = 30_000;

export const ALERT_TITLE: Record<AlarmGroup, string> = {
  input: 'No audio from the input device',
  disk: 'The recording can’t be written',
};

/** What happened, for the main process to pass on (window, notification, taskbar). */
export interface AlarmChange {
  alert: RecordingAlert;
  /** True when a system notification should go out (a new emergency, not a repeat within the cooldown). */
  notify: boolean;
}

/** Turns the stream of live warnings into raised / updated / resolved alerts. */
export class RecordingAlarm {
  private active: AlarmGroup[] = [];
  private shown = '';
  private notified = new Map<AlarmGroup, number>();

  /** Call with every transport update. Returns a change to pass on, or null. */
  update(recording: boolean, warnings: RecordingWarning[], nowMs: number): AlarmChange | null {
    if (!recording) {
      if (!this.active.length) return null;
      // stopped by the user (or the app is closing): stop the noise, the problems stay on screen
      this.active = [];
      this.shown = '';
      return { alert: { state: 'ended', title: 'Recording stopped', problems: [] }, notify: false };
    }
    const emergencies = warnings.filter((w) => alarmGroup(w));
    const groups = [...new Set(emergencies.map((w) => alarmGroup(w)!))];
    const problems = emergencies.map((w) => w.text);
    if (!groups.length) {
      if (!this.active.length) return null;
      const was = this.active;
      this.active = [];
      this.shown = '';
      return {
        alert: {
          state: 'resolved',
          title: was.includes('input') ? 'The input is back' : 'Recording is fine again',
          problems: [was.includes('input') ? 'Audio is arriving again and the recording goes on. The time without audio is silent in the take and has an edit marker.' : 'The audio is being written again.'],
        },
        notify: false,
      };
    }
    const added = groups.filter((g) => !this.active.includes(g));
    const title = ALERT_TITLE[groups[0]];
    const text = `${title}\n${problems.join('\n')}`;
    this.active = groups;
    if (!added.length) {
      if (text === this.shown) return null;
      this.shown = text;
      return { alert: { state: 'update', title, problems }, notify: false };
    }
    this.shown = text;
    const notify = added.some((g) => nowMs - (this.notified.get(g) ?? -Infinity) >= NOTIFY_COOLDOWN_MS);
    if (notify) for (const g of added) this.notified.set(g, nowMs);
    return { alert: { state: 'raised', title, problems }, notify };
  }

  get raised(): boolean {
    return this.active.length > 0;
  }
}

/** The alert the "Test emergency alert" button fires. */
export function testAlert(): RecordingAlert {
  return {
    state: 'raised',
    test: true,
    title: 'Test: no audio from the input device',
    problems: ['This is only a test. In a real emergency this names the problem, for example that the recording device was unplugged.'],
  };
}
