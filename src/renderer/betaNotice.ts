// The beta warning: shown once on the first start, and again any time from Help › Beta Notice.
import { h } from './dom';

export const BETA_NOTICE_KEY = 'wavepod.betaNoticeAccepted';

/** Storage that may be missing or refuse access (tests, a broken profile). */
type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True until the user has confirmed the notice once. */
export function betaNoticeDue(store: KeyValue | null = storage()): boolean {
  try {
    return store?.getItem(BETA_NOTICE_KEY) == null;
  } catch {
    return true;
  }
}

export function acceptBetaNotice(store: KeyValue | null = storage()): void {
  try {
    store?.setItem(BETA_NOTICE_KEY, new Date().toISOString());
  } catch {
    // not remembered: the notice simply shows again next start
  }
}

/** Shows the notice on the first start only. */
export function showBetaNoticeOnFirstStart(): Promise<void> {
  return betaNoticeDue() ? showBetaNotice(true) : Promise.resolve();
}

/**
 * The beta notice. On the first start it can only be closed with the button, so it is read;
 * from the Help menu Escape and a click outside close it too.
 */
export function showBetaNotice(firstStart = false): Promise<void> {
  if (document.querySelector('.overlay.beta-notice')) return Promise.resolve();
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay beta-notice' });
    const close = () => {
      window.removeEventListener('keydown', onKey, true);
      acceptBetaNotice();
      overlay.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      // keep keys away from the transport (Space, R) while the notice is open
      e.stopPropagation();
      if (e.key === 'Enter' || (!firstStart && e.key === 'Escape')) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    if (!firstStart) overlay.addEventListener('mousedown', (e) => e.target === overlay && close());

    const okBtn = h('button', { class: 'primary', onclick: close }, firstStart ? 'I understand' : 'Close') as HTMLButtonElement;
    overlay.append(
      h(
        'div',
        { class: 'dialog beta-dialog', role: 'alertdialog', 'aria-label': 'WavePod is beta software' },
        h('div', { class: 'beta-icon' }, '⚠'),
        h('h2', null, 'WavePod is beta software'),
        h('p', null, 'WavePod is still being tested. It can have bugs, and some of them may only show up in the middle of a recording.'),
        h(
          'p',
          { class: 'beta-backup' },
          h('strong', null, 'Always make a backup recording. '),
          'Record the show a second time with something else, for example directly on your hardware mixer or audio interface (many can record to an SD card or USB stick), or with a second recorder.',
        ),
        h(
          'p',
          null,
          'We went to great lengths to keep your recordings safe: every take is written to disk as it happens and recovered after a crash, dropouts, crackle and a full disk are detected live, and a lost input device raises a loud alarm and a system notification. But because WavePod is beta software, anything can still happen.',
        ),
        h('p', { class: 'beta-later' }, 'You can read this again any time under Help › Beta Notice.'),
        h('div', { class: 'row end' }, okBtn),
      ),
    );
    document.body.append(overlay);
    okBtn.focus();
  });
}
