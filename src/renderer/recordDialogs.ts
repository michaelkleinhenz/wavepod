// Dialogs around recording: the soundcheck before it starts and the confirmation before it stops.
import type { SoundcheckIssue } from '../core/soundcheck';
import { h } from './dom';

interface Choice<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

/** A small modal with buttons. Enter picks the primary choice, Escape the `cancel` value. */
function modal<T>(content: HTMLElement[], choices: Choice<T>[], cancel: T): Promise<T> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' });
    const done = (v: T) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(cancel);
      } else if (e.key === 'Enter') {
        const primary = choices.find((c) => c.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          done(primary.value);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.append(
      h(
        'div',
        { class: 'dialog narrow' },
        ...content,
        h(
          'div',
          { class: 'row end' },
          ...choices.map((c) =>
            h('button', { class: c.primary ? (c.danger ? 'primary danger' : 'primary') : '', onclick: () => done(c.value) }, c.label),
          ),
        ),
      ),
    );
    document.body.append(overlay);
    (overlay.querySelector('button.primary') as HTMLButtonElement | null)?.focus();
  });
}

/**
 * Shows the soundcheck result. Resolves to 'record' (with the checks to ignore from now on for this
 * episode) or 'cancel'. With errors only "Cancel" is offered.
 */
export async function showSoundcheck(issues: SoundcheckIssue[]): Promise<{ action: 'record' | 'cancel'; ignore: string[] }> {
  const errors = issues.some((i) => i.level === 'error');
  const remember = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const content: Array<HTMLElement | null> = [
    h('h2', null, errors ? 'Can’t record yet' : 'Soundcheck'),
    h(
      'ul',
      { class: 'soundcheck' },
      ...issues.map((i) => h('li', { class: i.level === 'error' ? 'error' : 'warning' }, i.message)),
    ),
    errors ? null : h('label', { class: 'check' }, remember, 'Don’t warn about these again for this episode'),
  ];
  const action = await modal<'record' | 'cancel'>(
    content.filter((x): x is HTMLElement => !!x),
    errors
      ? [{ label: 'OK', value: 'cancel', primary: true }]
      : [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Record anyway', value: 'record', primary: true, danger: true },
        ],
    'cancel',
  );
  return { action, ignore: action === 'record' && remember.checked ? issues.map((i) => i.id) : [] };
}

/** Recording safe mode: asks before a recording is stopped. */
export function confirmStop(): Promise<boolean> {
  return modal(
    [
      h('h2', null, 'Stop recording?'),
      h('p', { class: 'muted' }, 'You can switch this question off under Edit › Confirm Before Stopping a Recording.'),
    ],
    [
      { label: 'Keep recording', value: false },
      { label: 'Stop recording', value: true, primary: true, danger: true },
    ],
    false,
  );
}
