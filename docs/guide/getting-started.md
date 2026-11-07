# Getting started

WavePod is a multitrack recorder and editor made for podcasts and audio dramas. It records every speaker on a track of their own, lets you cut the conversation like a document and exports a finished episode with chapters, cover and the right loudness.

This guide explains every part of the app. Use the search field at the top left to find a topic, or press `F1` anywhere in WavePod to open the page that fits what you are doing.

## Beta software

WavePod is beta software that is still being tested, so the first time it starts it shows a notice about it. Please take it seriously: **always make a backup recording** of every show with something else, for example directly on your hardware mixer or audio interface (many record to an SD card or USB stick) or with a second recorder.

WavePod does a lot to keep a take safe: it writes every take to disk as it happens and recovers it after a crash, detects dropouts, crackle and a full disk while you record, and raises a loud alarm with a system notification when the input device is lost (see [Recording safety](recording.md#recording-safety)). But while WavePod is in beta, anything can still happen. Read the notice again any time under **Help › Beta Notice**.

## Your first episode in five steps

1. **Name the episode.** WavePod opens on **Setup › Project**. Type a name under **Start a new episode** and create it, or pick a template to start with your usual tracks and filters. See [Episodes and saving](episodes.md).
2. **Choose your audio interface.** On **Setup › Audio**, pick the device under **Record from** and your headphones under **Listen on**. Speak into each microphone and watch the meters. See [Audio setup](audio-setup.md).
3. **Create speaker tracks.** Click **Create speaker tracks**: every microphone and remote guest gets its own armed track.
4. **Record.** Switch to **Record & Edit** (`Ctrl+2`) and press `R`. Press `M` for a chapter marker, `E` to mark a spot to fix later, and hold `Shift+1` to cough without being heard. Press `R` again to stop. See [Recording](recording.md).
5. **Edit and export.** Cut, fade and level the episode (see [Editing clips](editing.md)), add chapter titles in **Chapters** (`Ctrl+3`), then use **File › Export…** (`Ctrl+E`). See [Exporting](export.md).

> **Tip:** No audio interface at hand? WavePod works with virtual devices too, so you can try editing with imported audio files first: **File › Import Audio…** (`Ctrl+I`) or drag files onto the timeline.

## The three views

WavePod has three views. Switch between them with the tabs at the top left or with `Ctrl+1`, `Ctrl+2` and `Ctrl+3`.

| View | What you do there |
| --- | --- |
| **Setup** (`Ctrl+1`) | Choose or create an episode (Project tab), pick your audio interface, check levels and create tracks (Audio tab). |
| **Record & Edit** (`Ctrl+2`) | Record, play, cut and mix on the timeline. Filters, the transcript and the sound library open at the side. |
| **Chapters** (`Ctrl+3`) | Chapter titles, links and images, edit markers, regions and the episode details (title, cover, description). |

## The header

The bar at the top is always there:

- **Transport:** Record (`R`), Play / Pause (`Space`), Stop, Repeat (`L`) and To start (`Home`).
- **Playback speed:** listen faster without changing pitch. See [Navigating the timeline](timeline.md#playback-speed).
- **Time display** with the master output meter inside it.
- **Master FX** opens the filters on the master bus. See [Filters and effects](filters.md).
- **Transcript** and **Sounds** open the side panels. See [Transcript and text editing](transcript.md) and [Audio drama](audio-drama.md#sound-library).
- **Pre-show** plays only the soundboard, for waiting music before the show. See [Recording](recording.md#pre-show).
- The **save dot** at the right is green when every change is saved. See [Episodes and saving](episodes.md#saving).

## Menus

On Windows and Linux the menu bar sits at the top of the window; on macOS it is in the system menu bar. Every menu command is described in this guide; search for its name to find it.

On macOS, read `Ctrl` as `⌘` (Command) throughout this guide. The help window shows the right key for your computer.

## Getting help

- **Help › WavePod Help** (`F1`) opens this guide at the page for the view, panel or dialog you are in. **Help › Getting Started** opens this page.
- **Help › Keyboard Shortcuts** (or `?` in the main window) shows every key at a glance. The same list is in this guide under [Keyboard shortcuts](shortcuts.md).
- Most buttons explain themselves when you hold the mouse over them.
- Something not working? See [Troubleshooting](troubleshooting.md), also under **Help › Troubleshooting**.
- **Help › Beta Notice** shows the beta warning from the first start again. See [Beta software](#beta-software).
- **Help › Report a Problem…** opens WavePod's issue tracker on GitHub in your browser.
- **Help › About WavePod** (on macOS: **WavePod › About WavePod**) shows the version and the runtime details. **Copy version info** copies them for a bug report.
