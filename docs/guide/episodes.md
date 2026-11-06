# Episodes and saving

Each episode is a folder on your disk. It holds the project file, the recorded audio and everything you add to the episode, so you can copy, back up or archive it as a whole.

## The Project tab

WavePod always starts on **Setup › Project**. From there you can:

- **Continue with this episode**: the episode you worked on last, with its folder, its number of tracks and clips and whether everything is saved. **Save**, **Save As…** and **Show folder** are here too.
- **Start a new episode**: type a name (it is also the name of the episode's folder) and click **Create empty episode**, or choose one of your templates with **New episode with this setup**.
- **Open an episode**: pick one of the recent episodes in the WavePod folder, or **Open folder…** to open one anywhere else.

An empty new episode takes you to the Audio tab next, to set up your microphones. An opened episode, or one made from a template, takes you straight to **Record & Edit**.

## New and open

| Command | Key | What it does |
| --- | --- | --- |
| **File › New Episode** | `Ctrl+N` | Starts a new, empty episode. |
| **File › New Episode from Template…** | `Shift+Ctrl+N` | Starts a new episode with the tracks, filters and jingles of a template. |
| **File › New Episode from Zencastr ZIP…** | | Builds an episode from a Zencastr recording. See [Zencastr](#zencastr). |
| **File › Open Episode…** | `Ctrl+O` | Opens an episode folder. |
| **File › Show Project Folder** | | Shows the episode's folder in your file manager. |

New episodes go into `Documents/WavePod/`, each in a folder of its own.

## Saving

WavePod saves every change by itself, a moment after you make it. You never lose more than the last fraction of a second, and you don't have to remember to save.

The **save dot** at the top right of the window tells you where things stand:

- **Green:** every change is saved.
- **Amber:** a change is waiting to be written (this takes less than a second).
- **Red:** the episode could not be saved, for example because the disk is full or the folder was removed. Hold the mouse over the dot to see why. WavePod tries again every few seconds; click the dot (or use **File › Save**) to try at once.

**File › Save** (`Ctrl+S`) writes any change still waiting right away. **File › Save As…** (`Shift+Ctrl+S`) copies the whole episode, audio included, into a new folder next to the current one under a new name, and you continue working in the copy. Save As is not possible while recording.

## Undo and redo

**Edit › Undo** (`Ctrl+Z`) and **Edit › Redo** (`Shift+Ctrl+Z`) work for every edit: cuts, moves, fades, filters, markers, chapter texts and changes an AI agent made. Undo history lasts until you close the episode.

## Templates

A template stores how an episode is set up, so the next one starts ready to record:

- the tracks with their names, colours, folders and input channels,
- every filter stack including Master FX and VST3 plug-in settings,
- the soundboard jingles.

A template holds no recordings, markers, volume lines or automation.

- **File › Save as Template…** saves the current episode's setup. Give it a name; an existing name can be replaced.
- **File › New Episode from Template…** (`Shift+Ctrl+N`), or the template list on **Setup › Project**, starts a new episode from it.
- **File › Show Templates Folder** opens `Documents/WavePod/Templates/`. Each template is a folder with a `template.json` and copies of its jingles, so you can copy a template to another computer. Input channels are matched by number, so a template fits best on the same audio interface.

## Importing audio

**File › Import Audio…** (`Ctrl+I`) adds audio files as new tracks at the playhead. You can also drag files from your file manager straight onto the timeline: onto a track to add them there, or below the tracks for new tracks. See [Editing clips](editing.md#dropping-files-on-the-timeline).

WAV, AIFF, MP3, M4A/AAC, Ogg, Opus, FLAC and WebM files can be imported. Imported audio is copied into the episode's `media/` folder.

## Zencastr

**File › New Episode from Zencastr ZIP…** turns a session downloaded from Zencastr (Library › Recordings › Download) into a new episode:

- one track per participant, using the WAV file when the ZIP has both WAV and MP3,
- the soundboard recording on the Soundboard track,
- everything starting at 0, as in the session.

When someone left and rejoined, their parts are placed one after the other on their track, at the times in the file names. Transcripts, video and post-production mixes in the ZIP are left out.

## Backups

WavePod keeps backups of the project file (not the audio, which is never changed) in the episode's `backup/` folder:

- every 10 minutes while something changed,
- before every recording,
- before restoring a backup, and before repairing an interrupted recording.

The newest 20 are kept. **File › Restore Backup…** lets you pick one and brings the episode back to that state. Restoring is one undo step, so `Ctrl+Z` takes you back to where you were.

## What is in an episode folder

| File or folder | Contains |
| --- | --- |
| `project.json` | Tracks, clips, edits, markers, filters, metadata: the episode itself. |
| `media/` | The recorded and imported audio (WAV files), with `.peaks` files that make waveforms draw fast. |
| `sounds/` | Copies of the soundboard jingles. |
| `images/` | The episode cover and chapter images. |
| `transcripts/` | Transcripts, one per recorded file. |
| `backup/` | Backups of `project.json`. |
| `export/` | Where exports go by default. |

> **Tip:** Recorded audio files are never changed by editing. Cuts, fades and filters are only instructions in `project.json`, so you can always undo or go back to a backup.

## Coming from SoundPod

WavePod used to be called SoundPod. If you still have a `Documents/SoundPod` folder and no `Documents/WavePod`, WavePod keeps using the old folder with its episodes and templates. Settings such as your devices and MIDI mappings are copied over on the first start.
