# Recording

Recording happens in **Record & Edit** (`Ctrl+2`). Every armed track records its input into a WAV file of its own, and you see the waveform grow while you talk.

## Arm, record, stop

1. **Arm** the tracks you want to record: the round **●** button in each track header. Tracks made with **Create speaker tracks** are armed already.
2. Press `R` (or the red **Record** button in the header). A short [soundcheck](#soundcheck) runs first.
3. Press `R` again to stop.

Recording starts at the playhead. The timeline scrolls along so the red recording cursor stays in view; press `Y` to jump back to where the recording is after you scrolled away.

While a recording runs, the status bar shows how much recording time the disk has left.

> **Tip:** Stopping a recording asks for confirmation, so a stray key doesn't end the show. Switch this off with **Edit › Confirm Before Stopping a Recording**.

## Punch-in: re-record one line

When one line went wrong, re-record just that line inside the existing audio, the way radio drama studios do:

1. Select the line: drag over it in the ruler (or on an empty spot of the timeline). The selection is the **punch range**.
2. Arm the track (or tracks) of the speaker.
3. Press `Shift+R`, click the **punch** button next to Record (a record dot between brackets), or choose **Edit › Punch In: Re-record Selection**.

Playback starts the **pre-roll** (3 seconds by default) before the range, with the old take still audible, so the speaker hears the lead-in and comes in on cue. At the start of the range recording takes over: the armed tracks go quiet in the playback (the speaker hears themselves through the interface as usual) and the new take replaces the old audio. After the end of the range a short **post-roll** (1 second) plays the old audio again so you hear the joint, then the pass stops by itself and the playhead goes back to where the pre-roll started. Press Space to listen to the result, or `Shift+R` again for another try.

- Only the selected range changes, and only on the armed tracks. Both edges get a short crossfade, so the joints don't click.
- What was there before is kept as a take: the old version is **Take 1**, the punch **Take 2**. Press `T` to switch back and forth, or comp them in the take lanes. See [Takes and comping](#takes-and-comping).
- The whole pass is kept in the file, pre-roll and post-roll included, so you can drag the edges of the new clip out if the line needs a little more room.
- Stopping during the range keeps what was recorded up to there. Stopping during the pre-roll keeps nothing.
- Change the pre-roll and post-roll in **Edit › Settings… › General › Punch-in recording**.
- A MIDI button or foot switch (**Punch in**) or the OSC address `/wavepod/punch` starts a punch too. See [MIDI and remote control](controllers.md).

A punch take is protected like any other take: if the app goes down mid-pass, the recovered take is put back into the range only.

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

## Takes and comping

Record a line as often as it takes and keep the best one. WavePod never throws a take away.

- **Record over it again.** Put the playhead before the line and press `R`. When the new recording runs over audio on an armed track, the earlier recording of that stretch becomes **Take 1**, the new one **Take 2**, and so on. The newest take plays.
- **Punch in.** To redo one line inside a longer recording, select it and press `Shift+R`. See [Punch-in](#punch-in-re-record-one-line).
- **Loop recording.** Select the time range of the line (drag across the timeline) and press `Alt+Shift+R` (**Edit › Loop-Record the Selection (Takes)**). Playback starts 2 seconds before the line so the speaker hears a run-up, then jumps back to the start of the selection at its end and keeps going until you stop. Every pass is a take, and the last whole pass plays (a pass cut short by stopping is kept too). The recording shows *loop recording · pass n*. After stopping, the playhead waits at the start of the line for the next go.

A track with takes gets a **Takes** button in its header. Click it to show the **take lanes** under the track, one lane per take:

- **Click a take** to play the whole take.
- **Drag over a part of a take** to use just that part: the comp plays it there and keeps the other takes around it (swipe comping). Use take 2 for the first sentence, take 4 for the punchline.
- The parts the comp plays are bright and framed in the track colour; unused parts are dimmed.
- Right-click a lane for **Use this take**, **Use this take for the selected time**, **Delete take** (only takes the comp doesn't use), **Delete unused takes**, **Flatten takes** and **Hide take lanes**.

Without opening the lanes, press `T` (**Edit › Next Take**) or `Shift+T` (**Edit › Previous Take**) to step through the takes at the playhead, on the selected clips' tracks or on every track with takes there. The clip menu lists the takes under the clip as well.

The comp is ordinary clips: trim, split, fade and move them as usual. When you drag a whole comped line somewhere else, its takes move along. Ripple cuts and inserted silence move takes too. **Flatten takes** keeps the comp and forgets the takes; their files stay in the project folder.

## Pre-show

The **Pre-show** button in the header lets only the soundboard be heard, for waiting music before the show starts; the episode playback is silent. Click it again to go back to the show. It can also be toggled from MIDI and OSC.

## After recording

When a take stops, WavePod reports how many takes were recorded.

**Edit › Prepare All Tracks for Editing** (also in the timeline toolbar) unarms all tracks, so pressing `R` while you cut can't start a new take by mistake. Tick **Edit › Prepare for Editing When Recording Stops** to do this automatically after every take.

## Recording safety

WavePod is built so a recording survives crashes, power cuts and full disks. It is still beta software, though, so always make a backup recording as well, for example on your hardware mixer (see [Beta software](getting-started.md#beta-software)).

- Every bit of audio is written to disk the moment it arrives, by a separate writer. If the app crashes, at most a few milliseconds are lost; after a power cut, at most about two seconds.
- Files larger than 4 GB are written as RF64 automatically.
- If the recording was interrupted (a crash, a power cut), WavePod notices it the next time the episode opens: the files are repaired and put back on their tracks, and a dialog tells you so. A backup of the episode from before the repair is kept.
- If the disk fills up, audio is held in memory (up to 1 GB) and written as soon as there is space again. WavePod won't start a take with less than a minute of space left.
- If the audio interface drops out mid-take (a USB reset or a loose cable), the recording keeps running with silence, so all tracks stay in time. WavePod reconnects as soon as the device is back, and the gap gets a ⚠ edit marker.
- Closing the window or quitting the app (Ctrl+Q, ⌘Q, the menu or the Dock) while recording asks first. If the window itself crashes, it reloads while the recording continues.
- Only one WavePod runs at a time: starting it again brings the open window to the front instead of opening the episode a second time.

### Problem warnings

While recording, a bar below the header warns about problems as they happen:

- **dropouts**: audio the device never delivered,
- **crackle** and **clipping**,
- a **stalled** input device,
- a **slow or nearly full disk**, and write errors.

When the take stops, every problem spot gets a ⚠ edit marker so you can listen to it, and the message after the take says how many there are.

### Recording alerts

When the input device stops delivering audio mid-take (unplugged, reset, or lost by the sound server) or the take can't be written to disk, WavePod raises the alarm so you notice even with the window in the background: a red dialog with a repeating alarm sound, a system notification, a flashing taskbar entry (a bouncing dock icon on macOS) and "RECORDING PROBLEM" in the window title. WavePod never takes the keyboard focus away from what you are doing. The recording keeps running and the spot gets an edit marker; check your interface, then click **Got it, silence the alarm**.

Dropouts, crackle and clipping only appear in the warning bar, not as an alarm.

To see what the alarm looks like before a show, use **Test emergency notification** in **Edit › Settings… › General › Recording alerts**. It fires after 5 seconds, so you can switch to another window first.
