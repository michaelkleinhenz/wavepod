// Which page of the user guide fits what is on screen: the open dialog first, then a side panel,
// then the view. Used by F1 (Help › WavePod Help) in the main window.

export interface HelpContext {
  /** The title of the open dialog, if any. */
  dialog?: string | null;
  /** The active tab of the dialog or of Setup, if it has tabs. */
  tab?: string | null;
  view: 'setup' | 'edit' | 'chapters';
  /** The side panel open in Record & Edit. */
  panel?: 'fx' | 'transcript' | 'library' | 'script' | null;
  recording?: boolean;
}

/** Dialog titles (their start) and the page that explains them. */
export const DIALOG_TOPICS: Array<[RegExp, string]> = [
  [/^export episode/i, 'export'],
  [/^send to auphonic/i, 'export/send-to-auphonic'],
  [/^loudness analysis/i, 'loudness/loudness-analysis'],
  [/^clean up/i, 'transcript/clean-up-pauses-hesitations-and-retakes'],
  [/^change words/i, 'transcript/changing-words-experimental'],
  [/^(soundcheck|can.t record yet)/i, 'recording/soundcheck'],
  [/^stop recording/i, 'recording/arm-record-stop'],
  [/^keyboard shortcuts/i, 'shortcuts'],
  [/beta software/i, 'getting-started/beta-software'],
  [/(no audio from the input|recording can.t be written|input is back|recording is fine again|^recording stopped$)/i, 'recording/recording-alerts'],
  [/^wavepod$/i, 'getting-started/getting-help'],
  [/template/i, 'episodes/templates'],
  [/backup/i, 'episodes/backups'],
  [/^align/i, 'editing/aligning-recordings'],
  [/^(new episode|save episode as)$/i, 'episodes/saving'],
  [/folder/i, 'tracks-mixing/track-folders'],
];

export const SETTINGS_TABS: Record<string, string> = {
  general: 'settings/general',
  controllers: 'controllers',
  'ai agents': 'ai-agents',
};

/** The help page (`topic` or `topic/anchor`) for what is on screen. */
export function helpTopicFor(ctx: HelpContext): string {
  const dialog = ctx.dialog?.trim();
  if (dialog) {
    if (/^settings/i.test(dialog)) return SETTINGS_TABS[(ctx.tab ?? '').trim().toLowerCase()] ?? 'settings';
    for (const [re, topic] of DIALOG_TOPICS) if (re.test(dialog)) return topic;
  }
  if (ctx.view === 'setup') return (ctx.tab ?? '').trim().toLowerCase() === 'audio' ? 'audio-setup' : 'episodes/the-project-tab';
  if (ctx.view === 'chapters') return 'chapters';
  if (ctx.panel === 'fx') return 'filters';
  if (ctx.panel === 'transcript') return 'transcript';
  if (ctx.panel === 'library') return 'audio-drama/sound-library';
  if (ctx.panel === 'script') return 'audio-drama/script';
  return ctx.recording ? 'recording' : 'timeline';
}
