# Audio drama

WavePod has the tools for fiction and sound-rich productions: a script that knows what is recorded, voice effects, rooms and distance, a searchable sound effects library and sound design on clips. Together with [track folders](tracks-mixing.md#track-folders), [automation](tracks-mixing.md#automation) and [stem export](export.md#stems) they cover a full audio drama.

## Script

Import the script and WavePod keeps track of every line: who speaks it, whether it is recorded and where its take is on the timeline.

### Importing a script

**File › Import Script…**, or **Import script…** in the script panel. Four formats work:

- **Plain text** (`.txt`): one speech per line as `NAME: what they say`. A direction for the actor goes in brackets after the name: `BEN (whispering): It is late.` Lines starting with `INT.`, `EXT.`, `Scene 2`, `Szene 2` or `#` are scene headings; `Act 1`, `Akt 1`, `Chapter 1` or `Kapitel 1` start an act. Everything else is a stage direction. A line `Title: …` at the top names the script.
- **Fountain** (`.fountain`): the plain-text screenplay format that many writing apps export (Highland, Slugline, Fade In, Beat, WriterSolo…). Character names in capitals above their words, scene headings like `INT. PLATFORM - NIGHT`. Notes `[[…]]` and boneyard `/* … */` are left out.
- **Final Draft** (`.fdx`).
- **PlotGod** audioplay (`.json`): the project export of a PlotGod audioplay. Every act becomes an act heading, followed by its scenes in order. Inside a scene, `NAME: (direction)` above the words is a line with its direction, the slug line (`SZENE 1 - SARAHS PRAXIS - ABEND`) is the scene heading and cues like `[SFX: …]`, `[MUSIK: …]` or `[Pause]` are stage directions. The script takes the project's name.

WavePod recognises Fountain in a `.txt` file by itself. Importing again (for a revised draft) keeps the ticks of every line that stayed the same.

### The script panel

Open **View › Script** (`Shift+Ctrl+J`), or pick the **Script** tab of the [sidebar](timeline.md#the-sidebar). It shows:

- the script's progress: how many lines are recorded,
- every character with their recorded and total lines. Click a character to see only their lines (handy in a session with one actor), click again for everyone,
- **Tracks**: the track each character is recorded on. Characters go to the track with their name by themselves (*Anna* for ANNA, *Dr. Hill* for HILL); pick another track here,
- **Character tracks**: each character's own track, voice and room. See [Character tracks](#character-tracks),
- the lines, scene by scene, with stage directions in grey. **Open lines only** hides what is ticked off.

### Folding acts and scenes

Fold away what you are not recording to keep your eyes on the scene at hand.

- Click the arrow (**▾**) in front of an act or scene heading to fold it; click it again (**▸**) to unfold. A folded act hides all of its scenes. The heading still shows how many of its lines are recorded.
- **⋯ › Show Only the Current Scene** folds every act and scene except the one with the picked line.
- **⋯ › Fold All Acts and Scenes** leaves only the headings, an outline of the whole script. **⋯ › Unfold All** opens everything again.
- When `Enter` ticks off the last line of a scene, the next scene unfolds by itself. Picking a scene in **Jump to scene…** unfolds it too.

Acts come from the script: PlotGod acts, Fountain sections (`# Act One`), Final Draft *New Act* paragraphs and headings starting with *Act*, *Akt*, *Chapter* or *Kapitel*. Folding is remembered on this computer and never changes the episode. A PlotGod script imported before acts were recognised shows them as scenes until you import it again.

### Script window for remote actors

Click **⧉** in the script panel's toolbar, or choose **View › Script in New Window**, to open the script in a window of its own. Share that window in Zoom, Teams or any video call and the actor reads along while you record.

- The window follows the panel: the picked line is highlighted and kept in the middle, ticks show up as you press `Enter`, and the line playing back is marked.
- The top shows the script's title, the act and scene of the picked line and how much is recorded.
- **A−** and **A+** (or `Ctrl` `+` / `Ctrl` `−`, or `Ctrl` and the mouse wheel) change the text size, so the script stays readable in a shared screen.
- **All characters** shows only one character's lines in the window, for a session with one actor, while the panel still shows everyone.
- Folded acts and scenes are folded in the window as well. Clicking and the keys work there just like in the panel.

The panel can be closed, or the sidebar switched to another tab, while the window stays open. Closing WavePod closes the window too; click **⧉** again to close it yourself.

### Ticking lines off while recording

Click the box in front of a line to tick it off. WavePod notes where the playhead is, on the character's track, so the line can be found again later. In a recording session:

1. Click the first line to record (or walk there with `↑` and `↓`).
2. Record. After each line is done, press `Enter`: the line is ticked off at the playhead and the next open line is picked.
3. `Delete` unticks the picked line.

Ticked lines remember their place in the recording itself, so they stay found after cuts, moves and trims.

### Lining up with the transcript

**Line up** finds the lines in the recording by itself. It uses the [transcript](transcript.md) (and transcribes what is missing first, which needs the ElevenLabs key) and looks for each line on its character's track, allowing for misheard and missing words. Every line it finds is ticked off with its take.

Lines don't have to be said word for word. Hesitations (*umm*, *uh*, *äh*) and laughing before or inside a line are left out, so a short line like *Tickets, uh, please* is still found and its take starts at the first word. Contractions match their long form (*we'll* and *we will*, *gonna* and *going to*), words with another ending count as the same (*walked* and *walking*), and long words may be slightly misspelt in the transcript.

- When a line was recorded several times, the row says how many takes the transcript holds (for example *3 takes*). The best take is used; of equally good ones, the last, which is usually the one that was kept. To split them apart, see [Cutting around every take](#cutting-around-every-take).
- Very short lines (*Yes.*) are only looked for between the lines around them, so they aren't matched just anywhere.
- Lines ticked by hand keep their place, and Line up never unticks a line.

#### Lining up a part of the recording

To line up only part of the recording, for example the scene you just recorded, select that time range on the timeline first (drag on the ruler, or across some tracks), or select the clips that hold it. The button then reads **Line up selection**: WavePod transcribes only that part of the recording, with a second of room on each side, and looks for the lines only there. Lines outside the selection stay as they are.

- Dragging across some tracks only looks at those tracks, so lines of characters on other tracks aren't found. Selected clips work the same way: from the start of the first to the end of the last, on their tracks.
- Parts that are transcribed already aren't sent again, so lining up the next scene only transcribes what's new.
- The [transcript panel](transcript.md) shows the words of every part transcribed this way. **Transcribe** there finishes the episode: it sends only the parts no selection has covered yet, so nothing is transcribed twice.

### Cutting around every take

When you record a line several times in one go (without [loop recording](recording.md#takes-and-comping)), all takes sit one after another in the same clip. WavePod finds every one of them in the transcript and cuts the track around them, so you can listen to each take on its own and keep the best one.

- Right-click a line and choose **Cut Around Every Take**. The track is split before and after each take of the line, and the clips holding the takes are selected.
- Right-click an act or scene heading and choose **Cut Around Every Take in This Scene** (or *Act*) to do this for all of its lines, for example when you recorded the whole scene twice.
- **⋯ › Cut Around Every Take of Every Line** does it for the whole script.

Only cuts are made: nothing is removed, moved or faded, and the episode plays exactly as before. Delete the takes you don't want yourself afterwards (`Delete` on the selected clip, or a [ripple delete](editing.md#deleting-and-cutting) to close the gap). Each cut leaves a little room before and after a take, but never reaches into the words around it. Cutting again where the clips are already cut does nothing. Like Line up, it needs the [transcript](transcript.md), and the line's character on the right track.

Cutting uses the transcript that's already there: after a **Line up selection**, cutting around the lines found in it sends nothing to be transcribed again. Only when a line isn't in the transcript yet are the parts of the recording that no transcript covers transcribed first, never the parts done already.

### Clip names from the script

Clips that hold one line of the script are named after it: the role and the first few words, for example *ANNA: Is this the night train…*. Names are kept short (32 characters at most) and cut at a word.

- **Cut Around Every Take** names each clip holding a take after its line, so the takes of a line are easy to tell apart on the timeline.
- **Line up**, and lines ticked while recording, name a clip when it holds exactly that one line and not much more, for example when you record each line on its own.
- Clips you have [renamed](editing.md#clip-names) keep their name. A clip with several lines keeps showing its file name.

### Character tracks

A character can have a track of its own, the *character track*, with its voice and the room it is in. **Line up** and **Cut Around Every Take** then move the character's lines there by themselves, wherever they were recorded: a narrator who reads three parts on one microphone, or a scene recorded with the whole cast around one mic, ends up with every line on the right character's track, with that character's sound.

Open **Character tracks** in the script panel. For each character:

- **Track**: *+ New track* makes a track named after the character (*Dr. Sarah Meyer* for DR. SARAH MEYER) in the folder of the track the character is recorded on, or in the *Dialogue* [folder](tracks-mixing.md#track-folders). It starts with a copy of that track's filters, so the clean-up of the actor's voice still applies. A track already named after the character is used as it is. Or pick any other track. *Stays on its track* switches routing off for the character.
- **Voice**: one of the [voice effects](#voice-effects), such as Telephone, Robot or Giant. *Natural voice* removes it again.
- **Room**: one of the [places](#places) (Room & distance), such as Living room, Car or Forest. Set its **Distance** in the FX panel to move the character away from the listener.

Picking a voice or a room makes the character track when there is none yet. The voice goes before the room in the track's filters, and picking another one replaces only the filters the voice (or the room) added; filters you added yourself stay. Everything stays editable in the [FX panel](filters.md).

**⋯ › Make Character Tracks** gives every character its own track in one go.

#### How lines are moved

- After **Line up**, a clip is moved to the character track when it holds only that character's lines and isn't much longer than them, for example when each line was recorded on its own. It keeps its time, so the timing of the scene doesn't change.
- A long recording with lines of several characters stays where it is: use **Cut Around Every Take** on the scene (or **⋯ › Cut Around Every Take of Every Line**) first. Each take then is a clip of its own and moves to its character's track.
- **⋯ › Move Lines to Character Tracks** moves the clips of every line found so far, for example after setting up character tracks for lines you lined up earlier.
- Moving is one step you can undo (`Ctrl+Z`). Lining up again later still finds the lines on the character tracks.

### Jumping

- Click a line to jump to its take. Its time is selected too, so **Repeat** (`L`) plays it over and over. `Shift+Enter` does the same for the picked line.
- Click an act or scene heading, or pick it in **Jump to scene…**, to jump to the first recorded line of that act or scene. The list shows the progress of each, with the scenes indented under their act.
- While playing, the line you hear is highlighted.

### Scene ambience beds

Every act or scene can have an atmosphere, such as a forest at night, a tavern or rain on a window. WavePod loops it under that part of the recording and crossfades it into the next scene's atmosphere by itself.

1. Right-click a scene heading in the script panel › **Choose Ambience…**.
2. The [Sounds](#sound-library) tab opens with *Ambience for "…"* on top. Listen as usual, then double-click a sound or press `Enter` (or right-click › **Choose This Sound**). `Esc` or **Cancel** leaves without one.
3. The sound's name now shows on the heading, and the sound plays under the scene.

Where a scene is on the timeline comes from its recorded lines: its bed starts a second before the scene's first line and lasts until the next scene starts. The last scene's bed runs on for two seconds after its last line. Between two scenes, both beds overlap by the crossfade (3 seconds unless you choose another one) with equal-power fades, so one place turns into the next. When a scene has no bed, the bed before it fades out where that scene starts.

- A bed on an act plays under every scene of the act that has no bed of its own.
- A scene with nothing recorded yet shows its bed with a dashed outline. The bed is placed once one of its lines is ticked off or found by **Line up**.
- Beds are looped clips on an **Ambience** track, which is created the first time a bed is needed. It goes into an *Atmo* folder when the episode has one, and into the effects [stem](export.md#stems). If you already have a track named *Ambience*, the beds go there.
- Click the sound's name on a heading, or right-click the heading, for **Change Ambience…**, the bed's volume (0 to −24 dB, −12 dB for a new bed) and **Remove Ambience**. Changing the clip gain of a bed on the timeline changes the bed's volume too.
- **Line up**, ticking a line and importing a new draft lay the beds again. A new draft keeps the beds of headings whose text stayed the same.
- After you move or cut the recording, the panel shows *Ambience beds no longer match the scenes*. Click **Lay again**, or use **⋯ › Lay Ambience Beds Again**.
- **⋯ › Ambience crossfade** sets the crossfade between scenes: 1, 3, 6 or 10 seconds. **⋯ › Remove All Ambience Beds** takes them all away.

Laying the beds again replaces the bed clips, so trims, moves or fades you made to them by hand are lost. For a one-off atmosphere that you shape yourself, use **Fill the Selection (Loop)** in the sound library instead. The sound is copied into the episode, like every sound you insert. `get_script` shows each bed and where it plays to AI agents.

The **⋯** menu imports a new draft, ticks all lines off again or removes the script (the recording stays as it is). The script is saved with the episode. AI agents can read it with the `get_script` tool. See [AI agents (MCP)](ai-agents.md).

The script, the sound library and the transcript share the right side of the window: opening one closes the others.

## Voice effects

**+ Add filter…** in the FX panel has a **Voice effects (audio drama)** group:

- **Devices:** Telephone, Mobile phone, Old radio, Walkie-talkie, Megaphone.
- **Where it sounds from:** Next room, Outdoor, Far away, Bathroom, Church, Cave, Underwater.
- **Creatures and machines:** Robot, Broken robot, Alien, Giant / monster, Demon, Small creature, Child-like voice, Chipmunk.
- **The unreal:** Flashback / dream, Magic / spirit, Ghost, Time travel / teleport, Dream sequence.

Each voice effect adds a few ordinary filters set from their presets, so every value stays editable afterwards. The building blocks are filters of their own: **Band-pass**, **Distortion**, **Echo**, **Pitch shift** (−24 to +24 semitones, speed kept), **Ring modulator** and **Chorus / flanger**. See [Filters and effects](filters.md#built-in-filters).

Put a voice effect on a whole track (a character who is always a robot) or on a single clip (one line on the phone). See [Clip filters](filters.md#clip-filters). For a character whose lines are spread over several tracks, select those clips and give them one [group FX](filters.md#group-fx) chain.

## Places

The **Places: room & distance** group puts a voice into a room with the **Room & distance** filter: close to the mic, living room, bedroom, small kitchen, bathroom, car, office, classroom, stairwell, basement, garage / warehouse, church, concert hall, cave, tunnel, forest, open field and street.

Its **Distance** (in metres) moves the speaker away: the voice gets quieter, loses highs and bass, and the room takes over, as if the speaker walked away. Below 1 m it gets the bass of speaking close to the mic. Use [volume and pan automation](tracks-mixing.md#automation) or clip filters to have a character walk past, or put the track on the [3D stage](#3d-stage-binaural), where the stage sets the distance.

## 3D stage (binaural)

The **Stage** tab of the sidebar (**View › Stage**, `Shift+Ctrl+P`) places each voice around the listener: in front or behind, left or right, above or below, near or far. Heard on headphones, the mix is **binaural**: a voice behind you sounds behind you, one above sounds above, and a character can walk around the listener.

1. Tick a track in the list under the stage to put it **on the stage**. It starts where its pan was, at ear height, 1 m away, so it sounds as loud as before.
2. **Drag its dot** on the stage. The head in the middle faces up: up is in front, down is behind. The rings are 1 m, 3 m and 10 m. In front, behind and the sides are sticky; hold `Alt` to move freely.
3. Set **Angle**, **Height** and **Distance** with the sliders under the track, or click a value to type it: angles like `R 30`, `L 120`, `-45` or `behind`, distances like `2.5` (metres), heights in degrees (`30` is above ear level, `-20` below).

A voice further away gets quieter, loses air and bass, the same way as with the Room & distance filter's distance. The track's pan and pan automation don't apply while it is on the stage: its pan control shows **3D** (click it to open the stage). Untick the track to pan it again.

**Room & distance on a placed track:** the filter follows the stage's distance, so you set the distance only once, on the stage. The voice comes from its place, while the reflections and the reverb stay around the listener, as in a real room.

**Moving voices:** a placed track's **Auto** menu has **Angle automation** and **Distance automation** (or click **Auto** next to the value under the stage). Draw a walk on the lane, for example from `L 90°` to `R 90°` for a character crossing in front of the listener. While a lane has points, the voice follows it in playback and on the stage (↻ next to its name), and dragging the voice on the stage sets a point at the playhead. The angle lane goes from 180° on the left (top) through the front (middle) to 180° on the right (bottom); to walk round behind the listener, put two points at the same time, one at `R 180°` and one at `L 180°`, which is the same place.

**Headphones or Speakers:** the switch at the top of the stage chooses the mix. **Headphones** is binaural. **Speakers** pans each placed voice by its angle instead (a voice behind is folded to the sides) and keeps the distance, for a loudspeaker mix or a radio version. The setting is saved with the episode and used by playback and export alike, so export one version, switch, and export the other.

> **Tip:** Binaural mixing is made for headphones; on loudspeakers it sounds a little wide and coloured. Most audio drama is heard on headphones today, but for a radio broadcaster export once more with **Speakers**.

WavePod renders the direction with a model of the head (the time difference and head shadow between the ears, and the shading of the ear and shoulders for front, back and height), not with measured head recordings, so it moves smoothly and needs no extra files. Front and back are easiest to hear with voices that move.


**Decay (RT60)** is how long the room's reverb takes to die away by 60 dB, in seconds, the figure acousticians measure rooms with. **Soft surfaces** make the highs die away sooner than that. The places use the decay times of real, furnished rooms, and keep the room well below the voice, as in film and radio drama:

| Place | Decay | Place | Decay |
| --- | --- | --- | --- |
| Car | 0.07 s | Basement | 0.9 s |
| Close to the mic | 0.25 s | Stairwell | 1.6 s |
| Bedroom | 0.3 s | Garage / warehouse | 1.8 s |
| Living room | 0.4 s | Concert hall | 2.0 s |
| Office | 0.5 s | Tunnel | 2.2 s |
| Small kitchen | 0.55 s | Cave | 2.5 s |
| Classroom | 0.7 s | Church | 2.8 s |
| Bathroom (tiled) | 0.8 s | Forest, street | 0.8–0.9 s, very quiet |

A room that sounds too big usually needs a shorter decay; one that sounds too reverberant needs less **Reverb** and **Reflections**. The **Reverb** filter has the same **Decay (RT60)** setting.

## Impulse responses

For the sound of one particular, real place, use the **Convolution reverb** filter with an impulse response (IR): a short WAV recording of how a room, car, hall or church answers a single click or sweep. Many free IR collections exist, for example the OpenAIR library, and many reverb plug-ins and sample packs come with IRs. You can also record your own: a balloon pop or a hand clap in the room, trimmed so the file starts with the bang.

1. Add **Convolution reverb** from "+ Add filter".
2. Click **Load…** and pick a WAV or AIFF file, or drop the file on the filter. WavePod copies it into the **Impulse responses** folder next to your Presets (Documents/WavePod/Impulse responses), so it can be used in every episode, template and preset.
3. Choose it from the list next time. Files you copy into that folder (subfolders too) appear after **Look for new files**.

The settings:

- **Dry** and **Wet (room)** set the level of the original sound and of the room. IRs are levelled on loading, so 0 dB wet sounds about as loud as the dry voice. For dialogue in a furnished room start around −18 dB, for halls and churches around −6 dB. **Wet only** (Dry at −60 dB) gives only the room.
- **Pre-delay** moves the room later, which keeps words clear in big spaces.
- **Length** uses only the first part of the IR, with a short fade: the character of the room with less decay.
- **Room low cut** and **Room high cut** shape only the room: cut lows to keep it from booming, highs for soft furnishings.
- **Width** narrows a stereo IR.

Mono IRs give the same room on both sides, stereo IRs keep their left and right. IRs are resampled to the episode's rate, and anything longer than 12 seconds is cut. The filter adds about 21 ms of latency, which WavePod compensates.

Episodes refer to IRs by file name in your Impulse responses folder. To open an episode on another computer, copy that folder too; a missing IR is shown on the filter, and only the dry sound plays until you load it again.

## Sound library

Keep your sound effects and atmospheres in a folder and search them from inside WavePod.

1. Choose the folder in **Edit › Settings… › General › Sound library** (subfolders are included).
2. Open **View › Sound Library** (`Shift+Ctrl+B`), or pick the **Sounds** tab of the [sidebar](timeline.md#the-sidebar).
3. Type to search file and folder names, for example *door creak* or *forest wind*. Words match the start of words in the names.
4. `↑` and `↓` walk the results and play each one (switch this off with the listen toggle). **Listen** plays the selected sound.
5. `Enter` or a double-click inserts the sound at the playhead. Or drag a row onto any track.

**Insert on** chooses where sounds go: by default a *Sound effects* track, created when needed. Right-click a sound for **Insert at the Playhead**, **Insert on a New Track**, **Fill the Selection (Loop)** and **Show in Folder**.

**Fill the Selection (Loop)** repeats a sound over the selected time range with crossfades: ideal for room tone, wind, rain and other atmospheres.

### SFX and Music

The library splits your sounds into two groups, switched with **SFX** and **Music** next to the search box. Each button shows how many sounds are in its group.

- A sound is **Music** when the word *music* appears anywhere in its path: in a folder name (*Music/*, *Background Music/*) or in the file name (*intro_music.wav*, *Musicbox.mp3*). Upper and lower case don't matter.
- Everything else is **SFX**: sound effects, atmospheres, foley.
- Searching looks in the group you are in. When the other group has matches too, the line under the search box says so, for example *· 3 in Music*: click it to switch.
- The **★ Favourites** tab is split the same way, by the full path of each favourite's file.

To file a sound as music, put it in a folder with *Music* in its name (or add *music* to its file name) and click **Rescan**. The word must be *music*: a folder called *Musik* or *Musique* stays in SFX.

WAV, MP3, FLAC, Ogg, Opus, M4A and AIFF files are found. **Rescan** reads the folder again after you add sounds. Sounds you insert are copied into the episode, so it keeps working without the library.

### Favourites

The **★ Favourites** tab at the top of the sound library holds the sounds you use again and again: your intro and outro, jingles, intermissions, a stinger, room tone. They are part of WavePod's [app settings](settings.md), not of the episode, so every episode has them.

- **Add sounds…** adds audio files from anywhere on your computer; they don't have to be in the library folder.
- In the **Library** tab, click the ☆ next to a sound (or right-click › **Add to Favourites**), or drag it onto the Favourites tab.
- Listen, insert, drag onto a track and **Fill the Selection (Loop)** work just like in the library, and so do the [SFX and Music](#sfx-and-music) groups.
- Right-click a favourite to **Rename…** it (`F2`), **Move Up** or **Move Down** in the list, or **Remove from Favourites** (`Delete`, or click its ★). The file itself is never deleted.
- A favourite whose file was moved or deleted is crossed out with the path it was at.

The sound library, the script and the transcript share the right side of the window: opening one closes the others.

## Sound design on clips

Right-click a clip › **Sound design**:

- **Reverse** plays the clip backwards.
- **Speed…** is varispeed like tape: pitch follows speed. Type `1.5`, `80 %` or semitones such as `+3 st`.
- **Loop** turns the clip into a loop: drag its right edge to repeat it as often as you like. Dashed lines show where each repeat starts.
- **Loop to next clip** fills the gap up to the next clip on the track (or to the end of the episode).
- **Loop over selection** fills a time range you selected before right-clicking.
- Dragging a clip's edge past the end of its audio loops it too, without the menu.
- **Play as recorded** undoes all of it.

Loop seams get a short crossfade. Fades, the volume line, splits and trims work on these clips as usual.

## Takes

Actors rarely get a line right the first time. Select the line and press `Alt+Shift+R` to loop-record it: every pass becomes a take, and you pick the best one, or splice the best parts of several, in the take lanes. See [Takes and comping](recording.md#takes-and-comping).

## Re-recording a line

A single fluffed line doesn't need a whole new take of the scene: select it, arm the actor's track and press `Shift+R`. WavePod plays a few seconds before the line so the actor hears the cue, records only the selected range and crossfades the new take into the scene. The old version stays a take you can pick again. See [Punch-in](recording.md#punch-in-re-record-one-line).

## Typical audio drama setup

1. **Track folders › Audio drama folders** creates Dialogue, SFX, Atmo and Music folders.
2. Give each character a track in Dialogue, named like the character, with Room & distance for the scene's place. Or record on any tracks and let the script's [character tracks](#character-tracks) sort the lines onto a track per character, each with its voice and room. For a headphone mix, put the characters on the [3D stage](#3d-stage-binaural).
3. Import the script. Record each line in a loop (`Alt+Shift+R`), comp the best take and tick the line off with `Enter`, or let **Line up** find the lines afterwards. Fix single fluffed lines later with a [punch-in](recording.md#punch-in-re-record-one-line) (`Shift+R`).
4. Give each scene its atmosphere with [scene ambience beds](#scene-ambience-beds), or lay atmospheres from the sound library with **Fill the Selection (Loop)** on Atmo tracks.
5. Tick **Duck under the other tracks** on the music to keep it under the dialogue.
6. Export the mix and, for broadcasters or festivals, **Stems › Dialogue, music and effects** with an M&E mix. See [Exporting](export.md#stems).

## Publishing on Audible

Audio dramas and audiobooks go to Audible through ACX, which checks every file's level, peaks, noise and room tone. Set a chapter marker at the start of each chapter (and of the opening and closing credits), then export with **Publish to › Audible ACX (audiobook)** and **Each chapter as its own file**. See [Audible ACX](export.md#audible-acx-audiobooks).
