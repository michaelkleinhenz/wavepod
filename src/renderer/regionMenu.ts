// Regions on the ruler: right-click menu and the inline name field (double-click a region's name).
import type { Frames, Region } from '../shared/types';
import { MAX_REGION_TITLE, removeRegion, renameRegion } from '../core/regions';
import { showContextMenu } from './contextMenu';
import { h } from './dom';
import { store } from './store';

export interface RegionMenuOptions {
  region: Region;
  pageX: number;
  pageY: number;
  zoomTo: (span: [Frames, Frames]) => void;
}

function selectRange(r: Region): void {
  store.select({ range: [r.start, r.end], rangeTracks: null, clipIds: new Set(), markerId: null, muteRegion: null });
}

export function openRegionMenu(o: RegionMenuOptions): void {
  const r = o.region;
  const recording = store.transport.state === 'recording';
  showContextMenu(
    [
      { kind: 'header', label: r.title || 'Region' },
      { label: 'Rename…', enabled: !recording, run: () => promptRegionName(r.id, o.pageX, o.pageY) },
      { label: 'Select range', run: () => selectRange(r) },
      { label: 'Zoom to region', run: () => o.zoomTo([r.start, r.end]) },
      { label: 'Show in Chapters view', title: 'Change start and end in the Regions list', run: () => store.setView('chapters') },
      { kind: 'separator' },
      { label: 'Delete region', enabled: !recording, title: 'Removes only the region, not the audio', run: () => store.edit((p) => removeRegion(p, r.id)) },
    ],
    o.pageX,
    o.pageY,
  );
}

/** A small field at the page position to type the region's name in (Enter or leaving it applies, Esc cancels). */
export function promptRegionName(id: string, x: number, y: number): void {
  document.querySelector('.gain-prompt')?.remove();
  const region = store.project.regions?.find((r) => r.id === id);
  if (!region) return;
  const input = h('input', { class: 'clip-name-input', value: region.title, maxlength: MAX_REGION_TITLE, spellcheck: false, placeholder: 'Region name' }) as HTMLInputElement;
  let done = false;
  const close = (apply: boolean) => {
    if (done) return;
    done = true;
    box.remove();
    if (!apply) return;
    const current = store.project.regions?.find((r) => r.id === id);
    if (!current || input.value.replace(/\s+/g, ' ').trim() === current.title) return;
    store.edit((p) => renameRegion(p, id, input.value));
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') close(true);
    else if (e.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  const box = h(
    'div',
    { class: 'title-prompt gain-prompt clip-name-prompt region-name-prompt', style: { left: `${Math.max(0, Math.min(x, window.innerWidth - 420))}px`, top: `${Math.max(0, Math.min(y, window.innerHeight - 60))}px`, transform: 'none' } },
    h('span', { class: 'muted' }, 'Region name'),
    input,
  );
  document.body.append(box);
  input.focus();
  input.select();
}
