// Cameras of a video podcast: importing camera videos (each gets its sound on a track of its own,
// which its picture follows), syncing them to the other recordings, and their settings.
import type { Camera, Project } from '../../shared/types';
import { addTrack } from '../../core/project';
import { uid } from '../../shared/time';
import { CAMERA_COLORS, MAX_CAMERAS, cameraSyncAfterStretch, cameraTrack, moveCamera, ownSync, removeCamera, updateCamera } from '../../core/video';
import { applyAlignment } from '../../core/alignEdit';
import { alignTo, pickTrack } from '../actions';
import { errorMessage, h, toast } from '../dom';
import { api, store } from '../store';
import { decodeVideoAudio, probeVideo } from './media';

export const VIDEO_FILE = /\.(mp4|mov|m4v|mkv|webm)$/i;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function busyDialog(title: string): { el: HTMLElement; status: HTMLElement; bar: HTMLElement; cancelled: () => boolean } {
  let cancelled = false;
  const status = h('span', null, 'Reading the file…');
  const bar = h('div', { class: 'video-import-fill' });
  const el = h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog narrow' },
      h('h2', null, title),
      h('p', { class: 'muted align-busy' }, h('span', { class: 'spinner' }), status),
      h('div', { class: 'video-import-bar' }, bar),
      h('div', { class: 'row end' }, h('button', { onclick: () => (cancelled = true) }, 'Cancel')),
    ),
  );
  document.body.append(el);
  return { el, status, bar, cancelled: () => cancelled };
}

/** File › Import Camera Video…: picks video files and adds each as a camera. */
export async function importVideos(paths?: string[]): Promise<void> {
  if (store.transport.state === 'recording') return toast('Stop recording before importing');
  const files = paths ?? (await api().pickVideoFiles());
  for (const path of files) {
    if ((store.project.cameras?.length ?? 0) >= MAX_CAMERAS) {
      toast(`An episode can have up to ${MAX_CAMERAS} cameras`, 'error');
      return;
    }
    const ok = await importVideo(path);
    if (!ok) return;
  }
}

async function importVideo(path: string): Promise<boolean> {
  const name = baseName(path).replace(/\.[^.]+$/, '');
  const busy = busyDialog(`Importing ${name}`);
  let importId: string | null = null;
  try {
    const stored = await api().storedVideoPath(path);
    const probe = await probeVideo(stored);
    if (!probe.decodable) throw new Error(`this computer can't decode its video (${probe.codec}). Convert it to H.264, VP9 or AV1 first.`);
    if (!probe.hasAudio) throw new Error('it has no sound. WavePod lines cameras up with the other recordings by their sound, so each camera needs its own (even a poor one).');
    busy.status.textContent = 'Taking out the camera’s sound…';
    const sr = store.sampleRate;
    let length = 0;
    let channels = 0;
    const done = await decodeVideoAudio(
      stored,
      sr,
      async (block) => {
        if (busy.cancelled()) throw new Error('cancelled');
        if (!importId) {
          channels = block.length;
          importId = await api().importAudioBegin(`${name}-camera.wav`, channels, sr);
        }
        length += block[0].length;
        await api().importAudioChunk(importId, block);
      },
      (f) => (busy.bar.style.width = `${Math.round(f * 100)}%`),
    );
    channels = channels || done.channels;
    if (!importId) throw new Error('its sound track is empty');
    const audio = (await api().importAudioEnd(importId))!;
    importId = null;
    store.edit((p) => addCamera(p, { name, file: stored, probe, audioFile: audio.file, audioLength: audio.length }));
    toast(`${name} added as camera ${store.project.cameras!.length}. Line the recordings up: right-click a track › Align to other track…`);
    return true;
  } catch (e) {
    if (importId) await api().importAudioEnd(importId, true).catch(() => undefined);
    if (errorMessage(e) !== 'cancelled') toast(`Could not import ${name}: ${errorMessage(e)}`, 'error');
    return false;
  } finally {
    busy.el.remove();
  }
}

/** Adds a camera and its sound track (muted: it is the camera's reference sound, not the mix). */
export function addCamera(
  p: Project,
  o: { name: string; file: string; probe: { width: number; height: number; fps: number; duration: number; codec: string; audioStart: number }; audioFile: string; audioLength: number },
): Project {
  const cams = p.cameras ?? [];
  const id = uid('cam');
  const color = CAMERA_COLORS[cams.length % CAMERA_COLORS.length];
  const cam: Camera = {
    id,
    name: o.name,
    color,
    file: o.file,
    width: o.probe.width,
    height: o.probe.height,
    fps: o.probe.fps,
    duration: o.probe.duration,
    codec: o.probe.codec,
    sync: [ownSync(o.audioFile, o.probe.audioStart)],
  };
  const trackId = uid('trk');
  let q = addTrack(p, { id: trackId, name: `${o.name} (camera)`, color, mute: true, cameraId: id, stem: 'none' });
  // the camera's sound starts where its video starts (the timeline start, until it is aligned)
  q = {
    ...q,
    tracks: q.tracks.map((t) =>
      t.id === trackId ? { ...t, clips: [{ id: uid('clp'), file: o.audioFile, start: Math.max(0, Math.round(o.probe.audioStart * p.sampleRate)), offset: 0, length: o.audioLength, gain: 0, fadeIn: 0, fadeOut: 0 }] } : t,
    ),
    cameras: [...cams, cam],
    director: p.director ?? { cuts: [] },
  };
  return q;
}

/** Camera › Sync to audio…: lines the camera's sound up with another recording (clock drift included). */
export async function syncCamera(cameraId: string): Promise<void> {
  const track = cameraTrack(store.project, cameraId);
  if (!track?.clips.length) return toast('This camera has no sound to sync with');
  await alignTo(
    track.clips.map((c) => c.id),
    track.id,
  );
}

/** Video › Sync All Cameras…: lines every camera's sound up with one recording the user picks. */
export async function syncAllCameras(): Promise<void> {
  const cams = store.project.cameras ?? [];
  if (!cams.length) return toast('Import a camera video first (File › Import Camera Video…)');
  const camTracks = new Set(cams.map((c) => cameraTrack(store.project, c.id)?.id));
  const refs = store.project.tracks.filter((t) => !camTracks.has(t.id) && t.kind !== 'soundboard' && t.clips.length);
  if (!refs.length) return toast('Add the microphone recordings first: the cameras are synced to one of them');
  const refId =
    refs.length === 1
      ? refs[0].id
      : await pickTrack(refs, 'Sync the cameras to which recording?', 'Pick a microphone recording that runs through the whole conversation. Each camera’s sound is lined up with it, clock drift included.');
  if (!refId) return;
  const busy = busyDialog('Syncing cameras');
  busy.bar.parentElement!.remove();
  let synced = 0;
  try {
    for (const cam of cams) {
      if (busy.cancelled()) break;
      const t = cameraTrack(store.project, cam.id);
      if (!t?.clips.length) continue;
      busy.status.textContent = `${cam.name}: finding where its sound matches and checking for clock drift…`;
      const ids = t.clips.map((c) => c.id);
      const r = await api().alignClips(ids, refId);
      if (r.confidence <= 0) {
        toast(`${cam.name}: no clear match with the recording. Sync it by hand: right-click its track › Align to other track…`, 'error');
        continue;
      }
      store.edit((p) => cameraSyncAfterStretch(applyAlignment(p, ids, r, r.files), r.files, 1 + r.drift));
      synced++;
    }
  } catch (e) {
    toast(errorMessage(e), 'error');
  } finally {
    busy.el.remove();
  }
  if (synced) toast(`Synced ${synced} camera${synced === 1 ? '' : 's'} (Ctrl+Z undoes each)`);
}

export function deleteCamera(cameraId: string): void {
  const cam = store.project.cameras?.find((c) => c.id === cameraId);
  if (!cam) return;
  store.edit((p) => removeCamera(p, cameraId));
  toast(`Removed camera ${cam.name} (Ctrl+Z brings it back)`);
}

export function renameCamera(cameraId: string, name: string): void {
  const n = name.trim();
  if (!n) return;
  store.edit((p) => {
    const q = updateCamera(p, cameraId, { name: n });
    return { ...q, tracks: q.tracks.map((t) => (t.cameraId === cameraId ? { ...t, name: `${n} (camera)` } : t)) };
  });
}

export function shiftCamera(cameraId: string, dir: -1 | 1): void {
  store.edit((p) => moveCamera(p, cameraId, dir));
}

export function setFraming(cameraId: string, framing: Camera['framing'], live = false): void {
  const fn = (p: Project) => updateCamera(p, cameraId, { framing });
  if (live) store.editLive(fn);
  else store.edit(fn);
}

export function setSpeakers(cameraId: string, speakers: string[]): void {
  store.edit((p) => updateCamera(p, cameraId, { speakers }));
}
