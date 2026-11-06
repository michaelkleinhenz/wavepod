# Troubleshooting

## No audio devices

- Plug in the interface (and switch it on), then click **Look for devices again** on **Setup › Audio**.
- Try another **Audio driver** under **Advanced audio settings**.
- **Linux:** with PipeWire or PulseAudio running, use **System default** (PulseAudio / PipeWire). Over ALSA the sound server holds the cards, so only a shared stereo device is left. See [Audio setup](audio-setup.md#linux-which-driver-to-use).
- **Windows:** multitrack interfaces such as the RØDECaster need their **ASIO** driver to show all their channels.
- If the audio system can't start at all, WavePod falls back to virtual devices and says so. You can still edit and export.

## A track records the wrong microphone

Change the track's **input** in its header on the timeline, or speak into each microphone on **Setup › Audio** to see which input it is on. See [Tracks and mixing](tracks-mixing.md#the-track-header).

## I can't hear anything

- Check **Listen on** and **Headphones / speakers on** in **Setup › Audio**.
- Check that no track is muted or another one soloed (**M** / **S** in the track headers), and that the track gain isn't all the way down.
- Is **Pre-show** on? Then only the soundboard is heard. Click it again.
- Look at the master meter in the time display while playing.

## Clicks, crackle or dropouts

- Raise **Latency (buffer size)** in **Setup › Audio › Advanced audio settings**.
- Close other programs that use the audio interface or a lot of CPU.
- Use a USB port directly on the computer rather than a hub.
- The warning bar during recording and the ⚠ edit markers after it show where problems happened. See [Recording](recording.md#problem-warnings).

## Pressing R starts a new take while editing

Unarm the tracks with **Edit › Prepare All Tracks for Editing**, and tick **Prepare for Editing When Recording Stops** so it happens by itself. See [Recording](recording.md#after-recording).

## WavePod crashed while recording

Open the episode again. WavePod finds the interrupted recording, repairs the files and puts them back on their tracks, and tells you so. A backup of the episode from before the repair is kept in its `backup/` folder. See [Recording safety](recording.md#recording-safety).

## I want an earlier version of my edit

Use `Ctrl+Z` for recent changes, or **File › Restore Backup…** to go back to a backup from earlier. See [Backups](episodes.md#backups).

## The save dot is red

The episode could not be saved, for example because the disk is full, the folder was removed or a drive was disconnected. Hold the mouse over the dot to see why. Fix the cause; WavePod retries every few seconds, or click the dot to try at once. To keep working somewhere else, use **File › Save As…**.

## The export is too quiet or too loud

Tick **Normalise loudness** in the export dialog and pick the target. If a single speaker is much louder than another, normalise their clips first (`Alt+Shift+N`) or use the Dynamics filter. See [Loudness](loudness.md).

## A VST3 plug-in is missing

Only VST3 effects are supported (not VST2, AU or CLAP plug-ins, and no instruments). Install the plug-in in your system's standard VST3 folder and restart WavePod.

## Transcribing doesn't work

Check the ElevenLabs API key in **Edit › Settings… › General**, that your account has credits, and that you are online. See [Transcript and text editing](transcript.md).

## Linux: WavePod doesn't start from source

When running from source, Electron's sandbox may need extra permissions on Ubuntu 23.10 and later; `make start` explains the options. The AppImage doesn't add itself to the app grid; see the README for `make desktop-install`.

## Reporting a problem

Use **Help › Report a Problem…** (or go to [github.com/michaelkleinhenz/wavepod/issues](https://github.com/michaelkleinhenz/wavepod/issues)) to report bugs and ideas. Mention your operating system, your audio interface and what you did just before the problem. **View › Toggle Developer Tools** shows error messages that help.
