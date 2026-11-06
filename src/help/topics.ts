// The pages of the user guide, in reading order and grouped for the contents list. The pages are
// the Markdown files in docs/guide/, so they read the same on GitHub; the keyboard shortcuts page
// is generated from the same list as the shortcut overlay, so it can't go out of date.
import gettingStarted from '../../docs/guide/getting-started.md';
import episodes from '../../docs/guide/episodes.md';
import audioSetup from '../../docs/guide/audio-setup.md';
import recording from '../../docs/guide/recording.md';
import timeline from '../../docs/guide/timeline.md';
import editing from '../../docs/guide/editing.md';
import tracksMixing from '../../docs/guide/tracks-mixing.md';
import filters from '../../docs/guide/filters.md';
import audioDrama from '../../docs/guide/audio-drama.md';
import transcript from '../../docs/guide/transcript.md';
import chapters from '../../docs/guide/chapters.md';
import loudness from '../../docs/guide/loudness.md';
import exportPage from '../../docs/guide/export.md';
import controllers from '../../docs/guide/controllers.md';
import aiAgents from '../../docs/guide/ai-agents.md';
import settings from '../../docs/guide/settings.md';
import troubleshooting from '../../docs/guide/troubleshooting.md';
import { SHORTCUTS } from '../renderer/shortcuts';

export interface Topic {
  /** The page's file name without `.md`; also its address in the help window (`#editing/fades`). */
  id: string;
  group: string;
  markdown: string;
}

/** Markdown for the keyboard shortcuts page. */
export function shortcutsMarkdown(groups: typeof SHORTCUTS = SHORTCUTS): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const parts = [
    '# Keyboard shortcuts',
    'Every key at a glance. Press `?` in the main window (or use **Help › Keyboard Shortcuts**) to see this list over the app. Menu commands show their keys in the menus too.',
  ];
  for (const [group, keys] of groups) {
    parts.push(`## ${group}`, '| Key | Does |\n| --- | --- |\n' + keys.map(([k, what]) => `| \`${cell(k)}\` | ${cell(what)} |`).join('\n'));
  }
  return parts.join('\n\n');
}

export const TOPICS: Topic[] = [
  { id: 'getting-started', group: 'Basics', markdown: gettingStarted },
  { id: 'episodes', group: 'Basics', markdown: episodes },
  { id: 'audio-setup', group: 'Basics', markdown: audioSetup },
  { id: 'recording', group: 'Recording and editing', markdown: recording },
  { id: 'timeline', group: 'Recording and editing', markdown: timeline },
  { id: 'editing', group: 'Recording and editing', markdown: editing },
  { id: 'tracks-mixing', group: 'Recording and editing', markdown: tracksMixing },
  { id: 'filters', group: 'Sound', markdown: filters },
  { id: 'audio-drama', group: 'Sound', markdown: audioDrama },
  { id: 'transcript', group: 'Sound', markdown: transcript },
  { id: 'chapters', group: 'Publishing', markdown: chapters },
  { id: 'loudness', group: 'Publishing', markdown: loudness },
  { id: 'export', group: 'Publishing', markdown: exportPage },
  { id: 'controllers', group: 'More', markdown: controllers },
  { id: 'ai-agents', group: 'More', markdown: aiAgents },
  { id: 'settings', group: 'More', markdown: settings },
  { id: 'shortcuts', group: 'More', markdown: shortcutsMarkdown() },
  { id: 'troubleshooting', group: 'More', markdown: troubleshooting },
];

export const DEFAULT_TOPIC = 'getting-started';

/**
 * Where a link in the guide points, as a help address (`topic` or `topic/anchor`), or null for a
 * link that leaves the guide. `current` is the page the link is on, for `#anchor` links.
 */
export function resolveLink(href: string, current: string): string | null {
  if (/^[a-z]+:/i.test(href)) return null;
  const m = /^(?:\.\/)?([\w-]*)(?:\.md)?(?:#([\w-]+))?$/.exec(href);
  if (!m) return null;
  const topic = m[1] || current;
  return m[2] ? `${topic}/${m[2]}` : topic;
}
