# WavePod user guide

These pages are the help that WavePod shows under **Help › WavePod Help** (`F1`). In the app they
come with a contents list, full-text search and the keyboard shortcuts page; here they read as
plain Markdown.

**Basics**

- [Getting started](getting-started.md)
- [Episodes and saving](episodes.md)
- [Audio setup](audio-setup.md)

**Recording and editing**

- [Recording](recording.md)
- [Navigating the timeline](timeline.md)
- [Editing clips](editing.md)
- [Tracks and mixing](tracks-mixing.md)
- [Remote guests](remote-guests.md)

**Sound**

- [Filters and effects](filters.md)
- [Audio drama](audio-drama.md)
- [Transcript and text editing](transcript.md)

**Publishing**

- [Chapters and markers](chapters.md)
- [Loudness](loudness.md)
- [Exporting](export.md)

**More**

- [MIDI and remote control](controllers.md)
- [AI agents (MCP)](ai-agents.md)
- [Settings](settings.md)
- Keyboard shortcuts (generated in the app from `src/renderer/shortcuts.ts`)
- [Troubleshooting](troubleshooting.md)

## Editing the guide

- One page per file; the first `# Heading` is the page title, and `##` headings are its sections
  (they appear in the contents list and are what search results point to).
- Link to other pages as `[Exporting](export.md)` or to a section as `[Stems](export.md#stems)`;
  the section id is the heading in lower case with dashes, as on GitHub.
- Write keys in backticks with `Ctrl` (`` `Shift+Ctrl+S` ``); on macOS the help window shows `⌘`.
- A new page is registered in `src/help/topics.ts`. `test/help.test.ts` checks that every link
  resolves and that every menu command, built-in filter, voice effect and MCP tool is described,
  so a new feature needs a line in the guide.
- The [GitHub wiki](https://github.com/michaelkleinhenz/wavepod/wiki) is built from these pages by
  `.github/workflows/wiki.yml` on every push to `main` (`make wiki` previews it in `dist/wiki`).
  Don't edit the wiki itself; changes there are overwritten.
