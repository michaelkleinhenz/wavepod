// Context help: F1 (Help › WavePod Help) opens the user guide at the page for what is on screen.
import { helpTopicFor, type HelpContext } from '../help/context';
import { api, store } from './store';

/** What is on screen now, read from the page. */
function currentContext(): HelpContext {
  const overlays = document.querySelectorAll<HTMLElement>('.overlay');
  const top = overlays[overlays.length - 1];
  const dialog = top?.querySelector('h2')?.textContent ?? null;
  const tab = (top ?? document).querySelector('.setup-tab.active')?.textContent ?? null;
  const panel = document.querySelector('.fx-panel')?.isConnected
    ? 'fx'
    : document.querySelector('.transcript-panel')
      ? 'transcript'
      : document.querySelector('.library-panel')
        ? 'library'
        : document.querySelector('.script-panel')
          ? 'script'
          : document.querySelector('.video-panel')
            ? 'video'
            : null;
  return { dialog, tab, view: store.view, panel, recording: store.transport?.state === 'recording' };
}

/** Opens the user guide at the page for what is on screen. */
export function openContextHelp(): void {
  void api().openHelp(helpTopicFor(currentContext()));
}
