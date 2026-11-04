// A small modal that asks for an episode name (New Episode, Save As).
import { h } from './dom';

export interface NameDialogOptions {
  title: string;
  /** Pre-filled and selected, so typing replaces it. */
  value: string;
  ok: string;
  /** A line under the field, e.g. where the folder goes. */
  hint?: string;
}

/** Resolves to the trimmed name, or null if the dialog was cancelled. */
export function askName(opts: NameDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' });
    const input = h('input', { type: 'text', class: 'episode-name', value: opts.value, spellcheck: false }) as HTMLInputElement;
    const okBtn = h('button', { class: 'primary', onclick: () => finish(input.value.trim() || null) }, opts.ok) as HTMLButtonElement;
    const sync = () => {
      okBtn.disabled = !input.value.trim();
    };
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      overlay.remove();
      resolve(v);
    };
    input.addEventListener('input', sync);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        finish(input.value.trim());
      }
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.append(
      h(
        'div',
        { class: 'dialog narrow name-dialog' },
        h('h2', null, opts.title),
        h('label', { class: 'field' }, h('span', null, 'Name'), input),
        opts.hint ? h('p', { class: 'muted field-help' }, opts.hint) : null,
        h('div', { class: 'row end' }, h('button', { onclick: () => finish(null) }, 'Cancel'), okBtn),
      ),
    );
    document.body.append(overlay);
    sync();
    input.focus();
    input.select();
  });
}
