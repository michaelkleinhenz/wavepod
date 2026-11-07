# Exporting

**File › Export…** (`Ctrl+E`) turns the episode into files you can publish: the finished mix, chapter files, and if you need them, stems. The export uses exactly what you hear: every cut, fade, volume line, filter, ducking and automix.

## Formats

Tick one or more formats:

| Format | Notes |
| --- | --- |
| **MP3 with ID3 chapters** | The usual podcast format. Chapters (with titles, links and images), episode details and the cover are embedded. Pick the **MP3 bitrate**. |
| **WAV 24-bit** | Uncompressed, for archiving or further processing. |
| **FLAC 24-bit** | Lossless and about half the size of WAV, with chapters, tags and cover. |
| **Opus** | Very small files at good quality, with chapters, tags and cover. Pick the **Opus bitrate**; the dialog shows which MP3 bitrate it compares to. |

More options:

- **Mono (half the size, for speech)**: writes the mix files with one channel instead of two. For a show that is only voices, mono sounds the same and the file is half the size, or you can use the bytes for better quality (64 kbps mono is like 128 kbps stereo). Ticking it moves a −16 LUFS target to −19 LUFS, the mono podcast target: a mono file is measured as mono, so it reads 3 LU lower than the same audio in stereo, and −19 LUFS in mono plays as loud as −16 LUFS in stereo. Stems stay stereo.
- **Chapter files (PSC, JSON, mp4chaps, Audacity)**: writes the chapters as Podlove Simple Chapters (XML), Podcasting 2.0 JSON, mp4chaps text and Audacity labels, for your podcast host or website.
- **Stems (separate files for editing or delivery)**: see [Stems](#stems).

Click **Export…** and choose the folder and the base name of the files. By default the export goes into the episode's `export/` folder, named after the episode title. When it is done, WavePod shows the files in your file manager.

### Your export settings are remembered

When you export, WavePod saves your choices (formats, bitrates, mono, chapter files, stems, loudness target and ceiling) with the episode, so its next export starts the same way. A [template](episodes.md#templates) saved from the episode keeps them too, so every new episode of the show exports the way the show always does. An episode that was never exported starts with the settings of your last export on this computer, and the very first time with one MP3 at 128 kbps, normalised to −16 LUFS, with chapter files.

## Loudness

Tick **Normalise loudness** and pick the **Target** (−14, −16, −19 or −23 LUFS, or **Custom…** to type your own) and the **Peak ceiling**. The mix is brought to the target; where peaks would go over the ceiling, a true-peak limiter holds them so the target is still reached. See [Loudness](loudness.md).

**Analyse loudness** measures the mix before exporting, so you can see where you stand.

## While exporting

The progress bar is the waveform of the mix as it is rendered. Next to it, live tiles show:

- **Momentary**: loudness of the last 400 ms,
- **Short-term**: loudness of the last 3 seconds,
- **Integrated so far**: the programme loudness from the start up to here,
- **True peak so far**: the highest peak up to here.

When it is finished, the dialog lists the files and the final loudness figures.

## Parts of the episode

- **Only the selected range** exports just the time range selected on the timeline.
- **Each region as its own file** exports every [region](chapters.md#regions) separately, each normalised on its own and named after the region.

## Stems

Stems are the parts of the mix as separate files, for editing elsewhere or for delivery to broadcasters and festivals. Tick **Stems** and choose:

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

Click **Analyse loudness** and the mix is checked as well:

- it is more than 1 LU off the target, or its peaks go over the ceiling, while **Normalise loudness** is off;
- it is so quiet that normalising would raise it by more than 12 dB, and the room noise with it;
- it has **dead air**: 5 seconds or more of silence. Click a time to close the dialog and put the playhead there.

Set the cover and episode details in the **Chapters** view. See [Chapters and markers](chapters.md#episode-details).

## Send to Auphonic

**File › Send to Auphonic…** creates a multitrack production on auphonic.com, the online post-production service:

- one FLAC per track, with the track's filters and volume rendered in,
- the chapters, the episode details and the cover.

Paste your API key from Auphonic's Account Settings once (**Save key**). Choose one of your multitrack presets (or **No preset** for Auphonic's defaults), and whether to **start the production right away** or review it on the website first. When it is sent, **Open the production on auphonic.com** takes you there.
