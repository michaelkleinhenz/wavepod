# Audio drama

WavePod has the tools for fiction and sound-rich productions: a script that knows what is recorded, voice effects, rooms and distance, a searchable sound effects library and sound design on clips. Together with [track folders](tracks-mixing.md#track-folders), [automation](tracks-mixing.md#automation) and [stem export](export.md#stems) they cover a full audio drama.

## Script

Import the script and WavePod keeps track of every line: who speaks it, whether it is recorded and where its take is on the timeline.

### Importing a script

**File › Import Script…**, or **Import script…** in the script panel. Three formats work:

- **Plain text** (`.txt`): one speech per line as `NAME: what they say`. A direction for the actor goes in brackets after the name: `BEN (whispering): It is late.` Lines starting with `INT.`, `EXT.`, `Scene 2`, `Szene 2` or `#` are scene headings. Everything else is a stage direction. A line `Title: …` at the top names the script.
- **Fountain** (`.fountain`): the plain-text screenplay format that many writing apps export (Highland, Slugline, Fade In, Beat, WriterSolo…). Character names in capitals above their words, scene headings like `INT. PLATFORM - NIGHT`. Notes `[[…]]` and boneyard `/* … */` are left out.
- **Final Draft** (`.fdx`).

WavePod recognises Fountain in a `.txt` file by itself. Importing again (for a revised draft) keeps the ticks of every line that stayed the same.

### The script panel

Open **View › Script** (`Shift+Ctrl+J`), or click **Script** in the header. It shows:

- the script's progress: how many lines are recorded,
- every character with their recorded and total lines. Click a character to see only their lines (handy in a session with one actor), click again for everyone,
- **Tracks**: the track each character is recorded on. Characters go to the track with their name by themselves (*Anna* for ANNA, *Dr. Hill* for HILL); pick another track here,
- the lines, scene by scene, with stage directions in grey. **Open lines only** hides what is ticked off.

### Ticking lines off while recording

Click the box in front of a line to tick it off. WavePod notes where the playhead is, on the character's track, so the line can be found again later. In a recording session:

1. Click the first line to record (or walk there with `↑` and `↓`).
2. Record. After each line is done, press `Enter`: the line is ticked off at the playhead and the next open line is picked.
3. `Delete` unticks the picked line.

Ticked lines remember their place in the recording itself, so they stay found after cuts, moves and trims.

### Lining up with the transcript

**Line up** finds the lines in the recording by itself. It uses the [transcript](transcript.md) (and transcribes what is missing first, which needs the ElevenLabs key) and looks for each line on its character's track, allowing for misheard and missing words. Every line it finds is ticked off with its take.

- When a line was recorded several times, the row says how many takes the transcript holds (for example *3 takes*). The best take is used; of equally good ones, the last, which is usually the one that was kept.
- Very short lines (*Yes.*) are only looked for between the lines around them, so they aren't matched just anywhere.
- Lines ticked by hand keep their place, and Line up never unticks a line.

### Jumping

- Click a line to jump to its take. Its time is selected too, so **Repeat** (`L`) plays it over and over. `Shift+Enter` does the same for the picked line.
- Click a scene heading, or pick it in **Jump to scene…**, to jump to the first recorded line of that scene. The list shows each scene's progress.
- While playing, the line you hear is highlighted.

The **⋯** menu imports a new draft, ticks all lines off again or removes the script (the recording stays as it is). The script is saved with the episode. AI agents can read it with the `get_script` tool. See [AI agents (MCP)](ai-agents.md).

The script, the sound library and the transcript share the right side of the window: opening one closes the others.

## Voice effects

**+ Add filter…** in the FX panel has a **Voice effects (audio drama)** group:

- **Devices:** Telephone, Mobile phone, Old radio, Walkie-talkie, Megaphone.
- **Where it sounds from:** Next room, Outdoor, Far away, Bathroom, Church, Cave, Underwater.
- **Creatures and machines:** Robot, Broken robot, Alien, Giant / monster, Demon, Small creature, Child-like voice, Chipmunk.
- **The unreal:** Flashback / dream, Magic / spirit, Ghost, Time travel / teleport, Dream sequence.

Each voice effect adds a few ordinary filters set from their presets, so every value stays editable afterwards. The building blocks are filters of their own: **Band-pass**, **Distortion**, **Echo**, **Pitch shift** (−24 to +24 semitones, speed kept), **Ring modulator** and **Chorus / flanger**. See [Filters and effects](filters.md#built-in-filters).

Put a voice effect on a whole track (a character who is always a robot) or on a single clip (one line on the phone). See [Clip filters](filters.md#clip-filters).

## Places

The **Places: room & distance** group puts a voice into a room with the **Room & distance** filter: close to the mic, living room, bedroom, small kitchen, bathroom, car, office, classroom, stairwell, basement, garage / warehouse, church, concert hall, cave, tunnel, forest, open field and street.

Its **Distance** (in metres) moves the speaker away: the voice gets quieter, loses highs and bass, and the room takes over, as if the speaker walked away. Below 1 m it gets the bass of speaking close to the mic. Use [volume and pan automation](tracks-mixing.md#automation) or clip filters to have a character walk past.

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

## Sound library

Keep your sound effects and atmospheres in a folder and search them from inside WavePod.

1. Choose the folder in **Edit › Settings… › General › Sound library** (subfolders are included).
2. Open **View › Sound Library** (`Shift+Ctrl+B`), or click **Sounds** in the header.
3. Type to search file and folder names, for example *door creak* or *forest wind*. Words match the start of words in the names.
4. `↑` and `↓` walk the results and play each one (switch this off with the listen toggle). **Listen** plays the selected sound.
5. `Enter` or a double-click inserts the sound at the playhead. Or drag a row onto any track.

**Insert on** chooses where sounds go: by default a *Sound effects* track, created when needed. Right-click a sound for **Insert at the Playhead**, **Insert on a New Track**, **Fill the Selection (Loop)** and **Show in Folder**.

**Fill the Selection (Loop)** repeats a sound over the selected time range with crossfades: ideal for room tone, wind, rain and other atmospheres.

WAV, MP3, FLAC, Ogg, Opus, M4A and AIFF files are found. **Rescan** reads the folder again after you add sounds. Sounds you insert are copied into the episode, so it keeps working without the library.

### Favourites

The **★ Favourites** tab at the top of the sound library holds the sounds you use again and again: your intro and outro, jingles, intermissions, a stinger, room tone. They are part of WavePod's [app settings](settings.md), not of the episode, so every episode has them.

- **Add sounds…** adds audio files from anywhere on your computer; they don't have to be in the library folder.
- In the **Library** tab, click the ☆ next to a sound (or right-click › **Add to Favourites**), or drag it onto the Favourites tab.
- Listen, insert, drag onto a track and **Fill the Selection (Loop)** work just like in the library.
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
- **Play as recorded** undoes all of it.

Loop seams get a short crossfade. Fades, the volume line, splits and trims work on these clips as usual.

## Takes

Actors rarely get a line right the first time. Select the line and press `Alt+Shift+R` to loop-record it: every pass becomes a take, and you pick the best one, or splice the best parts of several, in the take lanes. See [Takes and comping](recording.md#takes-and-comping).

## Re-recording a line

A single fluffed line doesn't need a whole new take of the scene: select it, arm the actor's track and press `Shift+R`. WavePod plays a few seconds before the line so the actor hears the cue, records only the selected range and crossfades the new take into the scene. The old version stays a take you can pick again. See [Punch-in](recording.md#punch-in-re-record-one-line).

## Typical audio drama setup

1. **Track folders › Audio drama folders** creates Dialogue, SFX, Atmo and Music folders.
2. Give each character a track in Dialogue, named like the character, with Room & distance for the scene's place.
3. Import the script. Record each line in a loop (`Alt+Shift+R`), comp the best take and tick the line off with `Enter`, or let **Line up** find the lines afterwards. Fix single fluffed lines later with a [punch-in](recording.md#punch-in-re-record-one-line) (`Shift+R`).
4. Lay atmospheres from the sound library with **Fill the Selection (Loop)** on Atmo tracks.
5. Tick **Duck under the other tracks** on the music to keep it under the dialogue.
6. Export the mix and, for broadcasters or festivals, **Stems › Dialogue, music and effects** with an M&E mix. See [Exporting](export.md#stems).
