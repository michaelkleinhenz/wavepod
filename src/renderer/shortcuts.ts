// The keyboard shortcut overlay (`?` or Help › Keyboard Shortcuts). The same list is a page of the
// user guide (src/help/topics.ts), so keep the descriptions self-explanatory.
import { h } from './dom';

const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

export const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    'Recording',
    [
      ['R', 'Record / stop recording'],
      ['Shift+R', 'Punch in: re-record the selection on the armed tracks, with pre-roll'],
      ['Alt+Shift+R', 'Loop-record the selected time range: every pass becomes a take'],
      ['T / Shift+T', 'Next / previous take at the playhead'],
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
      ['> / <', 'Play faster / slower (pitch kept, up to 3×)'],
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
      ['G', 'Fuse the selected clips into one (one clip: with the next one)'],
      ['P', 'Preview: play 2 s around the playhead, then go back (check a cut)'],
      ['L', 'Repeat: loop playback of the selection'],
      [`Shift+${mod}+T`, 'Transcript: click a word to jump, drag to select, Delete cuts, Enter or double-click changes the words (experimental)'],
      [`Shift+${mod}+B`, 'Sound library: type to search, ↑/↓ listen, Enter inserts at the playhead'],
      [`Shift+${mod}+J`, 'Script: ↑/↓ pick a line, Enter ticks it off at the playhead and goes to the next, Shift+Enter jumps to its take'],
      [`Shift+${mod}+K`, 'Clean up pauses, hesitations and retakes'],
      [`Shift+${mod}+G`, 'Remote guests: invite guests, let them in, see their connection and uploads'],
      [`${mod}+,`, 'Settings (ElevenLabs API key for transcripts)'],
      [`${mod}+X`, 'Ripple cut (closes the gap)'],
      [`${mod}+C / ${mod}+V`, 'Copy / paste at the playhead'],
      [`${mod}+Shift+V`, 'Paste and move later material'],
      [`${mod}+Y`, 'Mute the selected range'],
      ['Delete', 'Delete selection (Shift: and close the gap)'],
      [`${mod}+A`, 'Select all clips'],
      ['Shift+drag', 'Select every clip in the rectangle'],
      ['Shift+click clip', 'Select every clip from the last clicked one to it (rectangle across tracks)'],
      [`${mod}+Z / ${mod}+Shift+Z`, 'Undo / redo'],
      ['Alt+Shift+N', 'Normalise clip loudness'],
      ['Alt (while dragging)', 'Drag without snapping'],
      [`${mod}+drag clip`, 'Move it with everything after it on the track'],
      [`${mod}+Shift+drag clip`, 'Move it with everything after it on all tracks'],
      ['Double-click fade', 'Change the fade shape'],
      ['Right-click clip', 'Clip menu: split, fuse, copy, duplicate, fades, gain, colour, note…'],
    ],
  ],
  [
    'Video',
    [
      [`Shift+${mod}+U`, 'Cameras panel: program monitor and every camera'],
      ['W', 'Watch through: play in a large view and switch cameras as you watch'],
      ['1…9 (watch through)', 'Switch to camera 1…9 (hold D for a dissolve)'],
      ['Alt+1…9', 'Switch to camera 1…9 at the playhead (also while playing)'],
      [`Shift+${mod}+E`, 'Export video'],
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
      h(
        'div',
        { class: 'row end' },
        h('button', { title: 'Everything WavePod does, explained (F1)', onclick: () => void window.wavepod?.openHelp('getting-started') }, 'User guide…'),
        h('button', { onclick: close }, 'Close'),
      ),
    ),
  );
  document.body.append(overlay);
}
