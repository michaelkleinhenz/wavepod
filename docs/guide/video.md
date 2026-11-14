# Video podcasts

WavePod can turn the camera recordings of a conversation into a video podcast. You import each camera's video, line it up with the microphone recordings, edit the audio as usual, and choose which camera is seen when. The export dialog then writes an MP4 next to your audio files, with the same mix.

Cameras don't need their own editing. Each camera's picture follows its sound, so every cut you make in the audio (a ripple cut, a word deleted in the transcript, a pause taken out by Clean up, a comped take) cuts the video too.

## Import the cameras

Use **File › Import Camera Video…**, drop video files on the timeline, or click **Import camera…** in the cameras panel. WavePod reads MP4, MOV, M4V, MKV and WebM files with H.264, VP9 or AV1 video. HEVC (H.265) works where the computer has a decoder for it (macOS, and Windows or Linux with hardware support). ProRes and other editing formats have to be converted first.

For each camera WavePod:

- takes out the camera's sound and puts it on a track of its own, named after the camera and tagged CAMERA. The track is muted: it is the camera's reference sound, not part of the mix.
- adds the camera to the cameras panel with a number (1 to 9) and a colour.

The video file itself stays where it is (inside the episode folder it is stored with a relative path). Don't move or rename it afterwards.

Every camera needs sound, even a poor one from its built-in microphone: that sound is how WavePod lines the cameras up with the other recordings.

## CamPod

[CamPod](https://github.com/michaelkleinhenz/campod) is a camera recorder: a Linux computer with several USB cameras (for example an OBSBOT Tiny 2 Lite or a DJI Osmo Pocket in webcam mode) that records each camera to a file of its own. WavePod works with it in two ways.

**Set it up** in **Edit › Settings… › Cameras**: type the CamPod computer's name or IP address (port 8080 is added for you) and, if CamPod has an `auth_token` in `/etc/campod/config.yaml`, the access token. **Test Connection** lists CamPod's cameras and what each records.

WavePod decodes video with the computer's own decoders, which can't read MJPEG. CamPod keeps a camera's picture as the camera sends it, and many webcams send MJPEG. Such a camera shows "Records MJPEG"; click **Record H.264** next to it and CamPod encodes that camera to H.264 from the next recording on (smaller files, a little more work for the CamPod computer). Every camera also needs its microphone switched on in CamPod: its sound is how WavePod syncs it.

**Cameras start with the recording.** With **Start and stop the cameras with the recording** ticked, pressing Record in WavePod starts CamPod's cameras too, under the episode's name, and stopping the recording stops them. A toast says when the cameras are running or if one of them didn't start; the sound recording goes on either way. Punch-ins and loop recording leave the cameras alone. When you quit WavePod during a recording, it stops the cameras before it closes.

**Bring the cameras in** with **File › Import from CamPod…**. It lists CamPod's recordings, the ones started with this episode first (tagged "This episode"). Pick one, and WavePod:

- downloads its camera files into the episode folder (`video/<recording>/`). A download that was cancelled or cut off continues where it stopped the next time, and files already there aren't downloaded again.
- adds each file as a camera named after the CamPod camera. A camera that dropped out during the recording has several files; each becomes a camera of its own ("Host (part 2)").
- places the cameras of a recording started with this episode where its take started, and then syncs every new camera to a microphone recording you pick, as **Sync cameras…** does.

Cameras that recorded MJPEG or no sound are left out, with a note saying why.

## Line them up

Cameras and recorders all start at different moments. **Sync cameras…** in the cameras panel lines every camera's sound up with a microphone recording you pick, over the whole length, and corrects clock drift between the devices. You can also do it one at a time: right-click a camera › **Sync to Audio…**, or right-click any track header › **Align to other track…** (see [Aligning recordings](editing.md#aligning-recordings)).

Both directions work: align the cameras to a microphone recording, or align your separate microphone recordings to a camera's sound. Whichever way, the picture stays in sync, also when clock drift was corrected with a stretched copy of a file.

## Edit as usual

Edit the audio the way you always do. A camera shows the part of its video that belongs to the sound playing on its camera track, so:

- ripple cuts, cuts in the transcript and Clean up apply to the picture at the same frame,
- where a cough was deleted without closing the gap, the picture keeps running through the gap,
- sound-designed clips (reversed, varispeed, looped) show a still frame,
- where two clips overlap in a crossfade, the picture changes in the middle of the overlap.

Edits that only touch some tracks (moving a single clip on a microphone track, for example) don't move the picture. Keep the camera tracks in step with the speakers, as ripple cuts and transcript cuts do on their own.

## The cameras panel

**View › Video** (`Shift+Ctrl+U`) opens the cameras panel. At the top is the program: what the exported video shows at the playhead, with the name of its camera. Below it are all cameras; the one in the program has a coloured frame.

- Click a camera to switch to it at the playhead. `Alt+1`…`Alt+9` do the same from the keyboard, also while the episode plays.
- Right-click a camera for **Sync to Audio…**, **Framing…**, **Who Is in the Picture…**, **Rename…**, **Move Up** / **Move Down** (its number) and **Remove Camera**. The same menu is under **Camera…** when you right-click the camera's track header.

Where the chosen camera has no picture (before it started recording, or after it stopped), the next camera in the list with a picture is shown. Put the wide shot first so it fills in.

## The director lane

Once there are cameras, a **Director** lane sits above the tracks. It shows which camera is seen when, each shot in its camera's colour. Until you make the first switch, the first camera is shown.

- Click the lane to move the playhead there.
- Drag a switch (the line at the start of a shot) to move it. It snaps to the start of words when there is a transcript.
- Right-click a shot to give it another camera, put a switch where you clicked (**Switch Camera Here…**), turn the switch into a dissolve of ½ or 1 second (or back into a **Cut (No Dissolve)**), **Remove This Switch**, or **Remove All Switches**.
- Shots shorter than 1.5 seconds have an orange switch line.

The director lane moves along with every ripple cut, paste and ripple drag, like markers do.

## Watch through and switch cameras

The quickest way to direct is to watch the finished cut and switch like a vision mixer. Press `W` (**View › Watch Through and Switch Cameras**, or **Watch through** in the panel). The program fills the window with all cameras below it.

- `Space` plays and pauses.
- `1`…`9` switch to that camera as it plays. Hold `D` while you press the number for a dissolve.
- `←` / `→` jump 5 seconds back or on.
- `Esc` (or `W`) closes the view.

Watching alone changes nothing. From the first number you press, WavePod records your switches until playback stops; they replace the switches that were there in that stretch, and what was on screen after it carries on. Each pass is one undo step, so `Ctrl+Z` takes back the whole pass. To fix one spot, start playing a little before it and switch again.

People press a key a moment after they hear the cue. **Reaction time** (250 ms unless you change it) places each switch that much earlier, and then on the start of the nearest word within 0.4 seconds when there is a transcript.

## Auto-direct

**Auto-direct…** in the cameras panel makes a first pass for you. Tick who each camera shows; a camera that shows several people is a wide shot. Then:

- while one person talks, their close-up is shown (the camera showing them with the fewest others),
- when several people talk at once, or nobody talks for a while, the camera showing the most people,
- a long close-up gets a short wide shot in between.

You set the shortest shot, how long someone must talk before the picture goes to them, and when the wide shot comes in. Who is speaking comes from the transcript if there is one (more precise), otherwise from the audio levels of the tracks. With a time range selected, only that range is directed. Watch the result through and press keys where you want it different.

## Framing

Right-click a camera › **Framing…** zooms into its picture and moves the crop left, right, up or down, with a live preview. Use it to make a close-up out of a wide 4K shot, or to centre a speaker. When the camera's shape differs from the video's (a portrait phone in a landscape video), the picture is cropped to fill the frame.

## Export the video

The video is part of the normal export. In **File › Export…** (`Ctrl+E`), tick **Video › MP4 video**; **File › Export Video…** (`Shift+Ctrl+E`) and **Export video…** in the cameras panel open the same dialog with it ticked. Next to the box:

- **Size**: 720p, 1080p, 1440p or 4K, in the shape of the first camera.
- **Frame rate**: 24 to 60 frames per second.
- **Quality**: smaller file, high (right for YouTube) or very high (for further editing).
- **Video format**: H.264 plays everywhere. AV1 makes smaller files and is royalty-free, but takes longer.

The video gets the file name of the export with `.mp4`, so one export writes, for example, `Episode 12.mp3` for your podcast host and `Episode 12.mp4` for your video host. It follows the export's range: the whole episode, the selection, one region, or each region as its own video. You can also untick every audio format and export only the video.

The sound is the same mix as the audio files, with the loudness target, peak limit and mono setting of the dialog. It is AAC where the computer has an AAC encoder (macOS, Windows) and Opus otherwise (Linux); YouTube and current players take both. The video is rendered after the audio files; the dialog shows the picture as it is written and how fast it runs. **Cancel Video** leaves no half-written file.

The episode title, author, podcast name and description go into the file's tags. Chapters are not written into the video file yet.
