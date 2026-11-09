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
  loopClips,
  loopClipsOver,
  loopClipsToNext,
  MAX_CLIP_NAME,
  resetClipsSound,
  reverseClips,
  setClipsRate,
  removeClipFades,
  renameClips,
  resetClipEnvelopes,
  setClipGain,
  showClipEnvelopes,
  splitClipsAt,
  targetClips,
} from '../core/clipOps';
import { deleteClips, findClip, updateTrack } from '../core/project';
import { selectionSpan } from '../core/navigation';
import { parseNumberInput } from '../core/numberInput';
import { clipRate, MAX_RATE, MIN_RATE, parseRateInput, rateToSemitones } from '../core/clipSound';
import { alignSelectedClips, pasteClipboard, regionFromSelection } from './actions';
import { CLIP_COLORS, showClipLabel } from './clipLabel';
import { closeContextMenu, showContextMenu, type ContextMenuEntry } from './contextMenu';
import { h, toast } from './dom';
import { loudnessTarget, normalizeClips } from './loudnessDialog';
import { store } from './store';
import { activeTakeAt, pickTake, takesAt } from '../core/takes';

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
  // a time range selected before the right-click is what "Loop over selection" fills
  const range = store.selection.range && store.selection.range[1] - store.selection.range[0] > 0 ? store.selection.range : null;
  const ids = clipMenuTargets(store.selection.clipIds, o.clipId);
  store.select({ clipIds: ids, range: null, rangeTracks: null, markerId: null, muteRegion: null });
  const clips = targetClips(store.project, ids);
  if (!clips.length) return;
  const n = clips.length;
  const one = n === 1;
  const oneTrack = new Set(store.project.tracks.filter((t) => t.clips.some((c) => ids.has(c.id))).map((t) => t.id)).size === 1;
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
  const reversed = clips.every((c) => c.sound?.reverse);
  const looping = clips.every((c) => c.sound?.loop);
  const rates = new Set(clips.map(clipRate));
  const rateText = rates.size === 1 ? formatRate(clipRate(clips[0])) : 'mixed';

  const entries: ContextMenuEntry[] = [
    { kind: 'header', label: one ? (clips[0].name ?? clipName(clips[0].file)) : `${n} clips selected` },
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
    ...takeEntries(o, one, recording),
    { kind: 'separator' },
    { kind: 'header', label: 'Sound design' },
    { label: 'Reverse', checked: reversed, enabled: !recording, title: 'Play backwards', run: () => edit((p) => reverseClips(p, ids, !reversed)) },
    {
      label: `Speed… (${rateText})`,
      enabled: !recording,
      title: 'Varispeed: faster is higher, slower is lower, like tape',
      run: () => promptRate(ids, clipRate(clips[0]), o.pageX, o.pageY),
    },
    { label: 'Loop', checked: looping, enabled: !recording, title: 'Repeat the clip: drag its right edge to make it longer', run: () => edit((p) => loopClips(p, ids, !looping)) },
    { label: 'Loop to next clip', enabled: !recording, title: 'Repeat until the next clip on the track (or the end of the episode)', run: () => edit((p) => loopClipsToNext(p, ids)) },
    {
      label: 'Loop over selection',
      enabled: !recording && !!range,
      title: range ? 'Move to the selected range and repeat to fill it' : 'Select a time range first, then right-click the clip',
      run: () => range && edit((p) => loopClipsOver(p, ids, range)),
    },
    { label: 'Play as recorded', enabled: !recording && clips.some((c) => c.sound), title: 'Undo reverse, speed and loop', run: () => edit((p) => resetClipsSound(p, ids)) },
    { kind: 'separator' },
    { kind: 'custom', el: swatches(ids, clips) },
    {
      label: one ? 'Rename…' : `Rename ${n} clips…`,
      enabled: !recording,
      title: 'The name shown on the clip (empty: the file name)',
      run: () => promptClipName(ids, o.pageX, o.pageY),
    },
    { label: 'Reset name', enabled: !recording && clips.some((c) => c.name), title: 'Show the file name again', run: () => edit((p) => renameClips(p, ids, '')) },
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
    {
      label: 'Align to track…',
      enabled: !recording && oneTrack,
      title: oneTrack ? 'Line these clips up with another track by their content (and correct clock drift)' : 'Align works on clips of one track',
      run: () => void alignSelectedClips([...ids]),
    },
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

/**
 * A small field over the clip to type its name (Enter applies, Esc cancels; empty goes back to
 * the file name). With several clips, all get the typed name.
 */
export function promptClipName(clipIds: string | Iterable<string>, x: number, y: number): void {
  document.querySelector('.gain-prompt')?.remove();
  const ids = new Set(typeof clipIds === 'string' ? [clipIds] : clipIds);
  const clips = targetClips(store.project, ids);
  if (!clips.length) return;
  const names = new Set(clips.map((c) => c.name ?? clipName(c.file)));
  const input = h('input', { class: 'clip-name-input', value: names.size === 1 ? [...names][0] : '', maxlength: MAX_CLIP_NAME, spellcheck: false, placeholder: clipName(clips[0].file) }) as HTMLInputElement;
  let done = false;
  const close = (apply: boolean) => {
    if (done) return;
    done = true;
    box.remove();
    if (!apply) return;
    const value = input.value.trim();
    // typing the file name back is the same as no name
    const name = clips.every((c) => value === clipName(c.file)) ? '' : value;
    if (clips.every((c) => (c.name ?? '') === name)) return;
    store.edit((p) => renameClips(p, ids, name));
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') close(true);
    else if (e.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  const box = h(
    'div',
    { class: 'title-prompt gain-prompt clip-name-prompt', style: { left: `${Math.max(0, Math.min(x, window.innerWidth - 420))}px`, top: `${Math.max(0, Math.min(y, window.innerHeight - 60))}px`, transform: 'none' } },
    h('span', { class: 'muted' }, clips.length === 1 ? 'Clip name' : `Name of ${clips.length} clips`),
    input,
  );
  document.body.append(box);
  input.focus();
  input.select();
}

function formatRate(rate: number): string {
  if (rate === 1) return '1×';
  const st = rateToSemitones(rate);
  return `${rate.toFixed(2)}×, ${st > 0 ? '+' : ''}${st.toFixed(1)} st`;
}

/** A small field to type the varispeed in: 1.5, 150 % or +7 st (Enter applies, Esc cancels). */
function promptRate(ids: Set<string>, current: number, x: number, y: number): void {
  document.querySelector('.gain-prompt')?.remove();
  const input = h('input', { value: current === 1 ? '1' : current.toFixed(3).replace(/0+$/, ''), title: `${MIN_RATE}× to ${MAX_RATE}×, e.g. 1.5, 80 %, +3 st or -12 st` }) as HTMLInputElement;
  let done = false;
  const close = (apply: boolean) => {
    if (done) return;
    done = true;
    box.remove();
    if (!apply) return;
    const v = parseRateInput(input.value);
    if (v === null) return toast('Type a speed like 1.5, 80 % or semitones like +3 st');
    store.edit((p) => setClipsRate(p, ids, v));
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
    h('span', { class: 'muted' }, 'Speed'),
    input,
    h('span', { class: 'muted' }, '× or st'),
  );
  document.body.append(box);
  input.focus();
  input.select();
}

/** "Takes": the takes recorded over the clicked clip, to play another one, and the take lanes. */
function takeEntries(o: ClipMenuOptions, one: boolean, recording: boolean): ContextMenuEntry[] {
  const found = findClip(store.project, o.clipId);
  if (!one || !found?.track.takes?.length) return [];
  const { track, clip } = found;
  const at = Math.min(Math.max(o.at, clip.start), clip.start + clip.length - 1);
  const takes = takesAt(track, at);
  if (!takes.length) return [];
  const active = activeTakeAt(track, at);
  return [
    { kind: 'separator' },
    { kind: 'header', label: 'Takes' },
    ...takes.map((t) => ({
      label: `Take ${t.n}`,
      checked: active?.id === t.id,
      enabled: !recording,
      run: () => store.edit((p) => pickTake(p, track.id, t.id)),
    })),
    { label: 'Show take lanes', checked: !!track.showTakes, run: () => store.patch((p) => updateTrack(p, track.id, { showTakes: !track.showTakes })) },
  ];
}
