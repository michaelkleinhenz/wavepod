// The keyboard shortcut overlay (`?` or Help › Keyboard Shortcuts).
import { h } from './dom';

const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

export const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    'Recording',
    [
      ['R', 'Record / stop recording'],
      ['Space', 'Play / stop'],
      ['M', 'Chapter marker at the playhead'],
      ['Shift+M', 'Chapter marker with a title'],
      ['E', 'Edit marker (something to fix later)'],
      ['Shift+1…9', 'Cough button: hold to mute track 1…9'],
      ['1…9', 'Play soundboard slot'],
      ['Y', 'Jump to where recording is'],
      ['Esc', 'Stop sounds, clear the selection'],
    ],
  ],
  [
    'Navigation',
    [
      ['← / →', 'Back / forward 1 s (Shift: 10 s)'],
      ['Alt+← / →', 'Previous / next clip edge'],
      ['Shift+Alt+← / →', 'Previous / next marker'],
      ['Home / End', 'Start / end of the episode'],
      ['+ / −', 'Zoom in / out'],
      ['Shift+Z', 'Zoom to the selection and back'],
      ['Middle drag', 'Pan the view'],
    ],
  ],
  [
    'Editing',
    [
      ['S', 'Split at the playhead'],
      ['F', 'Fade the selected clips'],
      ['P', 'Preview: play across the selection as if it were cut'],
      ['L', 'Repeat: loop playback of the selection'],
      [`${mod}+X`, 'Ripple cut (closes the gap)'],
      [`${mod}+C / ${mod}+V`, 'Copy / paste at the playhead'],
      [`${mod}+Shift+V`, 'Paste and move later material'],
      [`${mod}+Y`, 'Mute the selected range'],
      ['Delete', 'Delete selection (Shift: and close the gap)'],
      [`${mod}+A`, 'Select all clips'],
      ['Shift+drag', 'Select every clip in the rectangle'],
      ['Shift+click clip', 'Add it to the selection or take it out'],
      [`${mod}+Z / ${mod}+Shift+Z`, 'Undo / redo'],
      ['Alt+Shift+N', 'Normalise clip loudness'],
      ['Alt (while dragging)', 'Drag without snapping'],
      [`${mod}+drag clip`, 'Move it with everything after it on the track'],
      [`${mod}+Shift+drag clip`, 'Move it with everything after it on all tracks'],
      ['Double-click fade', 'Change the fade shape'],
      ['Right-click clip', 'Colour and note'],
    ],
  ],
  [
    'Episode',
    [
      [`${mod}+N`, 'New episode'],
      [`${mod}+O`, 'Open episode'],
      [`${mod}+I`, 'Import audio'],
      [`${mod}+E`, 'Export'],
      [`${mod}+1 / 2 / 3`, 'Setup / Record & Edit / Chapters'],
      ['?', 'This list'],
    ],
  ],
];

export function showShortcuts(): void {
  if (document.querySelector('.overlay.shortcuts')) return;
  const overlay = h('div', { class: 'overlay shortcuts' });
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  overlay.append(
    h(
      'div',
      { class: 'dialog shortcut-dialog' },
      h('h2', null, 'Keyboard shortcuts'),
      h(
        'div',
        { class: 'shortcut-groups' },
        ...SHORTCUTS.map(([group, keys]) =>
          h('section', null, h('h3', null, group), h('dl', null, ...keys.flatMap(([k, what]) => [h('dt', null, h('kbd', null, k)), h('dd', null, what)]))),
        ),
      ),
      h('div', { class: 'row end' }, h('button', { onclick: close }, 'Close')),
    ),
  );
  document.body.append(overlay);
}
