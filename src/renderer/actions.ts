// Commands shared by keyboard shortcuts, menus and buttons.
import type { MarkerKind } from '../shared/types';
import { addClip, addMarker, addTrack, applyChapterContent, chaptersToMarkers, clipsEnd, deleteClips, prepareForEditing as unarmAll, rippleDelete, splitAt, updateClip, updateMarker } from '../core/project';
import { importChapters, parseChapterContent } from '../core/chapters';
import { addMuteRegion, removeMuteRegion } from '../core/muteRegions';
import { muteSelection as muteEnvelopeRange } from '../core/envelope';
import { uid } from '../shared/time';
import { baseName, decodeBytes, decodeFile } from './audioFiles';
import { errorMessage, h, toast } from './dom';
import { api, saveRepeatSetting, saveSpeedSetting, store } from './store';
import { speedLabel, stepSpeed } from '../core/timeStretch';
import { runSoundcheck } from '../core/soundcheck';
import { allClipIds, clipEdges, markerPositions, stepTo } from '../core/navigation';
import { copyClips, copyRange, pasteClipboard as pasteInto } from '../core/clipboard';
import { addRegion } from '../core/regions';
import { selectionSpan } from '../core/navigation';
import { confirmStop, showSoundcheck } from './recordDialogs';

/** A stop confirmation is on screen (a second Stop press shouldn't open another). */
let confirming = false;

export async function togglePlay(): Promise<void> {
  const t = store.transport;
  try {
    if (t.state === 'stopped') {
      // With Repeat on, a playhead outside the selection starts at the selection so it loops right away.
      const loop = loopRange();
      let from = loop && (t.position < loop[0] || t.position >= loop[1]) ? loop[0] : t.position;
      // Playback stops at the end of the last clip, so Play from there starts over.
      if (!loop && from >= clipsEnd(store.project)) from = 0;
      await api().play(from);
    }
    else await stop();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** The range playback repeats: the selected time range while Repeat is on. */
export function loopRange(): [number, number] | null {
  const r = store.selection.range;
  if (!store.repeat || !r) return null;
  const start = Math.max(0, Math.round(Math.min(r[0], r[1])));
  const end = Math.round(Math.max(r[0], r[1]));
  return end > start ? [start, end] : null;
}

let sentLoop = '';

/** Tells the engine the current repeat range; call when Repeat or the selection changes. */
export function syncLoop(): void {
  const loop = loopRange();
  const key = loop ? loop.join(':') : '';
  if (key === sentLoop) return;
  sentLoop = key;
  void api().setLoop(loop);
}

export function toggleRepeat(): void {
  store.repeat = !store.repeat;
  saveRepeatSetting(store.repeat);
  syncLoop();
  store.notify('transport');
  if (store.repeat && !store.selection.range) toast('Repeat on: select a time range to loop it');
}

/** Sets the listening speed (pitch kept); recording and export always run at 1x. */
export function setSpeed(speed: number, announce = false): void {
  store.speed = speed;
  saveSpeedSetting(speed);
  void api().setPlaybackSpeed(speed);
  store.notify('transport');
  if (announce) toast(speed === 1 ? 'Normal speed' : `Playback speed ${speedLabel(speed)}`);
}

/** One step faster (1) or slower (-1), e.g. from the keyboard or the View menu. */
export function stepPlaybackSpeed(dir: 1 | -1): void {
  const next = stepSpeed(store.speed, dir);
  if (next === store.speed) return void toast(dir > 0 ? `Already at the fastest speed (${speedLabel(next)})` : 'Already at normal speed');
  setSpeed(next, true);
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

/** Plays the timeline at the speed the dragged playhead moves (tape-style); null ends it. */
export function scrub(position: number | null): void {
  void api().scrub(position === null ? null : Math.max(0, position));
}

export function dropMarker(kind: MarkerKind): void {
  const pos = store.transport.position;
  // Markers set while recording don't need undo granularity per keypress, but keeping it is harmless.
  store.edit((p) => addMarker(p, pos, kind).project);
  toast(kind === 'chapter' ? 'Chapter marker added' : 'Edit marker added');
}

/** Makes the selected time range a region (a part that can be exported as its own file). */
export function regionFromSelection(): void {
  const span = selectionSpan(store.project, store.selection.range, store.selection.clipIds);
  if (!span || span[1] <= span[0]) return toast('Select a time range (or clips) to make a region');
  store.edit((p) => addRegion(p, span[0], span[1]).project);
  toast('Region added. Rename it in the Chapters view; export it with “Each region as its own file”.');
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
  // a ripple cut takes the range out of every track, so that is what the clipboard gets
  store.clipboard = copyRange(store.project, r[0], r[1], store.project.tracks.map((t) => t.id));
  deleteSelection(true);
  toast('Ripple cut (Ctrl+V pastes it back in)');
}

/** Ctrl+A: selects every clip on every track. */
export function selectAllClips(): void {
  if (store.view !== 'edit') return;
  store.select({ clipIds: allClipIds(store.project), range: null, rangeTracks: null, markerId: null, muteRegion: null });
}

/** Ctrl+C: copies the selected range (on its tracks) or the selected clips. */
export function copySelection(): void {
  const { range, clipIds } = store.selection;
  const data =
    range && range[1] > range[0] ? copyRange(store.project, range[0], range[1], selectionTracks()) : clipIds.size ? copyClips(store.project, clipIds) : null;
  if (!data) return toast('Select clips or a time range to copy');
  store.clipboard = data;
  const secs = (data.length / store.sampleRate).toFixed(1);
  toast(`Copied ${data.items.length} clip${data.items.length === 1 ? '' : 's'} (${secs} s)`);
}

/** Ctrl+V pastes at the playhead on top; Ctrl+Shift+V makes room first (ripple insert). */
export function pasteClipboard(ripple: boolean): void {
  const data = store.clipboard;
  if (!data) return toast('Nothing copied yet');
  if (store.transport.state === 'recording') return toast('Stop recording before pasting');
  const at = store.transport.position;
  let ids: string[] = [];
  store.edit((p) => {
    const r = pasteInto(p, data, at, ripple);
    ids = r.clipIds;
    return r.project;
  });
  store.select({ clipIds: new Set(ids), range: null, rangeTracks: null, markerId: null });
  toast(ripple ? 'Pasted and moved the rest of the episode along' : 'Pasted at the playhead');
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

/**
 * Imports chapter titles and links without times ("title;link" per line) into the existing
 * chapters, in order. The start times stay.
 */
export async function importChapterContentFile(): Promise<void> {
  try {
    const chapters = store.project.markers.filter((m) => m.kind === 'chapter').length;
    if (!chapters) {
      toast('Add chapter markers first: the titles and links are filled into the existing chapters in order.', 'error');
      return;
    }
    const res = await api().openTextFile('Chapter titles and links (title;link per line)', ['txt', 'csv']);
    if (!res) return;
    const content = parseChapterContent(res.text);
    if (!content.length) {
      toast('No chapter lines found. Use one "title;link" per line.', 'error');
      return;
    }
    store.edit((p) => applyChapterContent(p, content));
    const used = Math.min(content.length, chapters);
    const notes: string[] = [];
    if (content.length > chapters) notes.push(`${content.length - chapters} line(s) left over: there are only ${chapters} chapters`);
    if (content.length < chapters) notes.push(`${chapters - content.length} chapter(s) at the end kept their text`);
    toast(`Filled ${used} chapter(s) with titles and links${notes.length ? ` (${notes.join('; ')})` : ''}`, content.length > chapters ? 'error' : 'info');
  } catch (e) {
    toast(`Could not import chapter titles: ${errorMessage(e)}`, 'error');
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

/** Double-ender: moves the selected clip so it lines up with a reference track the user picks. */
export async function alignSelectedClip(): Promise<void> {
  const ids = [...store.selection.clipIds];
  const track = store.project.tracks.find((t) => t.clips.some((c) => c.id === ids[0]));
  if (ids.length !== 1 || !track) return toast('Select one clip: the guest’s own recording');
  const refs = store.project.tracks.filter((t) => t.id !== track.id && t.clips.length > 0);
  if (!refs.length) return toast('There is no other track with audio to align to');
  const refId = await pickTrack(refs, 'Align to which track?', 'Pick the track that recorded this guest during the call (for example the RØDECaster’s USB Chat channel).');
  if (!refId) return;
  const clipId = ids[0];
  toast('Aligning…');
  try {
    const r = await api().alignClip(clipId, refId);
    store.edit((p) => updateClip(p, clipId, { start: r.start }));
    const ms = (r.shift / store.sampleRate) * 1000;
    const moved = Math.abs(ms) < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
    if (r.confidence < 0.3) toast(`Moved by ${moved}, but the match is weak (${Math.round(r.confidence * 100)}%). Listen and undo if it’s off.`, 'error');
    else toast(`Aligned: moved by ${moved} (match ${Math.round(r.confidence * 100)}%)`);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function pickTrack(tracks: Array<{ id: string; name: string; color: string }>, title: string, hint: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' });
    const done = (v: string | null) => {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => e.target === overlay && done(null));
    overlay.append(
      h(
        'div',
        { class: 'dialog narrow' },
        h('h2', null, title),
        h('p', { class: 'muted' }, hint),
        h('div', { class: 'track-pick' }, ...tracks.map((t) => h('button', { style: { borderLeft: `4px solid ${t.color}` }, onclick: () => done(t.id) }, t.name))),
        h('div', { class: 'row end' }, h('button', { onclick: () => done(null) }, 'Cancel')),
      ),
    );
    document.body.append(overlay);
  });
}

/** Files dropped on the timeline: onto a track at the drop position, or as new tracks. */
export async function importDroppedFiles(files: File[], at: number, trackId: string | null): Promise<void> {
  const sr = store.sampleRate;
  let pos = at;
  for (const file of files) {
    try {
      toast(`Importing ${file.name}…`);
      const channels = await decodeBytes(await file.arrayBuffer(), sr);
      const res = await api().importAudio(file.name, channels, sr);
      store.edit((p) => {
        let q = p;
        let id = trackId && q.tracks.some((t) => t.id === trackId) ? trackId : null;
        if (!id) {
          q = addTrack(q, { name: file.name.replace(/\.[^.]+$/, '') });
          id = q.tracks[q.tracks.length - 1].id;
        }
        return addClip(q, id, { id: uid('clp'), file: res.file, start: pos, offset: 0, length: res.length, gain: 0, fadeIn: 0, fadeOut: 0 });
      });
      // several files on one track go one after the other
      if (trackId) pos += res.length;
      toast(`Imported ${file.name}`);
    } catch (e) {
      toast(`${file.name}: ${errorMessage(e)}`, 'error');
    }
  }
}
