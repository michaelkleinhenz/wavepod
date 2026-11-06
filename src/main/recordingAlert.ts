// Gets a recording emergency to the user wherever they are: the window shows a modal with an alarm
// sound (renderer), the system shows a notification, the taskbar / dock entry flashes or bounces,
// and the window title says so. Focus is never stolen: a key typed into another app must not land
// in WavePod in the middle of a take.
import { app, Notification, type BrowserWindow } from 'electron';
import { RecordingAlarm, testAlert } from '../core/recordingAlarm';
import type { RecordingAlert, TransportUpdate } from '../shared/types';

const TITLE_MARK = '⚠ RECORDING PROBLEM — ';

export class RecordingAlerter {
  private alarm = new RecordingAlarm();
  private bounceId: number | null = null;
  private watched: BrowserWindow | null = null;
  /** Keeps shown notifications from being garbage-collected (which would drop their click handler). */
  private notifications = new Set<Notification>();
  private testTimer: NodeJS.Timeout | null = null;

  constructor(
    private window: () => BrowserWindow | null,
    private send: (alert: RecordingAlert) => void,
  ) {}

  /** Feed every transport update. */
  transport(u: TransportUpdate): void {
    const change = this.alarm.update(u.state === 'recording', u.health?.warnings ?? [], Date.now());
    if (change) this.deliver(change.alert, change.notify);
  }

  /** Fires the test alert after a delay, so the window can be put in the background first. */
  test(delaySeconds: number): void {
    if (this.testTimer) clearTimeout(this.testTimer);
    this.testTimer = setTimeout(() => {
      this.testTimer = null;
      this.deliver(testAlert(), true);
    }, Math.max(0, Math.min(60, delaySeconds)) * 1000);
  }

  private deliver(alert: RecordingAlert, notify: boolean): void {
    this.send(alert);
    const win = this.window();
    if (alert.state === 'raised') {
      if (notify) this.notify(alert.title, alert.problems.join('\n'), true);
      this.attention(win, true);
    } else if (alert.state === 'resolved') {
      this.notify(alert.title, alert.problems.join('\n'), false);
      this.markTitle(win, false);
    } else if (alert.state === 'ended') {
      this.markTitle(win, false);
    }
  }

  private notify(title: string, body: string, critical: boolean): void {
    if (!Notification.isSupported()) return;
    try {
      const n = new Notification({
        title: `WavePod: ${title}`,
        body,
        urgency: critical ? 'critical' : 'normal',
        silent: !critical,
        timeoutType: critical ? 'never' : 'default',
      });
      this.notifications.add(n);
      const forget = () => this.notifications.delete(n);
      n.on('click', () => {
        forget();
        const win = this.window();
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.on('close', forget);
      n.on('failed', forget);
      n.show();
      // don't hold on to notifications the system dropped without telling
      setTimeout(forget, 10 * 60_000).unref?.();
    } catch (e) {
      console.error('[recording] notification failed', e);
    }
  }

  /** Flashes the taskbar entry (bounces the dock icon on macOS) until the window gets focus. */
  private attention(win: BrowserWindow | null, on: boolean): void {
    this.markTitle(win, on);
    if (!win || win.isDestroyed()) return;
    if (on && win.isFocused()) return;
    this.watchFocus(win);
    win.flashFrame(on);
    if (process.platform === 'darwin' && app.dock) {
      if (this.bounceId !== null) app.dock.cancelBounce(this.bounceId);
      this.bounceId = on ? app.dock.bounce('critical') : null;
    }
  }

  private watchFocus(win: BrowserWindow): void {
    if (this.watched === win) return;
    this.watched = win;
    win.on('focus', () => {
      win.flashFrame(false);
      // a test (or a problem already over) leaves no mark once the user is back
      if (!this.alarm.raised) this.markTitle(win, false);
      if (this.bounceId !== null && app.dock) app.dock.cancelBounce(this.bounceId);
      this.bounceId = null;
    });
  }

  /** The title shows the problem in the taskbar and window switcher while it lasts. */
  private markTitle(win: BrowserWindow | null, on: boolean): void {
    if (!win || win.isDestroyed()) return;
    const title = win.getTitle().replace(TITLE_MARK, '');
    win.setTitle(on ? TITLE_MARK + title : title);
  }

  dispose(): void {
    if (this.testTimer) clearTimeout(this.testTimer);
  }
}

/** The window title without the problem mark, for code that sets the title itself. */
export function withAlertMark(win: BrowserWindow, title: string): string {
  return win.getTitle().startsWith(TITLE_MARK) ? TITLE_MARK + title : title;
}
