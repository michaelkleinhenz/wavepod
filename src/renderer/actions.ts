// Commands shared by keyboard shortcuts, menus and buttons.
import type { MarkerKind } from '../shared/types';
import { addClip, addMarker, addTrack, chaptersToMarkers, deleteClips, rippleDelete, splitAt } from '../core/project';
import { importChapters } from '../core/chapters';
import { addMuteRegion, removeMuteRegion } from '../core/muteRegions';
import { uid } from '../shared/time';
import { baseName, decodeFile } from './audioFiles';
import { errorMessage, toast } from './dom';
import { api, store } from './store';

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
    await api().stop();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function toggleRecord(): Promise<void> {
  if (store.transport.state === 'recording') return stop();
  try {
    if (store.transport.state === 'playing') await api().stop();
    store.recordStart = store.transport.position;
    const files = await api().record();
    toast(`Recording ${files.length} track${files.length === 1 ? '' : 's'}`);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
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
      store.select({ range: null });
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
