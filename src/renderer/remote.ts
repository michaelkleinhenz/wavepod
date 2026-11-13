// Runs remote-control commands (MIDI buttons and OSC messages) the same way the keyboard does.
import type { MidiAction, RemoteCommand } from '../shared/types';
import { coughDown, coughTrackForKey, coughUp, dropMarker, prepareForEditing, punchIn, stop, togglePlay, toggleRecord } from './actions';
import { api, store } from './store';

/** Set at startup: plays soundboard slot `index` (0-based); switches to camera `index` (0-based). */
export const remoteHooks: { playSound: (index: number) => void; camera: (index: number) => void } = { playSound: () => {}, camera: () => {} };

let queue: Promise<void> = Promise.resolve();
/** Cough buttons held by remote control, by slot, so a release unmutes the track the press muted. */
const heldCoughs = new Map<number, string>();

export function runRemote(cmd: RemoteCommand): void {
  const { action, pressed } = cmd;
  const cough = /^cough-(\d)$/.exec(action);
  if (cough) {
    const n = Number(cough[1]);
    if (pressed) {
      const id = coughTrackForKey(n);
      if (id && !heldCoughs.has(n)) {
        heldCoughs.set(n, id);
        coughDown(id);
      }
    } else {
      const id = heldCoughs.get(n);
      heldCoughs.delete(n);
      if (id) coughUp(id);
    }
    return;
  }
  if (!pressed) return;
  const sound = /^sound-(\d)$/.exec(action);
  if (sound) return remoteHooks.playSound(Number(sound[1]) - 1);
  const camera = /^camera-(\d)$/.exec(action);
  if (camera) return remoteHooks.camera(Number(camera[1]) - 1);
  runAction(action);
}

function runAction(action: MidiAction): void {
  switch (action) {
    case 'chapter-marker':
      return dropMarker('chapter');
    case 'edit-marker':
      return dropMarker('edit');
    case 'prepare-for-editing':
      return prepareForEditing();
    case 'sounds-stop':
      return void api().stopSounds();
    case 'preshow-toggle':
      return void api().setPreShow(!store.status?.preShow);
  }
  // transport commands one after the other, each seeing the state the previous one left
  queue = queue.then(() => {
    const state = store.transport.state;
    switch (action) {
      case 'record-start':
        return state === 'recording' ? undefined : toggleRecord();
      case 'record-stop':
        return state === 'recording' ? stop() : undefined;
      case 'record-toggle':
        return toggleRecord();
      case 'punch-in':
        return punchIn();
      case 'play-toggle':
        return togglePlay();
      case 'stop':
        return state === 'stopped' ? undefined : stop();
    }
  });
}
