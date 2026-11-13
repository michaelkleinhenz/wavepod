// Picking the camera for the eye-contact video of remote guests (host window and guest page).
// Browsers name cameras only once the page may use one, so unnamed cameras get a number.

const KEY = 'wavepod-remote-camera';

export interface CameraChoice {
  id: string;
  label: string;
}

/** The cameras the browser offers, in its order. */
export async function listCameras(): Promise<CameraChoice[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return cameraChoices(all);
  } catch {
    return [];
  }
}

export function cameraChoices(devices: Array<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>>): CameraChoice[] {
  const cams = devices.filter((d) => d.kind === 'videoinput');
  // before permission, browsers list one camera with an empty id: nothing to choose yet
  if (cams.length === 1 && !cams[0].deviceId) return [];
  return cams.filter((d) => d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** The camera picked last time on this computer, if it is still there. */
export function savedCamera(cams: CameraChoice[]): string {
  let id = '';
  try {
    id = localStorage.getItem(KEY) ?? '';
  } catch {
    /* no storage */
  }
  return cams.some((c) => c.id === id) ? id : '';
}

export function saveCamera(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* no storage */
  }
}
