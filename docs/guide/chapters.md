# Chapters and markers

Markers are pins on the timeline. **Chapter markers** become the chapters listeners see in their podcast app. **Edit markers** are notes to yourself about things to fix; they are never exported. The **Chapters** view (`Ctrl+3`) lists both and holds the episode's details.

## Adding markers

- `M` drops a chapter marker at the playhead, while recording or playing. `Shift+M` asks for its title right away.
- `E` drops an edit marker.
- The **Chapter marker** and **Edit marker** buttons in the timeline toolbar do the same.
- A MIDI controller or a Stream Deck can drop both. See [MIDI and remote control](controllers.md).

Recording problems such as dropouts are marked with ⚠ edit markers automatically. See [Recording](recording.md#problem-warnings).

## Markers on the timeline

Markers show on the lower half of the ruler with their titles. A title that would run into the next marker is cut short; hold the mouse over it to read it all.

- **Drag a marker** along the ruler to move it. It snaps like everything else; hold `Alt` to move it freely.
- **Double-click a marker** to edit it in the Chapters view.
- `Shift+Alt+←` and `Shift+Alt+→` jump to the previous and next marker.
- Click a marker and press `Delete` to remove it.

Ripple cuts and ripple moves take markers along.

## The Chapters view

### Chapters

The table lists every chapter with its **start time**, **title**, **link** and **image**.

- Click a time to change it (type `HH:MM:SS.mmm`), or a title or link to edit it.
- **Image…** gives a chapter its own picture (JPEG or PNG). Podcast apps that support it show it during that chapter. The picker opens in the folder you used last.
- **▶** jumps to the marker on the timeline; **×** deletes it.
- **Drag the grip** (⋮⋮), or use **↑** and **↓**, to move a chapter's title, link and image to another chapter. The start times stay where they are. Use it when you typed the titles in the wrong order.

### Importing chapters

- **Import…** (also **File › Import Chapters…**) loads chapters with their times from a chapter file: Podlove Simple Chapters (XML), Podcasting 2.0 JSON, mp4chaps or Audacity labels.
- **Import titles…** fills the existing chapters, in order, from a text file with one line per chapter: `title`, `title;link` or `title;link;image.jpg`. The start times stay. Images are loaded from the same folder as the text file and copied into the episode; a chapter without an image in the list keeps its image.

### Edit markers

Below the chapters, the edit markers are listed with their time and a note. **→ chapter** turns an edit marker into a chapter marker, **▶** jumps to it and **×** removes it.

## Episode details

The **Episode** section holds what goes into the exported file's tags:

- **Episode title**, **Podcast**, **Author**, **Episode number**, **Year**
- **Category**: written into MP3 and FLAC as the genre. Pick a podcast directory category or type your own.
- **Description**
- **Episode cover**: a square JPEG or PNG, ideally 1400–3000 px. It is embedded in exported MP3, FLAC and Opus files and shown by podcast apps that read it.

## Regions

A region is a named part of the episode, for example two episodes recorded in one session, or the bonus segment for supporters.

1. Select a time range.
2. Click **Region from selection** in the timeline toolbar (or right-click a clip › **Region from clip**).

Regions show on the ruler and are listed in the Chapters view, where you can rename them and change their start and end. **Select on the timeline** selects a region's range, **Export…** exports just that region, and **×** deletes it.

### Renaming regions

New regions are called *Part 1*, *Part 2* and so on. To give one a name:

- **Double-click the region's name** on the ruler, type the new name and press `Enter` (`Esc` keeps the old name).
- Or **right-click the region** on the ruler › **Rename…**.
- Or type in its **Title** field in the Chapters view.

Clearing the name gives the region its *Part n* name back. The name is used for the [exported file](export.md#what-to-export).

Right-clicking a region on the ruler also offers **Select range**, **Zoom to region**, **Export Region…**, **Show in Chapters view** and **Delete region** (which removes only the region, not the audio). Double-clicking a region anywhere but its name selects its time range.

The export can write one region, or each region as its own file. See [Exporting one region](export.md#exporting-one-region).

## Checks before export

The export dialog warns you when the first chapter doesn't start at 0:00 (podcast apps show no chapter before it, and it offers to add one) and when a chapter has no title. It also checks the [episode details](#episode-details) and the cover (missing title, podcast name, episode number or description; a cover that isn't square or is outside 1400 to 3000 px) and, after **Analyse loudness**, the loudness and dead air. See [Before you export](export.md#before-you-export).
