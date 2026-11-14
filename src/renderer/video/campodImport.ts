// File › Import from CamPod…: picks a recording on the CamPod camera recorder, downloads its camera
// files into the episode folder, adds each as a camera and syncs them to the microphones.
import type { CamPodEvent, CamPodSessionInfo } from '../../shared/types';
import { MAX_CAMERAS } from '../../core/video';
import { errorMessage, h, toast } from '../dom';
import { api, store } from '../store';
import { busyDialog, importVideo, syncAllCameras } from './cameras';

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatLength(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Asks which CamPod recording to import; the ones started with this episode's takes come first. */
function pickSession(list: CamPodSessionInfo[]): Promise<string | null> {
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
    const sorted = [...list.filter((s) => s.linked), ...list.filter((s) => !s.linked)];
    const row = (s: CamPodSessionInfo) =>
      h(
        'button',
        {
          class: `campod-session${s.linked ? ' linked' : ''}`,
          disabled: s.active || !s.files,
          title: s.active ? 'Still recording: stop it first' : s.files ? `Download ${s.files} camera file${s.files === 1 ? '' : 's'} into this episode` : 'No camera files',
          onclick: () => done(s.name),
        },
        h('span', { class: 'campod-session-title' }, s.title || s.name, s.linked ? h('span', { class: 'campod-tag' }, 'This episode') : null, s.active ? h('span', { class: 'campod-tag rec' }, 'Recording') : null),
        h('span', { class: 'muted' }, [formatDate(s.startedAt), s.seconds ? formatLength(s.seconds) : '', `${s.files} camera file${s.files === 1 ? '' : 's'}, ${formatSize(s.bytes)}`].filter(Boolean).join(' · ')),
      );
    overlay.append(
      h(
        'div',
        { class: 'dialog narrow' },
        h('h2', null, 'Import from CamPod'),
        h('p', { class: 'muted' }, 'Pick a recording. Its camera files are copied into the episode folder, added as cameras and synced to a microphone recording.'),
        list.length ? h('div', { class: 'campod-sessions' }, ...sorted.map(row)) : h('p', null, 'CamPod has no recordings yet.'),
        h('div', { class: 'row end' }, h('button', { onclick: () => done(null) }, 'Cancel')),
      ),
    );
    document.body.append(overlay);
  });
}

export async function importFromCamPod(): Promise<void> {
  if (store.transport.state === 'recording') return toast('Stop recording before importing');
  const settings = await api().getCamPodSettings();
  if (!settings.url) {
    toast('Set up CamPod first: Edit › Settings › Cameras');
    window.dispatchEvent(new CustomEvent('wavepod:open-settings', { detail: 'cameras' }));
    return;
  }
  let list: CamPodSessionInfo[];
  try {
    list = await api().camPodSessions();
  } catch (e) {
    return toast(errorMessage(e), 'error');
  }
  const name = await pickSession(list);
  if (!name) return;

  const busy = busyDialog('Downloading from CamPod');
  busy.status.textContent = 'Asking CamPod for the files…';
  const cancel = busy.el.querySelector('button');
  cancel?.addEventListener('click', () => void api().camPodCancelDownload());
  const off = api().onCamPod((e: CamPodEvent) => {
    if (e.kind !== 'download') return;
    busy.status.textContent = `${e.file} (${e.index + 1} of ${e.count}): ${Math.round(e.fraction * 100)} %`;
    busy.bar.style.width = `${Math.round(((e.index + e.fraction) / e.count) * 100)}%`;
  });
  let result: Awaited<ReturnType<ReturnType<typeof api>['camPodDownload']>>;
  try {
    result = await api().camPodDownload(name);
  } catch (e) {
    if (errorMessage(e) !== 'cancelled') toast(`Could not download from CamPod: ${errorMessage(e)}`, 'error');
    else toast('Download cancelled. Import again to continue where it stopped.');
    return;
  } finally {
    off();
    busy.el.remove();
  }

  const added: string[] = [];
  for (const f of result.files) {
    if ((store.project.cameras?.length ?? 0) >= MAX_CAMERAS) {
      toast(`An episode can have up to ${MAX_CAMERAS} cameras`, 'error');
      break;
    }
    // a file imported before is not added twice
    if (store.project.cameras?.some((c) => c.file === f.path)) continue;
    const id = await importVideo(f.path, { name: f.camera, at: f.start, quiet: true });
    if (!id) break;
    added.push(id);
  }
  for (const s of result.skipped) toast(`Not imported: ${s}`, 'error');
  if (!added.length) {
    if (!result.files.length && !result.skipped.length) toast('This CamPod recording has no camera files');
    else if (result.files.length && !result.skipped.length) toast('These cameras are already in the episode');
    return;
  }
  toast(`Added ${added.length} camera${added.length === 1 ? '' : 's'} from CamPod`);
  // line them up with the microphones right away, when there are any
  const hasMics = store.project.tracks.some((t) => !t.cameraId && t.kind !== 'soundboard' && t.clips.length);
  if (hasMics) await syncAllCameras(added);
  else toast('Record or import the microphones, then sync the cameras: Video › Sync All Cameras…');
}
