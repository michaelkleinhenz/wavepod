// Clip colour and note: a small popover opened by right-clicking a clip (storyboard-lite).
import type { Clip } from '../shared/types';
import { updateClip } from '../core/project';
import { h } from './dom';
import { store } from './store';

export const CLIP_COLORS = ['#e57373', '#ffb74d', '#fff176', '#81c784', '#4db6ac', '#4fc3f7', '#9575cd', '#f06292'];

let open: HTMLElement | null = null;

export function closeClipLabel(): void {
  open?.remove();
  open = null;
}

/** Opens the colour/note popover for `clip` at the given page position. */
export function showClipLabel(clip: Clip, pageX: number, pageY: number): void {
  closeClipLabel();
  let note = clip.note ?? '';
  const set = (patch: Partial<Clip>) => store.edit((p) => updateClip(p, clip.id, patch));
  const swatch = (color: string | undefined) =>
    h('button', {
      class: `swatch${(clip.color ?? undefined) === color ? ' active' : ''}${color ? '' : ' none'}`,
      type: 'button',
      title: color ? 'Colour the clip' : 'No colour',
      style: color ? { background: color } : {},
      onclick: () => {
        set({ color });
        closeClipLabel();
      },
    });
  const input = h('textarea', { rows: 3, placeholder: 'Note: what happens here, what to fix…', value: note }) as HTMLTextAreaElement;
  input.value = note;
  const commit = () => {
    const v = input.value.trim();
    if (v !== (clip.note ?? '')) set({ note: v || undefined });
  };
  input.addEventListener('input', () => (note = input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
      closeClipLabel();
    } else if (e.key === 'Escape') closeClipLabel();
  });
  const pop = h(
    'div',
    { class: 'clip-label' },
    h('div', { class: 'swatches' }, swatch(undefined), ...CLIP_COLORS.map((c) => swatch(c))),
    input,
    h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Enter saves the note · Shift+Enter new line'),
  );
  pop.style.left = `${Math.min(pageX, window.innerWidth - 300)}px`;
  pop.style.top = `${Math.min(pageY, window.innerHeight - 170)}px`;
  document.body.append(pop);
  open = pop;
  input.focus();
  const away = (e: MouseEvent) => {
    if (pop.contains(e.target as Node)) return;
    window.removeEventListener('mousedown', away, true);
    if (open === pop) {
      commit();
      closeClipLabel();
    }
  };
  window.addEventListener('mousedown', away, true);
}
