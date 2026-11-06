// The emergency modal for a recording in trouble (the input device stopped delivering audio, the
// take can't be written): a red dialog that names the problem and an alarm that sounds until it is
// acknowledged or the problem goes away. It plays through the system's default output with Web
// Audio, so it is heard even when the recording interface is the device that just dropped out.
import type { RecordingAlert } from '../shared/types';
import { h } from './dom';
import { api } from './store';

/** Seconds between alarm bursts. */
const ALARM_EVERY = 2.5;
/** The alarm gives up after this long if nobody reacts (the modal stays). */
const ALARM_MAX_SECONDS = 10 * 60;

class Alarm {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private started = 0;

  start(): void {
    if (this.timer !== null) return;
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    } catch {
      return; // no audio output at all: the modal and the notification still show
    }
    this.started = performance.now();
    this.burst();
    this.timer = window.setInterval(() => {
      if (performance.now() - this.started > ALARM_MAX_SECONDS * 1000) this.stop();
      else this.burst();
    }, ALARM_EVERY * 1000);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** Three falling two-tone beeps: loud enough to hear across the room, not a fire alarm. */
  private burst(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    for (let i = 0; i < 3; i++) {
      for (const [k, freq] of [[0, 1320], [1, 990]] as const) {
        const t = t0 + i * 0.36 + k * 0.15;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
        gain.gain.setValueAtTime(0.18, t + 0.12);
        gain.gain.linearRampToValueAtTime(0, t + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
      }
    }
  }
}

export class RecordingAlertModal {
  private overlay = h('div', { class: 'overlay emergency-overlay', role: 'alertdialog', 'aria-modal': 'true' });
  private alarm = new Alarm();
  private alert: RecordingAlert | null = null;
  private onKey = (e: KeyboardEvent) => {
    // The modal takes Enter and Escape, so they never reach the transport (or close another dialog).
    if (e.key !== 'Escape' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    this.dismiss();
  };

  constructor() {
    api().onRecordingAlert((a) => this.show(a));
  }

  private show(a: RecordingAlert): void {
    // details of an alert already dismissed are not worth bringing it back for
    if (a.state === 'update' && !this.overlay.isConnected) return;
    if ((a.state === 'resolved' || a.state === 'ended') && !this.overlay.isConnected) return;
    this.alert = a;
    if (a.state === 'raised') this.alarm.start();
    else if (a.state !== 'update') this.alarm.stop();
    this.render();
    if (!this.overlay.isConnected) {
      document.body.append(this.overlay);
      window.addEventListener('keydown', this.onKey, true);
    }
    this.overlay.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private dismiss(): void {
    this.alarm.stop();
    this.overlay.remove();
    window.removeEventListener('keydown', this.onKey, true);
    this.alert = null;
  }

  private render(): void {
    const a = this.alert!;
    const ok = a.state === 'resolved' || a.state === 'ended';
    this.overlay.replaceChildren(
      h(
        'div',
        { class: `dialog narrow emergency${ok ? ' ok' : ''}` },
        h('div', { class: 'emergency-icon', 'aria-hidden': 'true' }, ok ? '✓' : '⛔'),
        h('h2', null, a.title),
        ...a.problems.map((p) => h('p', null, p)),
        a.test
          ? h('p', { class: 'muted' }, 'You also get a system notification, the taskbar entry flashes and the window title says “RECORDING PROBLEM” while WavePod is in the background.')
          : !ok
            ? h('p', { class: 'muted' }, 'Check it now. WavePod keeps the recording running and marks this spot with an edit marker.')
            : null,
        h(
          'div',
          { class: 'row end' },
          h('button', { class: ok ? 'primary' : 'primary danger', onclick: () => this.dismiss() }, ok ? 'OK' : a.test ? 'Stop the test' : 'Got it, silence the alarm'),
        ),
      ),
    );
  }
}
