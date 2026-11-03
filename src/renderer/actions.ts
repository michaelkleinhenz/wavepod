// Commands shared by keyboard shortcuts, menus and buttons.
import type { MarkerKind } from '../shared/types';
import { addClip, addMarker, addTrack, chaptersToMarkers, deleteClips, prepareForEditing as unarmAll, rippleDelete, splitAt, updateMarker } from '../core/project';
import { importChapters } from '../core/chapters';
import { addMuteRegion, removeMuteRegion } from '../core/muteRegions';
import { muteSelection as muteEnvelopeRange } from '../core/envelope';
import { uid } from '../shared/time';
import { baseName, decodeFile } from './audioFiles';
import { errorMessage, h, toast } from './dom';
import { api, store } from './store';
import { runSoundcheck } from '../core/soundcheck';
import { clipEdges, markerPositions, stepTo } from '../core/navigation';
import { confirmStop, showSoundcheck } from './recordDialogs';

/** A stop confirmation is on screen (a second Stop press shouldn't open another). */
let confirming = false;

export async function togglePlay(): Promise<void> {
  const t = store.transport;
  try {
    if (t.state === 'stopped') await api().play(t.position);
    else await stop();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function stop(): Promise<void> {
  try {
    if (store.transport.state === 'recording') {
      if (confirming) return;
      if (await api().confirmStopRecording()) {
        confirming = true;
        const ok = await confirmStop().finally(() => (confirming = false));
        if (!ok || store.transport.state !== 'recording') return;
      }
    }
    await api().stop();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function toggleRecord(): Promise<void> {
  if (store.transport.state === 'recording') return stop();
  try {
    if (!(await soundcheck())) return;
    if (store.transport.state === 'playing') await api().stop();
    store.recordStart = store.transport.position;
    const files = await api().record();
    toast(`Recording ${files.length} track${files.length === 1 ? '' : 's'}`);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Runs the soundcheck; true if recording may start (no problems, or the user chose to record anyway). */
async function soundcheck(): Promise<boolean> {
  const info = await api().soundcheckInfo();
  const status = store.status;
  const issues = runSoundcheck({
    project: store.project,
    deviceSampleRate: status?.config.sampleRate ?? store.sampleRate,
    inputOpen: !!status?.inputOpen,
    inputDeviceName: info.inputDeviceName,
    freeBytes: info.freeBytes,
    position: store.transport.position,
    ignored: store.project.soundcheckIgnored,
  });
  if (!issues.length) return true;
  const res = await showSoundcheck(issues);
  if (res.ignore.length) {
    store.patch((p) => ({ ...p, soundcheckIgnored: [...new Set([...(p.soundcheckIgnored ?? []), ...res.ignore])] }));
  }
  return res.action === 'record';
}

/** "Prepare all tracks for editing" (as in Ultraschall): unarms every track so editing can't start a take by accident. */
export function prepareForEditing(): void {
  if (store.transport.state === 'recording') return toast('Stop recording before preparing for editing');
  const armed = store.project.tracks.filter((t) => t.armed).length;
  if (!armed) return toast('All tracks are ready for editing');
  // Arming isn't part of undo (see the track header toggles), so neither is this.
  store.patch(unarmAll);
  toast(`Prepared for editing: ${armed} track${armed === 1 ? '' : 's'} unarmed`);
}

export function seek(position: number): void {
  const pos = Math.max(0, Math.round(position));
  store.transport = { ...store.transport, position: pos };
  store.notify('transport');
  void api().seek(pos);
  if (store.transport.state === 'playing') void api().play(pos);
}

export function dropMarker(kind: MarkerKind): void {
  const pos = store.transport.position;
  // Markers set while recording don't need undo granularity per keypress, but keeping it is harmless.
  store.edit((p) => addMarker(p, pos, kind).project);
  toast(kind === 'chapter' ? 'Chapter marker added' : 'Edit marker added');
}

/** Shift+M: a chapter marker whose title can be typed right away, without stopping anything. */
export function dropNamedChapter(): void {
  const pos = store.transport.position;
  let id = '';
  store.edit((p) => {
    const r = addMarker(p, pos, 'chapter');
    id = r.marker.id;
    return r.project;
  });
  showTitlePrompt(id);
}

let prompt: HTMLElement | null = null;

function showTitlePrompt(markerId: string): void {
  prompt?.remove();
  const marker = store.project.markers.find((m) => m.id === markerId);
  if (!marker) return;
  const input = document.createElement('input');
  input.className = 'title';
  input.placeholder = marker.title;
  let closed = false;
  const close = (save: boolean) => {
    if (closed) return;
    closed = true;
    const title = input.value.trim();
    box.remove();
    if (prompt === box) prompt = null;
    // part of the marker's own undo step: undo removes the marker with its title
    if (save && title) store.patch((p) => updateMarker(p, markerId, { title }));
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') close(true);
    else if (e.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  const box = h('div', { class: 'title-prompt' }, h('span', { class: 'muted' }, 'Chapter title'), input, h('small', { class: 'muted' }, 'Enter to save · Esc keeps "' + marker.title + '"'));
  prompt = box;
  document.body.append(box);
  input.focus();
}

/** Y: back to the recording position: where the current take is, or where the last one stopped. */
export function jumpToRecordPosition(reveal: (pos: number) => void): void {
  if (store.transport.state === 'recording') return reveal(store.transport.position);
  const pos = store.recordPosition;
  if (pos === null) return toast('Nothing recorded yet in this session');
  seek(pos);
  reveal(pos);
}

/** Alt+←/→ (clip edges) and Shift+Alt+←/→ (markers): step to the previous or next one. */
export function stepPlayhead(target: 'edge' | 'marker', dir: 1 | -1): number | null {
  const positions = target === 'edge' ? clipEdges(store.project) : markerPositions(store.project);
  // a few ms of slack so a repeated press moves on from where the last one landed
  const pos = stepTo(positions, store.transport.position, dir, Math.round(store.sampleRate * 0.005));
  if (pos === null) {
    toast(`No ${target === 'edge' ? 'clip edge' : 'marker'} ${dir > 0 ? 'after' : 'before'} the playhead`);
    return null;
  }
  seek(pos);
  return pos;
}

export const PREVIEW_PREROLL_SECONDS = 2;
export const PREVIEW_POSTROLL_SECONDS = 2;

/**
 * P: "preview cut": plays from a little before the playhead to a little after it, then puts the
 * playhead back, so a cut can be checked again and again.
 */
export async function previewCut(): Promise<void> {
  if (store.transport.state === 'recording') return;
  const origin = store.transport.position;
  const from = Math.max(0, origin - Math.round(PREVIEW_PREROLL_SECONDS * store.sampleRate));
  store.preview = { end: origin + Math.round(PREVIEW_POSTROLL_SECONDS * store.sampleRate), origin };
  try {
    if (store.transport.state === 'playing') await api().stop();
    await api().play(from);
  } catch (e) {
    store.preview = null;
    toast(errorMessage(e), 'error');
  }
}

/** Called on every transport update: ends a preview at its end point. */
export function checkPreview(): void {
  const pv = store.preview;
  if (!pv) return;
  const t = store.transport;
  if (t.state === 'recording') {
    store.preview = null;
    return;
  }
  if (t.state === 'playing') pv.started = true;
  else if (pv.started) {
    // stopped by hand: leave the playhead where it is
    store.preview = null;
    return;
  }
  if (t.state === 'playing' && t.position >= pv.end) {
    store.preview = null;
    void api()
      .stop()
      .then(() => seek(pv.origin));
  }
}

export function splitAtPlayhead(): void {
  const pos = store.transport.position;
  const sel = store.selection.clipIds;
  const trackIds = sel.size
    ? store.project.tracks.filter((t) => t.clips.some((c) => sel.has(c.id))).map((t) => t.id)
    : undefined;
  store.edit((p) => splitAt(p, pos, trackIds));
}

/** Mute starts this much before the button press (reaction time) and ends this much after release. */
const COUGH_PREROLL_SECONDS = 0.1;
const COUGH_POSTROLL_SECONDS = 0.05;

/** Cough button pressed: starts muting the track (recording or playback must be running). */
export function coughDown(trackId: string): void {
  if (store.coughs.has(trackId)) return;
  if (store.transport.state === 'stopped') {
    toast('Cough buttons work while recording or playing');
    return;
  }
  store.coughs.set(trackId, Math.max(0, store.transport.position - Math.round(COUGH_PREROLL_SECONDS * store.sampleRate)));
  store.notify('transport');
}

/** Cough button released: stores the mute region (undoable, editable on the timeline). */
export function coughUp(trackId: string): void {
  const start = store.coughs.get(trackId);
  if (start === undefined) return;
  store.coughs.delete(trackId);
  const end = store.transport.position + Math.round(COUGH_POSTROLL_SECONDS * store.sampleRate);
  store.edit((p) => addMuteRegion(p, trackId, start, end));
}

export function releaseAllCoughs(): void {
  for (const id of [...store.coughs.keys()]) coughUp(id);
}

/** The track a cough key (Shift+1…9) belongs to: the n-th track that isn't the Soundboard. */
export function coughTrackForKey(n: number): string | undefined {
  return store.project.tracks.filter((t) => t.kind !== 'soundboard')[n - 1]?.id;
}

export function deleteSelection(ripple: boolean): void {
  const { range, clipIds, markerId, muteRegion } = store.selection;
  if (muteRegion) {
    store.edit((p) => removeMuteRegion(p, muteRegion.trackId, muteRegion.index));
    store.select({ muteRegion: null });
    return;
  }
  if (range && range[1] > range[0]) {
    if (ripple) {
      store.edit((p) => rippleDelete(p, range[0], range[1]));
      store.select({ range: null, rangeTracks: null });
      seek(range[0]);
    } else {
      // remove material in range on all tracks but keep the gap
      store.edit((p) => {
        let q = splitAt(splitAt(p, range[0]), range[1]);
        const ids = q.tracks.flatMap((t) => t.clips.filter((c) => c.start >= range[0] && c.start + c.length <= range[1]).map((c) => c.id));
        q = deleteClips(q, ids);
        return q;
      });
    }
    return;
  }
  if (clipIds.size) {
    store.edit((p) => deleteClips(p, [...clipIds]));
    store.select({ clipIds: new Set() });
    return;
  }
  if (markerId) {
    store.edit((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== markerId) }));
    store.select({ markerId: null });
  }
}

/** Ctrl+X: removes the selected time range from all tracks and closes the gap. */
export function rippleCut(): void {
  const r = store.selection.range;
  if (!r || r[1] <= r[0]) {
    toast('Select a time range first: drag across the ruler or an empty part of a track');
    return;
  }
  deleteSelection(true);
  toast('Ripple cut');
}

/** Tracks a Ctrl+Y mute applies to: the tracks the range was dragged across, else those of selected clips, else all. */
export function selectionTracks(): string[] {
  const { rangeTracks, clipIds } = store.selection;
  if (rangeTracks?.length) return rangeTracks;
  if (clipIds.size) return store.project.tracks.filter((t) => t.clips.some((c) => clipIds.has(c.id))).map((t) => t.id);
  return store.project.tracks.map((t) => t.id);
}

/** Ctrl+Y: silences the selected range on the selected tracks by bending their volume lines. */
export function muteSelection(): void {
  const r = store.selection.range;
  if (!r || r[1] <= r[0]) {
    toast('Select a time range on a track first');
    return;
  }
  const ids = selectionTracks();
  store.edit((p) => muteEnvelopeRange(p, ids, r[0], r[1]));
  toast(`Muted the selection on ${ids.length} track${ids.length === 1 ? '' : 's'}`);
}

export async function importAudioFiles(): Promise<void> {
  const paths = await api().pickAudioFiles();
  if (!paths.length) return;
  const sr = store.sampleRate;
  const at = store.transport.position;
  for (const path of paths) {
    try {
      toast(`Importing ${baseName(path)}…`);
      const channels = await decodeFile(path, sr);
      const res = await api().importAudio(baseName(path), channels, sr);
      store.edit((p) => {
        const q = addTrack(p, { name: baseName(path).replace(/\.[^.]+$/, '') });
        const track = q.tracks[q.tracks.length - 1];
        return addClip(q, track.id, { id: uid('clp'), file: res.file, start: at, offset: 0, length: res.length, gain: 0, fadeIn: 0, fadeOut: 0 });
      });
    } catch (e) {
      toast(`Could not import ${baseName(path)}: ${errorMessage(e)}`, 'error');
    }
  }
}

export async function importChapterFile(): Promise<void> {
  try {
    const res = await api().openTextFile('Chapter file', ['xml', 'txt', 'json', 'psc']);
    if (!res) return;
    const chapters = importChapters(res.text);
    store.edit((p) => chaptersToMarkers(p, chapters, true));
    toast(`Imported ${chapters.length} chapters`);
  } catch (e) {
    toast(`Could not import chapters: ${errorMessage(e)}`, 'error');
  }
}

export async function newProject(): Promise<void> {
  try {
    const res = await api().newProject();
    if (res) store.setProject(res.project, res.dir);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function openProject(): Promise<void> {
  try {
    const res = await api().openProject();
    if (res) store.setProject(res.project, res.dir);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** File › Restore Backup…: replaces the episode with a backup, as one undo step. */
export async function restoreBackup(): Promise<void> {
  if (store.transport.state === 'recording') return toast('Stop recording before restoring a backup');
  try {
    const project = await api().restoreBackup();
    if (!project) return;
    store.edit(() => project);
    toast('Backup restored. Undo brings back the episode as it was.');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}
