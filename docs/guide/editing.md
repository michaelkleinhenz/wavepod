# Editing clips

Every recording and every imported file becomes a **clip** on a track. Editing in WavePod never changes your audio files: it only changes where clips sit, which part of the file they play and how loud they are. Everything can be undone with `Ctrl+Z`.

## Moving and trimming

- **Drag a clip** to move it. Several selected clips move together.
- **Drag a clip straight up or down** to move it to another track. It keeps its time position, so the tracks stay in sync; move it sideways as well to place it freely.
- **Drag a clip's left or right edge** to trim it. Edges snap to clip edges on other tracks, markers and the playhead; hold `Alt` to trim freely.
- **`Ctrl`+drag a clip** to move it together with everything after it on the same track. **`Ctrl+Shift`+drag** moves everything after it on all tracks (a ripple move).

## Splitting

- `S` (or **Split** in the toolbar) splits clips at the playhead: the selected clips, or every clip under the playhead when none is selected.
- Right-click a clip › **Split here** splits it at the mouse.

## Deleting and cutting

| Action | Key | What happens |
| --- | --- | --- |
| Delete selected clips | `Delete` | The clips are removed; the gap stays. |
| Delete a time range | `Delete` | Everything inside the selected range is removed on all tracks; the gap stays. |
| Ripple delete a range | `Shift+Delete` | The range is removed from all tracks and everything after it moves up to close the gap. |
| **Ripple cut** | `Ctrl+X` | Like ripple delete, and the cut material goes to the clipboard. |

Ripple edits keep all tracks in sync, and they move markers, regions, mute regions and automation along.

> **Tip:** Cutting by text is often faster: in the transcript, select words and press `Delete`. See [Transcript and text editing](transcript.md).

## Copy and paste

- `Ctrl+C` copies the selected clips, or the selected time range on its tracks.
- `Ctrl+V` pastes at the playhead, on top of what is there.
- `Shift+Ctrl+V` (**Edit › Paste and Move Later Material**) makes room first: everything after the playhead moves later by the length of what you paste.
- Right-click a clip › **Duplicate** places a copy right after it.

## Fades

- **Drag the top-left or top-right corner** of a clip to draw a fade in or fade out.
- `F` (or **Fade**) adds short fades to the selected clips. Right-click › **Remove fades** takes them off.
- **Double-click a fade** to change its shape: linear, equal power or S-curve.

### Crossfades

Drag one clip so it overlaps the next on the same track and the overlap becomes a crossfade by itself. Overlapping clips are drawn see-through, with both waveforms and the crossing fade curves visible, also while you drag.

Cuts never click. Wherever a cut leaves a hard clip edge (a deleted word, a ripple cut, a clip trimmed in the middle of a sound), WavePod blends it over 5 ms when it plays and exports: two clips that meet get a tiny crossfade, a clip that ends on its own a tiny fade. These are not drawn and change nothing in the clips; a plain split that keeps the audio running is left untouched.

## Volume line

Each clip can have a **volume line** to make words louder or quieter, or fade a music bed under a voice.

- Hover a clip and click **Vol** at its top left (or right-click › **Show volume line**) to show it.
- **Double-click** on the line to add a point; double-click a point to remove it.
- **Drag a point** to move it, or drag the line between two points up and down.
- Right-click › **Reset volume line** removes every point.

The waveform shows the result as you drag.

### Mute a range

`Ctrl+Y` (**Edit › Mute Selection**, or **Mute range** in the toolbar) silences the selected time range on the tracks you dragged across, using their volume lines. Use it to take out a cough or a noise without cutting time.

## Clip gain

Right-click a clip › **Clip gain…** sets its volume in dB; type a value such as `-3.5`. **Reset clip gain** sets it back to 0 dB. To bring clips to the same loudness, use **Normalise** (`Alt+Shift+N`). See [Loudness](loudness.md#normalise-clips).

## The clip menu

Right-click a clip for every clip command. It works on all selected clips if the clicked one is selected, otherwise on the clicked clip alone:

- **Split here**, **Split at playhead**
- **Cut**, **Copy**, **Paste at playhead**, **Duplicate**, **Delete**
- **Add fades**, **Remove fades**
- **Show volume line**, **Reset volume line**
- **Clip gain…**, **Reset clip gain**, **Normalise to −16 LUFS**, **Loudness analysis…**
- **Sound design**: **Reverse**, **Speed…**, **Loop**, **Loop to next clip**, **Loop over selection**, **Play as recorded**. See [Audio drama](audio-drama.md#sound-design-on-clips).
- **Colour** swatches and **Note…**
- **Select all on this track**, **Zoom to clip**
- **Region from clip**, **Align to track…**

## Colours and notes

Pick a colour in the clip menu to mark clips, for example everything that still needs work. **Note…** attaches a short text to a clip; it shows on the clip and when you hover it.

## Clip filters

Hover a clip and click **FX** at its top to give that one clip its own filters, on top of the track's filters. A clip with filters shows **FX** and the number of filters. See [Filters and effects](filters.md#clip-filters).

## Dropping files on the timeline

Drag audio files from your file manager (or sounds from the sound library) onto the timeline:

- onto a track to place them on that track,
- below the last track to put them on new tracks,
- onto a folder's row to put them on a new track in that folder.

While you drag, the target track lights up and a line shows where the file will land. The drop snaps to clip edges, markers and the playhead; hold `Alt` to place it freely. Several files dropped at once are one undo step, and the new clips are selected.

## Aligning a double-ender

When a remote guest records themselves locally (a "double-ender"), their file has to be lined up with the call. Import the guest's file, select the clip, and use **Align to track…** (toolbar or clip menu). Pick the track that recorded the guest during the call, for example the RØDECaster's *USB Chat* channel. WavePod compares the speech in both and moves the clip into place (by up to a minute). If the match is weak it says so: listen, and undo if it's off.

## Prepare all tracks for editing

After recording, use **Edit › Prepare All Tracks for Editing** so `R` can't start a new take while you cut. See [Recording](recording.md#after-recording).
