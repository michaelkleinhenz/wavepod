# Exporting

**File › Export…** (`Ctrl+E`) turns the episode into files you can publish: the finished mix, chapter files, and if you need them, stems. The export uses exactly what you hear: every cut, fade, volume line, filter, ducking and automix.

The dialog is laid out in two columns like the export dialogs of other audio programs: on the left what to export, where the files go and the stems, on the right the format and the loudness. **Export** is at the bottom right. In a narrow window the two columns stack.

## What to export

Under **Range**, pick the part of the episode. Each choice shows where it lies and how long it is.

| Choice | Exports |
| --- | --- |
| **Whole episode** | Everything from 0:00 to the end. |
| **Selected range** | Just the time range selected on the timeline (select it before opening the dialog). |
| **Region** | One [region](chapters.md#regions), picked from the list next to it. |
| **Each region as its own file** | Every region separately, each normalised on its own. |

### Exporting one region

To export a single region, for example the bonus segment for supporters or one of two episodes recorded in one session:

- in the **Chapters** view, click **Export…** in the region's row of the **Regions** list,
- or right-click the region on the ruler › **Export Region…**,
- or open **File › Export…** and pick **Region** and the region in the list.

The dialog opens with that region chosen and the file named after the episode and the region, for example *Episode 12 - Bonus*. Chapter markers inside the region become the file's chapters, timed from the region's start.

## File name and folder

**File name** is the name of the files without the extension. It starts as the episode title (plus the region's title for one region); type your own, and **Reset** goes back to the title. When you export each region as its own file, every file gets the region's number and title added: *Episode 12 - 01 Intro*, *Episode 12 - 02 Interview*.

**Folder** is where the files go: by default the episode's `export/` folder. Click **Browse…** to pick another one, or type a path. The folder is kept for the episode while WavePod is open.

**Writes** lists the files the export will create, so you can see the names before you start. If any of them is already there, the dialog asks whether to **Replace** them or go back.

## Formats

Tick one or more formats; the quality setting appears next to the ones that have one:

| Format | Notes |
| --- | --- |
| **MP3** | The usual podcast format. Chapters (with titles, links and images), episode details and the cover are embedded. Pick the bitrate next to it. |
| **FLAC 24-bit** | Lossless and about half the size of WAV, with chapters, tags and cover. |
| **Opus** | Very small files at good quality, with chapters, tags and cover. Pick the bitrate next to it; the list shows which MP3 bitrate it compares to. |
| **WAV 24-bit** | Uncompressed, for archiving or further processing. |

More options:

- **Channels**: **Stereo**, or **Mono (half the size, for speech)**, which writes the mix files with one channel instead of two. For a show that is only voices, mono sounds the same and the file is half the size, or you can use the bytes for better quality (64 kbps mono is like 128 kbps stereo). Choosing mono moves a −16 LUFS target to −19 LUFS, the mono podcast target: a mono file is measured as mono, so it reads 3 LU lower than the same audio in stereo, and −19 LUFS in mono plays as loud as −16 LUFS in stereo. Stems stay stereo.
- **Also write › Chapter files (PSC, JSON, mp4chaps, Audacity labels)**: writes the chapters as Podlove Simple Chapters (XML), Podcasting 2.0 JSON, mp4chaps text and Audacity labels, for your podcast host or website.
- **Also write › Stems**: see [Stems](#stems).
- **Video › MP4 video** (only in episodes with [cameras](video.md)): also writes an MP4 of the cameras, switched as in the director lane, with the same mix as its sound. Pick the size, frame rate, quality and video format next to it. One export then gives you the audio files for your podcast host and the video for YouTube or another video host. See [Export the video](video.md#export-the-video).

Click **Export**. While it runs, the dialog shows the progress; when it is done, it shows the files in your file manager if **Show files when done** is ticked (the box is remembered), and **Show in Folder** opens the folder later. `Esc` or **Cancel** closes the dialog without exporting.

### Your export settings are remembered

When you export, WavePod saves your choices (formats, bitrates, channels, chapter files, stems, loudness target and ceiling) with the episode, so its next export starts the same way. A [template](episodes.md#templates) saved from the episode keeps them too, so every new episode of the show exports the way the show always does. An episode that was never exported starts with the settings of your last export on this computer, and the very first time with one MP3 at 128 kbps, normalised to −16 LUFS, with chapter files.

## Loudness

Tick **Normalise** and pick the **Target** (−14, −16, −19 or −23 LUFS, or **Custom…** to type your own) and the **Peak ceiling**. The mix is brought to the target; where peaks would go over the ceiling, a true-peak limiter holds them so the target is still reached. See [Loudness](loudness.md).

**Analyse Loudness** measures the mix before exporting, so you can see where you stand.

## While exporting

The progress bar is the waveform of the mix as it is rendered. Next to it, live tiles show:

- **Momentary**: loudness of the last 400 ms,
- **Short-term**: loudness of the last 3 seconds,
- **Integrated so far**: the programme loudness from the start up to here,
- **True peak so far**: the highest peak up to here.

With **MP4 video** ticked, the video is rendered after the audio files, and the dialog shows its picture as it is written. **Cancel Video** stops it; the audio files are already written and no half-written video is left behind.

When it is finished, the dialog shows how many files were written and the final loudness figures.

## Stems

Stems are the parts of the mix as separate files, for editing elsewhere or for delivery to broadcasters and festivals. Tick **Also write › Stems** and choose:

- **One file per track**: every track with clips on its own, at the same gain as in the mix.
- **Dialogue, music and effects**: one file each for dialogue, music and effects, with ducking and automix as you hear them, so together they add up to the mix. Pick the stem of each track in the list; WavePod guesses it from the track's and folder's names and settings (marked *guessed*) until you choose. Your choices are saved with the episode. Muted tracks stay out. Tick **Also a music & effects mix (M&E)** for versions in other languages.

**Stem format** is WAV 24-bit or FLAC 24-bit. The master filters are not applied to stems, so they add up to the mix before the master filters.

## Before you export

The dialog points out things worth fixing first:

- the first chapter doesn't start at 0:00 (with a button to add one),
- a chapter has no title,
- the episode details have no title, podcast name, episode number or description (podcast apps show what the file's tags say),
- no episode cover is set, or the cover can't be read, isn't square, is smaller than 1400 × 1400 px or larger than 3000 × 3000 px (what Apple Podcasts and Spotify ask for).

The tag and cover checks apply when you export MP3, FLAC or Opus; a WAV carries no tags.

Click **Analyse Loudness** and the mix is checked as well:

- it is more than 1 LU off the target, or its peaks go over the ceiling, while **Normalise loudness** is off;
- it is so quiet that normalising would raise it by more than 12 dB, and the room noise with it;
- it has **dead air**: 5 seconds or more of silence. Click a time to close the dialog and put the playhead there.

Set the cover and episode details in the **Chapters** view. See [Chapters and markers](chapters.md#episode-details).

## Send to Auphonic

**File › Send to Auphonic…** creates a multitrack production on auphonic.com, the online post-production service:

- one FLAC per track, with the track's filters and volume rendered in,
- the chapters, the episode details and the cover.

Paste your API key from Auphonic's Account Settings once (**Save key**). Choose one of your multitrack presets (or **No preset** for Auphonic's defaults), and whether to **start the production right away** or review it on the website first. When it is sent, **Open the production on auphonic.com** takes you there.
