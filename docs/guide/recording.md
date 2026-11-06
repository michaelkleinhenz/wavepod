# Recording

Recording happens in **Record & Edit** (`Ctrl+2`). Every armed track records its input into a WAV file of its own, and you see the waveform grow while you talk.

## Arm, record, stop

1. **Arm** the tracks you want to record: the round **●** button in each track header. Tracks made with **Create speaker tracks** are armed already.
2. Press `R` (or the red **Record** button in the header). A short [soundcheck](#soundcheck) runs first.
3. Press `R` again to stop.

Recording starts at the playhead. The timeline scrolls along so the red recording cursor stays in view; press `Y` to jump back to where the recording is after you scrolled away.

While a recording runs, the status bar shows how much recording time the disk has left.

> **Tip:** Stopping a recording asks for confirmation, so a stray key doesn't end the show. Switch this off with **Edit › Confirm Before Stopping a Recording**.

## Soundcheck

Before a take starts, WavePod checks the things that commonly go wrong. If something is off, a **Soundcheck** dialog lists it:

- No input device is open, or no track is armed (recording can't start).
- The interface doesn't run at 48 kHz.
- Two armed tracks record the same input, so you'd get the same audio twice.
- The input looks like a built-in microphone, not your interface.
- The disk has room for less than two hours of recording on the armed tracks.
- You are about to record before the end of the episode, over existing audio.

Choose **Record anyway** to go ahead or **Cancel** to fix it. Tick **Don't warn about these again for this episode** to skip these warnings in this episode from now on.

## Markers while recording

- `M` drops a **chapter marker** at the playhead. `Shift+M` asks for a title right away.
- `E` drops an **edit marker**: a note to yourself to fix something later (a cough, a restart, a long pause). Edit markers are not exported.

Both work while playing too. You find and edit them in the **Chapters** view. See [Chapters and markers](chapters.md). A MIDI controller or Stream Deck can drop markers as well. See [MIDI and remote control](controllers.md).

## Cough buttons

Hold `Shift+1` to `Shift+9` to mute speaker track 1 to 9 for as long as you hold the key, or hold the **C** button in the track header. The speaker isn't heard in the mix, but the audio is still recorded: the muted part becomes a **mute region**, shown in the strip at the bottom of the track.

Mute regions can be changed later:

- drag in the strip at the bottom of a track to add one,
- drag its edges to adjust it,
- double-click it, or select it and press `Delete`, to remove it.

Cough buttons also work during playback, and can be mapped to MIDI pads and Stream Deck buttons.

## Soundboard

The soundboard plays jingles, intros, beds and sound effects on keys `1` to `9`. It sits at the top of **Record & Edit**.

- **+ Jingle** adds audio files to free slots (up to 12).
- Click a slot's play button, or press its number key, to play it. Press again to fade it out.
- **◢** gives a slot a soft fade-in; **⟲** loops it until stopped.
- **■ Stop** or `Esc` stops all jingles.
- **×** removes a jingle.

A playing slot shows the time it has left.

Jingles you play while recording are recorded onto a **Soundboard** track, so they are part of the edit and the export. Jingles are copied into the episode's `sounds/` folder, and templates keep them.

To make the soundboard duck under the voices, use **Duck under the other tracks** on its track. See [Tracks and mixing](tracks-mixing.md#ducking).

## Pre-show

The **Pre-show** button in the header lets only the soundboard be heard, for waiting music before the show starts; the episode playback is silent. Click it again to go back to the show. It can also be toggled from MIDI and OSC.

## After recording

When a take stops, WavePod reports how many takes were recorded.

**Edit › Prepare All Tracks for Editing** (also in the timeline toolbar) unarms all tracks, so pressing `R` while you cut can't start a new take by mistake. Tick **Edit › Prepare for Editing When Recording Stops** to do this automatically after every take.

## Recording safety

WavePod is built so a recording survives crashes, power cuts and full disks:

- Every bit of audio is written to disk the moment it arrives, by a separate writer. If the app crashes, at most a few milliseconds are lost; after a power cut, at most about two seconds.
- Files larger than 4 GB are written as RF64 automatically.
- If the recording was interrupted (a crash, a power cut), WavePod notices it the next time the episode opens: the files are repaired and put back on their tracks, and a dialog tells you so. A backup of the episode from before the repair is kept.
- If the disk fills up, audio is held in memory (up to 1 GB) and written as soon as there is space again. WavePod won't start a take with less than a minute of space left.
- If the audio interface drops out mid-take (a USB reset or a loose cable), the recording keeps running with silence, so all tracks stay in time. WavePod reconnects as soon as the device is back, and the gap gets a ⚠ edit marker.
- Closing the window while recording asks first. If the window itself crashes, it reloads while the recording continues.

### Problem warnings

While recording, a bar below the header warns about problems as they happen:

- **dropouts**: audio the device never delivered,
- **crackle** and **clipping**,
- a **stalled** input device,
- a **slow or nearly full disk**, and write errors.

When the take stops, every problem spot gets a ⚠ edit marker so you can listen to it, and the message after the take says how many there are.
