# Navigating the timeline

The timeline in **Record & Edit** (`Ctrl+2`) shows one row per track, with the track header on the left and the clips on the right. Above the tracks is the ruler, below them the overview strip.

## Playing

- `Space` plays and stops. Playback stops by itself at the end of the last clip.
- **To start** (`Home`) jumps to the beginning, `End` to the end of the episode.
- Click the ruler to move the playhead there. Clicking a clip also moves the playhead to where you clicked.

### Repeat

`L` (or the **Repeat** button) switches looping on and off. While it is on, playback loops over the selected time range, so you can listen to a passage again and again while you work on it; select another range and the loop follows. Without a selection, playback plays on as usual. The setting is remembered.

### Preview a cut

`P` plays from two seconds before the playhead to two seconds after it, then puts the playhead back where it was. Put the playhead on a cut you just made and press `P` as often as you like to hear whether it sounds natural.

### Playback speed

The speed menu in the header plays the episode faster (or slower) with the pitch kept, up to 3×, to check a long recording quickly. `>` and `<` step faster and slower; **View › Play Faster**, **View › Play Slower** and **View › Normal Playback Speed** do the same. Recording and export always run at normal speed. The speed is remembered on this computer.

### Marker ping

**View › Ping at Markers During Playback** plays a short beep each time playback passes a marker: higher for chapter markers, lower for edit markers. It is useful when you listen through a recording to check your markers.

## Moving around

| Key or mouse | Does |
| --- | --- |
| `←` / `→` | Back / forward 1 second (with `Shift`: 10 seconds) |
| `Alt+←` / `Alt+→` | Previous / next clip edge |
| `Shift+Alt+←` / `Shift+Alt+→` | Previous / next marker |
| `Home` / `End` | Start / end of the episode |
| `Y` | Jump to where the recording is |
| Mouse wheel | Scroll up and down through the tracks |
| `Shift`+wheel, or sideways wheel | Scroll along the timeline |
| Middle mouse button drag | Pan the view |

While you drag a clip, an edge, a selection or a marker towards the edge of the timeline, the view scrolls along (faster the further out you go), so you can carry anything anywhere in one drag.

## Zoom

- `+` and `-` (or the toolbar buttons) zoom in and out at the playhead. `Ctrl`+wheel zooms at the mouse.
- **Zoom to fit** shows the whole episode.
- `Shift+Z` (**Zoom to selection**) zooms to the selected range or clips; press it again to zoom back.

You can zoom right down to single samples: past a certain point the waveform turns into a line with a dot for each sample.

## The overview

The **Overview** strip below the tracks shows the whole episode at a glance, with the part you are looking at highlighted. Click or drag in it to move the view.

## Dragging the playhead and scrubbing

Grab the playhead (the triangle on the ruler or the line itself) and drag it. You hear the audio at the speed and in the direction you move, like moving tape over a tape head, also while stopped. Held still, it falls silent; let go and playback (if it was running) carries on from there.

The playhead snaps to clip edges, markers and selection edges while snapping is on.

## Selecting

- **Drag on the ruler** to select a time range across all tracks.
- **Drag over empty space on the tracks** to select a time range on just those tracks.
- Drag the edges of a selection to resize it.
- **Double-click a region** on the ruler to select its time range. Double-click its name to [rename it](chapters.md#renaming-regions).
- **Click a clip** to select it. `Shift`+click another clip selects everything from the last clip you clicked to that one: every clip in the rectangle between them, across the tracks in between. With no clip clicked before, `Shift`+click adds a clip to the selection or takes it out.
- **`Shift`+drag** draws a rectangle that selects every clip it touches.
- `Ctrl+A` (**Edit › Select All Clips**) selects every clip.
- `Esc` clears the selection (and stops the soundboard).

## Snapping

With **Snapping** on (the magnet button in the toolbar), dragged clips, edges, selections, markers and the playhead snap to clip edges on other tracks, markers and the playhead. Hold `Alt` while dragging to move freely.

## The toolbar

The toolbar above the tracks holds, from left to right:

- **Add track** and **Track folders**,
- **Import audio…** (`Ctrl+I`) and **Prepare for editing**,
- **Split** (`S`), **Ripple cut** (`Ctrl+X`), **Mute range** (`Ctrl+Y`), **Fade** (`F`),
- **Normalise** (`Alt+Shift+N`), **Loudness…** (`Shift+Ctrl+L`), **Align to track…**,
- **Chapter marker** (`M`), **Edit marker** (`E`), **Region from selection**,
- **Zoom out**, **Zoom in**, **Zoom to fit**, **Zoom to selection** and **Snapping**.

Hold the mouse over a button to see what it does and its key.
