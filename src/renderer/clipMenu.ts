// The clip right-click menu: the common clip edits in one place. It acts on the whole selection
// when the clicked clip is part of it, otherwise on the clicked clip alone (which it selects).
import { copyClips } from '../core/clipboard';
import {
  addClipFades,
  canSplitAt,
  clipMenuTargets,
  clipsOnSameTrack,
  colorClips,
  duplicateClips,
  removeClipFades,
  resetClipEnvelopes,
  setClipGain,
  showClipEnvelopes,
  splitClipsAt,
  targetClips,
} from '../core/clipOps';
import { deleteClips, findClip } from '../core/project';
import { selectionSpan } from '../core/navigation';
import { parseNumberInput } from '../core/numberInput';
import { alignSelectedClip, pasteClipboard, regionFromSelection } from './actions';
import { CLIP_COLORS, showClipLabel } from './clipLabel';
import { closeContextMenu, showContextMenu, type ContextMenuEntry } from './contextMenu';
import { h, toast } from './dom';
import { loudnessTarget, normalizeClips } from './loudnessDialog';
import { store } from './store';

export interface ClipMenuOptions {
  clipId: string;
  /** Timeline frame under the mouse (where "Split here" cuts). */
  at: number;
  pageX: number;
  pageY: number;
  zoomTo: (span: [number, number]) => void;
  /** Opens the loudness analysis (of the selection, which the menu has set to its clips). */
  openLoudness: () => void;
}

const FADE_SECONDS = 0.25;

export function openClipMenu(o: ClipMenuOptions): void {
  const ids = clipMenuTargets(store.selection.clipIds, o.clipId);
  store.select({ clipIds: ids, range: null, rangeTracks: null, markerId: null, muteRegion: null });
  const clips = targetClips(store.project, ids);
  if (!clips.length) return;
  const n = clips.length;
  const one = n === 1;
  const noun = one ? 'clip' : `${n} clips`;
  const pos = store.transport.position;
  const recording = store.transport.state === 'recording';
  const select = (clipIds: Iterable<string>) => store.select({ clipIds: new Set(clipIds), range: null, rangeTracks: null, markerId: null });
  const edit = (fn: Parameters<typeof store.edit>[0]) => store.edit(fn);
  /** An edit that also makes new clips (split halves, copies) the selection. */
  const editSelecting = (r: { project: typeof store.project; clipIds: string[] }) => {
    store.edit(() => r.project);
    select(r.clipIds);
  };
  const split = (at: number) => editSelecting(splitClipsAt(store.project, ids, at));
  const showing = clips.every((c) => c.showEnvelope);
  const gains = new Set(clips.map((c) => c.gain));
  const gainText = gains.size === 1 ? `${clips[0].gain > 0 ? '+' : ''}${clips[0].gain.toFixed(1)} dB` : 'mixed';
  const target = loudnessTarget();

  const entries: ContextMenuEntry[] = [
    { kind: 'header', label: one ? clipName(clips[0].file) : `${n} clips selected` },
    { label: 'Split here', enabled: !recording && canSplitAt(store.project, ids, o.at), title: 'Split at the mouse position', run: () => split(o.at) },
    { label: 'Split at playhead', accel: 'S', enabled: !recording && canSplitAt(store.project, ids, pos), run: () => split(pos) },
    { kind: 'separator' },
    {
      label: 'Cut',
      enabled: !recording,
      title: 'Copy and remove, leaving the gap',
      run: () => {
        store.clipboard = copyClips(store.project, ids);
        edit((p) => deleteClips(p, [...ids]));
        select([]);
        toast(`Cut ${noun} (Ctrl+V pastes at the playhead)`);
      },
    },
    {
      label: 'Copy',
      accel: 'Ctrl+C',
      run: () => {
        store.clipboard = copyClips(store.project, ids);
        toast(`Copied ${noun}`);
      },
    },
    { label: 'Paste at playhead', accel: 'Ctrl+V', enabled: !!store.clipboard && !recording, run: () => pasteClipboard(false) },
    {
      label: 'Duplicate',
      enabled: !recording,
      title: 'Place a copy right after',
      run: () => editSelecting(duplicateClips(store.project, ids)),
    },
    {
      label: 'Delete',
      accel: 'Del',
      enabled: !recording,
      run: () => {
        edit((p) => deleteClips(p, [...ids]));
        select([]);
      },
    },
    { kind: 'separator' },
    { label: 'Add fades', accel: 'F', run: () => edit((p) => addClipFades(p, ids, Math.round(store.sampleRate * FADE_SECONDS))) },
    { label: 'Remove fades', enabled: clips.some((c) => c.fadeIn || c.fadeOut), run: () => edit((p) => removeClipFades(p, ids)) },
    { label: 'Show volume line', checked: showing, run: () => edit((p) => showClipEnvelopes(p, ids, !showing)) },
    { label: 'Reset volume line', enabled: clips.some((c) => c.envelope?.length), title: 'Remove every volume point', run: () => edit((p) => resetClipEnvelopes(p, ids)) },
    { label: `Clip gain… (${gainText})`, run: () => promptGain(ids, clips[0].gain, o.pageX, o.pageY) },
    { label: 'Reset clip gain', enabled: clips.some((c) => c.gain), run: () => edit((p) => setClipGain(p, ids, 0)) },
    { label: `Normalise to ${String(target.lufs).replace('-', '−')} LUFS`, accel: 'Alt+Shift+N', run: () => void normalizeClips([...ids]) },
    { label: 'Loudness analysis…', accel: 'Shift+Ctrl+L', run: o.openLoudness },
    { kind: 'separator' },
    { kind: 'custom', el: swatches(ids, clips) },
    {
      label: one && clips[0].note ? 'Edit note…' : 'Note…',
      enabled: one,
      title: one ? undefined : 'Notes are per clip: right-click a single clip',
      run: () => {
        const c = findClip(store.project, clips[0].id)?.clip;
        if (c) showClipLabel(c, o.pageX, o.pageY);
      },
    },
    { kind: 'separator' },
    { label: 'Select all on this track', run: () => select(clipsOnSameTrack(store.project, o.clipId)) },
    {
      label: one ? 'Zoom to clip' : 'Zoom to clips',
      run: () => {
        const span = selectionSpan(store.project, null, ids);
        if (span) o.zoomTo(span);
      },
    },
    { label: one ? 'Region from clip' : 'Region from clips', run: regionFromSelection },
    { label: 'Align to track…', enabled: one, title: one ? 'Double-ender: line this clip up with another track' : 'Align works on one clip', run: () => void alignSelectedClip() },
  ];
  showContextMenu(entries, o.pageX, o.pageY);
}

function clipName(file: string): string {
  return file.split('/').pop() ?? file;
}

function swatches(ids: Set<string>, clips: Array<{ color?: string }>): HTMLElement {
  const same = new Set(clips.map((c) => c.color ?? '')).size === 1 ? clips[0].color : null;
  const swatch = (color: string | undefined) =>
    h('button', {
      class: `swatch${same !== null && same === color ? ' active' : ''}${color ? '' : ' none'}`,
      type: 'button',
      title: color ? 'Colour' : 'No colour',
      style: color ? { background: color } : {},
      onclick: () => {
        store.edit((p) => colorClips(p, ids, color));
        closeContextMenu();
      },
    });
  return h('div', { class: 'swatches context-menu-swatches' }, swatch(undefined), ...CLIP_COLORS.map((c) => swatch(c)));
}

/** A small field to type the clip gain of the clips in (Enter applies, Esc cancels). */
function promptGain(ids: Set<string>, current: number, x: number, y: number): void {
  document.querySelector('.gain-prompt')?.remove();
  const input = h('input', { value: String(current) }) as HTMLInputElement;
  let done = false;
  const close = (apply: boolean) => {
    if (done) return;
    done = true;
    box.remove();
    if (!apply) return;
    const v = parseNumberInput(input.value, { min: -60, max: 24, unit: 'dB', precision: 0.1 });
    if (v === null) return toast('Type a gain in dB, e.g. -3 or +2.5');
    store.edit((p) => setClipGain(p, ids, v));
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') close(true);
    else if (e.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  const box = h(
    'div',
    { class: 'title-prompt gain-prompt', style: { left: `${Math.min(x, window.innerWidth - 300)}px`, top: `${Math.min(y, window.innerHeight - 60)}px`, transform: 'none' } },
    h('span', { class: 'muted' }, 'Clip gain'),
    input,
    h('span', { class: 'muted' }, 'dB'),
  );
  document.body.append(box);
  input.focus();
  input.select();
}
