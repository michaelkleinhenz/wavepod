# Tracks and mixing

Each speaker, music bed or sound layer has a track. A track records one input (or a stereo pair), holds clips and has its own filters, volume and pan. The master bus sums all tracks into the episode.

## Adding and removing tracks

- **Setup › Audio › Create speaker tracks** makes one track per microphone. See [Audio setup](audio-setup.md#microphones-and-inputs).
- **Add track** in the timeline toolbar adds an empty track.
- Importing or dropping audio below the tracks creates new tracks.
- Dragging a clip below the last track moves it onto a new track. See [Editing clips](editing.md#moving-and-trimming).
- **×** in a track header removes the track. If it has clips, WavePod asks first; `Ctrl+Z` brings it back.

Each track gets a colour of its own, shown in its header and on its clips.

## The track header

From left to right and top to bottom:

| Control | Does |
| --- | --- |
| Name | Click to rename the track. |
| **●** | Arm the track for recording. |
| **C** | Cough button: hold to mute this speaker while recording or playing. See [Recording](recording.md#cough-buttons). |
| **M** / **S** | Mute / solo. Several tracks can be soloed at once. |
| **×** | Remove the track. |
| Input | The input channel(s) this track records from: one input, or a stereo pair. |
| **FX** | Opens the track's filters. With filters it shows how many are on. See [Filters and effects](filters.md). |
| Gain | Track volume in dB. Drag the slider, double-click it for 0 dB, or click the number to type a value. |
| Pan | Left … right. Double-click to centre, or click the value and type `L 40`, `C` or `R 25`. |
| **Auto** | Shows the track's volume or pan automation. See [Automation](#automation). |
| **Takes** | Only on a track with takes: shows or hides its take lanes. See [Takes and comping](recording.md#takes-and-comping). |

Right-click a track header to move the track into a folder, or to line it up with another track (**Align to other track…**, see [Aligning recordings](editing.md#aligning-recordings)).

> **Tip:** Every slider value in WavePod can be clicked to type an exact number, for example `-3,5 dB`, `1.2 kHz` or `250 ms`. Enter applies it (kept within the slider's range), Escape cancels.

## Meters

Each track's header shows its level: the input level while the track is armed, the playback level otherwise. The master meter sits inside the time display in the header.

## Automation

Automation changes a track's volume or pan over time, for example to walk a voice from left to right or to bring the music down under a scene.

1. Click **Auto** in the track header and choose **Volume automation** or **Pan automation**. The lane is drawn on the track itself.
2. **Double-click** on the lane to add a point; double-click a point to remove it.
3. **Drag points** to change them, or drag the line between two points.

Choose **Clips only** to hide the lane again; tracks with automation show a dot (•) in the menu. **Clear volume automation** and **Clear pan automation** remove all points.

- Volume automation works on top of the track gain, after the track's filters.
- Pan automation replaces the track's pan while it has points; the pan control then shows *lane*.
- Ripple cuts and moves take the points along.

## Track folders

Folders group tracks in big productions such as audio dramas: Dialogue, SFX, Atmo, Music or any folder you name.

- **Track folders** in the toolbar: **New folder…**, **Audio drama folders** (adds Dialogue, SFX, Atmo and Music), **Fold all folders**, **Unfold all folders**.
- Right-click a track header › **Move to folder**, **No folder** or **New folder with this track…**.
- Right-click a folder row to fold or unfold it, add an empty track, move tracks into it or remove the folder (its tracks stay).

A folder's row has one mute, one solo and a group volume for all its tracks (the volume is added to each track's own gain), and a meter showing the loudest of them. **Fold** a folder to hide its tracks; its row still shows where they have clips, and a time selection over it covers all of them. Files dropped on a folder's row land on a new track in that folder. Folders are kept in templates.

## Ducking

Ducking turns a track down automatically while the other tracks are speaking, for music beds and the soundboard. Open the track's **FX** panel and tick **Duck under the other tracks**, then choose how much quieter (−6 to −24 dB). Short pauses in the speech don't bring the music back up. It works in playback and in the export.

## Automix (remove crosstalk)

When several people share a room, every microphone also picks up the others. Tick **Automix (remove crosstalk)** in the FX panel of each speaker track: whoever is loudest stays at full level and the other automixed tracks are turned down by up to the chosen depth (−6 to −40 dB). Two people talking at once both stay up, and short pauses inside a sentence don't close a track. It runs in playback, the mix export and stem exports, after each track's filters.

## The master bus

**Master FX** in the header opens the filters on the master bus, which process the whole mix, for example a limiter at the end to keep peaks below a ceiling. See [Filters and effects](filters.md#master-fx).
