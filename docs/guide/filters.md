# Filters and effects

Every track, every clip and the master bus can have a stack of filters: EQ, compressor, noise reduction, voice effects and your installed VST3 plug-ins. Filters work live while you play, so you hear every change at once, and the export uses exactly the same settings.

## The FX panel

The filters are the **FX** tab of the [sidebar](timeline.md#the-sidebar) right of the timeline. Open it with **FX** in a track header, **FX** on a clip, the **FX** tab, or **View › Filters** (`Shift+Ctrl+F`). It stays open while you move between tracks; click another track's **FX** to switch to it, or **All tracks** at the top to pick the master bus or a track from a list. Clicking the **FX** button of the track that is showing folds the sidebar away again.

- **+ Add filter…** adds a built-in filter, a voice effect, a place, or a VST3 plug-in.
- **Voice chain** (on a track without filters) adds High-pass, De-esser and Dynamics: a good start for any voice.
- Filters run **top to bottom**, before the track gain and pan. Drag a card by its grip to reorder it, or use the up and down arrows.
- The checkbox on a card bypasses the filter; **×** removes it.
- Click the arrow on a card, or double-click its title, to fold its settings away. Folded cards stay folded.
- While playing, each card shows the level going in and out and how much the filter is turning the sound up or down.

Every slider's value can be clicked to type an exact number, such as `-3,5 dB`, `1.2 kHz` or `250 ms`.

## Built-in filters

| Filter | What it is for |
| --- | --- |
| **High-pass** | Removes rumble, handling noise and plosive thumps below the voice. |
| **Equalizer** | Parametric EQ: low shelf, two bell bands and a high shelf. |
| **Voice match** | Makes a voice sound like a reference: a guest's mic like the host's, or a retake like the original take. See [Repair filters](#repair-filters). |
| **Noise gate** | Turns the track down while nobody speaks into it (room noise, other speakers bleeding in). Pre-open looks ahead so the gate is already open when a word starts. |
| **Voice leveler** | Rides each speaker's level slowly towards a target, like a hand on the fader, before the compressor. See [Repair filters](#repair-filters). |
| **Compressor** | Evens out loud and quiet passages of a voice. |
| **De-esser** | Tames sharp "s" and "sh" sounds by turning down only the highs when they get loud. |
| **Smart de-esser & de-plosive** | Tames "s" sounds and "p"/"b" pops only where they happen, by comparing them with the rest of the voice, at any level. See [Repair filters](#repair-filters). |
| **Limiter** | Keeps peaks below the ceiling. |
| **Dynamics** | Brings a voice to an even target loudness: quiet speech is raised, loud speech is held back, and everything below the noise gate is muted. A port of Ultraschall's Dynamics. |
| **Noise reduction** | Turns down steady background noise (hiss, hum, fans, air conditioning) between and under the words. It learns the noise by itself from the quiet moments. |
| **De-clip** | Rebuilds peaks that were cut flat because the recording was too loud. See [Repair filters](#repair-filters). |
| **De-hum** | Removes the 50 or 60 Hz hum and buzz of a ground loop or a bad cable, following its exact frequency. See [Repair filters](#repair-filters). |
| **Speech restoration** | Brings back the highs and lows that a phone line, a Zoom or Teams call or a low-bitrate recording cut off, so a remote guest sounds fuller next to a studio mic. See [Repair filters](#repair-filters). |
| **AI voice cleanup** | Separates the voice from background noise and from the room's echo with a neural network, and gives each part its own level: Voice, Ambience and Reverb. See [AI voice cleanup](#ai-voice-cleanup). |
| **Mouth de-click** | Removes lip smacks, tongue clicks and the sticky clicks of a dry mouth, and fills each one in from the voice around it. See [Repair filters](#repair-filters). |
| **Breath control** | Finds the breaths between phrases and turns them down, without cutting them out. See [Repair filters](#repair-filters). |
| **Reverb** | Adds room to a dry signal, for example a jingle bed or a voice that sounds too close. **Decay (RT60)** sets how long the tail lasts in seconds (a furnished room is about 0.3–0.5 s, a church 2–4 s); **Room size** sets how dense and spread out it is. |
| **Band-pass** | Keeps only the frequencies between the low and the high cut: telephone, radio and walkie-talkie voices, or a muffled voice behind a wall. |
| **Distortion** | Saturation, clipping or fuzz, optionally with fewer bits and a lower sample rate. |
| **Echo** | Repeats the sound after a delay, each repeat a little duller. |
| **Room & distance** | Puts a voice into a place and moves it closer or further away. See [Audio drama](audio-drama.md#places). On a track on the [3D stage](audio-drama.md#3d-stage-binaural), the stage sets the distance. |
| **Convolution reverb** | Puts the sound into a real room by convolving it with an impulse response (IR), a WAV recording of that room. See [Impulse responses](audio-drama.md#impulse-responses). |
| **Pitch shift** | Makes a voice higher or lower without changing its speed. |
| **Ring modulator** | Makes a voice metallic: robots, aliens, broken machines. |
| **Chorus / flanger** | Chorus, flanger and vibrato: magic, dreams, teleports, ghosts. |

Hold the mouse over a filter's name in the panel for a fuller description. Filters that need to look ahead (Noise gate, Voice leveler, Dynamics, Noise reduction, AI voice cleanup, Mouth de-click, Breath control, Smart de-esser & de-plosive, De-clip, Pitch shift, Convolution reverb) add a little latency, which WavePod compensates, so tracks stay in sync.

For the voice effects (telephone, robot, giant, …) and places (kitchen, church, forest, …), see [Audio drama](audio-drama.md).

## AI voice cleanup

**AI voice cleanup** takes a recording apart into three parts and lets you mix them back at the level you want:

| Control | What it sets |
| --- | --- |
| **Voice** | The dry voice. Leave it at 0 dB, or raise it a little to bring a speaker forward. |
| **Ambience** | Everything that is not the voice and not the room's echo: fan and air-conditioning noise, hum, traffic, wind, a café, music playing in the background. |
| **Reverb** | The echo of the room on the voice: the hollow sound of a kitchen, an office or a large hall. |

All the way down (**Off**, −60 dB) a part is gone; 0 dB leaves it as it was recorded. With all three at 0 dB you hear the original. By default the filter removes the background completely and leaves a little room (−15 dB), which sounds natural; the presets cover the common cases:

- *Studio voice* removes all noise and room, as if recorded in a booth.
- *Natural room* and *Street interview* keep a hint of the place.
- *Noise only* and *Room only* touch just one of the two.
- *Remote guest* is made for laptop and phone recordings.
- *Atmo only (no voice)* keeps only the background, for room tone and atmos in an audio drama.

How it works: a neural network ([DeepFilterNet 3](https://github.com/Rikorose/DeepFilterNet)) separates speech from everything else, and a room model predicts the echo of each sound from what was said a moment before, using the room's reverberation time. WavePod measures that time by itself from how fast the sound dies away after words, so the Reverb control gets better over the first 10–20 seconds of a recording; a jump in the timeline keeps what it has learned.

Good to know:

- It runs **on your computer**, on the processor (no graphics card needed), and nothing is uploaded. Each mono track takes roughly a tenth of one processor core; a stereo track twice that.
- It is meant for **voices**. On music, singing or sound effects it takes away much of what you want to keep. Put it on the voice tracks, not on the master.
- It adds about **40 ms of latency**, which WavePod compensates during playback and export. Your recordings stay untouched: the filter works live while you play and edit, and in the export. WavePod does not send inputs through filters while recording, so what you hear on headphones while recording is not cleaned.
- Very strong settings on a very noisy or very echoey recording can make a voice sound thin or slightly processed. Turning **Ambience** or **Reverb** up a few dB from Off usually sounds more natural than removing everything.
- The simpler **Noise reduction** filter needs far less processing power and is enough for steady hiss.

## Repair filters

The repair filters fix small faults in a voice recording that the listener notices more than you would think. Like everything else in WavePod they run on your computer and work live while you play, so you hear every change at once.

### Mouth de-click

**Mouth de-click** removes the small noises a mouth makes between and inside words: lip smacks, tongue clicks, and the sticky saliva clicks of a dry mouth. Each of these lasts only a few thousandths of a second and is much sharper than the voice around it. The filter finds them and fills each one in with what the voice just before and just after it predicts, so the words themselves stay as they were.

| Control | What it sets |
| --- | --- |
| **Sensitivity** | How far a sound has to stand out from the voice around it to count as a click. Higher catches quieter clicks. |
| **Click length** | The longest sound that still counts as a click (0.5–10 ms). Raise it for long, wet lip smacks; lower it if sharp consonants lose their edge. |
| **Listen to** | *Clicks only* plays just what the filter takes out. Turn up Sensitivity until you hear the clicks, and stop before you hear bits of words. |

Start with the default or the *Dry mouth* preset. If a sharp *t*, *k* or *p* sounds dull afterwards, lower Sensitivity or Click length. Put the filter first on the track, before compressor and Dynamics, because those make clicks louder. It adds about 27 ms of latency, which WavePod compensates.

### Breath control

**Breath control** finds the breaths between phrases and turns them down instead of cutting them out. A podcast without any breaths sounds unnatural, but loud gasps, especially after a compressor, are tiring to listen to. The filter recognises a breath as soft, unvoiced sound that sits well below the speaking level and above the room noise, and lasts at least **Shortest breath**. It learns both levels by itself in the first seconds.

| Control | What it sets |
| --- | --- |
| **Reduction** | How far breaths are turned down. −9 to −12 dB keeps them natural; −30 dB or more almost removes them. |
| **Sensitivity** | Higher also catches softer and shorter breaths, and breaths closer to the speaking level. |
| **Shortest breath** | Shorter unvoiced sounds are left alone, so soft word endings stay. |
| **Listen to** | *Breaths only* plays just what the filter turns down. If you hear bits of words, lower Sensitivity. |

Put Breath control before the compressor and Dynamics, which would otherwise raise the breaths again. The filter needs to hear a whole breath before it acts, so it adds about 160 ms of latency, which WavePod compensates.

### Smart de-esser & de-plosive

**Smart de-esser & de-plosive** handles two faults of close-up speech in one filter: sharp *s* and *sh* sounds, and the low thump of air hitting the mic on *p* and *b*. Unlike the plain **De-esser**, it has no threshold to set. It compares the highs with the whole voice (for *s*) and the lows with the rest of the voice (for pops), so it works the same on a quiet and on a loud recording. It turns the band down only as far as needed for a natural balance, and never more than the amount you set. Wherever there is no *s* and no pop, the voice passes untouched.

| Control | What it sets |
| --- | --- |
| **De-ess** | The most the highs are turned down on an *s*. **Off** switches the de-esser part off. |
| **S sensitivity** | Higher treats milder *s* sounds too. |
| **S frequency** | Where sibilance starts: about 4–5 kHz for deeper voices, 6–7 kHz for higher voices. |
| **De-plosive** | The most the lows are turned down on a pop. **Off** switches the de-plosive part off. |
| **Pop sensitivity** | Higher treats softer pops too. |
| **Pop frequency** | The top of the pop band. Raise it for very boomy pops. |
| **Listen to** | *What is removed* plays only what the filter takes away. |

The presets *Male voice* and *Female voice* set the two frequencies; *De-ess only* and *De-plosive only* switch one part off. It adds 3 ms of latency, which WavePod compensates.

### De-hum

**De-hum** removes mains hum: the low 50 Hz (Europe, Asia, Africa, Australia) or 60 Hz (the Americas) tone you get from a ground loop, a bad cable, a laptop on its charger or a dimmer, together with its overtones, which make it sound like a buzz. The mains frequency is never exactly 50 or 60 Hz and drifts a little, so the filter measures it itself and follows it. It then learns the hum's steady level and subtracts exactly that, which leaves the voice untouched. A notch filter would also cut the voice at those frequencies.

| Control | What it sets |
| --- | --- |
| **Mains** | *Find it* works out whether the hum is at 50 or 60 Hz; choose 50 or 60 Hz if you know it. |
| **Harmonics** | How many overtones are removed. A soft, low hum needs 2–4; a harsh buzz up to 20 or more. |
| **Listen to** | *Hum only* plays just what the filter takes out. If you hear voice in it, use fewer harmonics. |

The filter needs about half a second to find the hum and a second to remove it completely, also after you jump to another place in the episode. It adds no latency. For broadband noise such as hiss or fans, use **Noise reduction** or **AI voice cleanup** instead.

### De-clip

**De-clip** repairs clipping: when the input was turned up too far, the loudest moments hit the top of the range and their peaks were cut off flat. That sounds like a harsh crackle on loud words or laughter. The filter finds runs of samples stuck at the highest level and redraws the round top the waveform should have had, from the sound just before and after each peak.

| Control | What it sets |
| --- | --- |
| **Shortest clip** | How many samples in a row have to be stuck at the top to count as clipped. 3 is safe; 2 also catches the lightest clipping. |
| **Output gain** | The rebuilt peaks go higher than the old maximum, so the filter turns its output down a little (−3 dB by default) to make room. A **Limiter** later in the chain works too. |
| **Listen to** | *Rebuilt peaks only* plays just what the filter adds back. |

Put De-clip first on the track, before any other filter, because it has to see the flat tops exactly as they were recorded. It repairs short clipping (up to 5 ms per peak) very well. A recording that was distorted heavily for long stretches can be improved, but not restored. It adds about 16 ms of latency, which WavePod compensates.

### Voice leveler

**Voice leveler** does what a sound engineer does with a hand on the fader. A guest who leans back, turns away or trails off at the end of sentences is brought up slowly, and one who gets excited and loud is brought down. It changes the level smoothly over a second or so, so the voice keeps its own dynamics within a sentence. Use one on each speaker's track, before the compressor, which then only has to catch the short peaks.

| Control | What it sets |
| --- | --- |
| **Target** | The loudness (LUFS) the speaker is brought to. −20 LUFS is a good level before compressor and limiter. |
| **Range (±)** | The most it turns a speaker up or down. |
| **Speed** | How quickly it follows: *Slow* for calm narration, *Fast* for remote guests whose level jumps around. |

Only speech moves the leveler. In pauses, breaths and room noise it holds still, so it does not pump the background up between sentences. It looks 300 ms ahead so it can move before a phrase starts. That adds 300 ms of latency, which WavePod compensates. The card shows how far it is currently turning the speaker up (+) or down (−).

The **Dynamics** filter also brings a voice to a target loudness, but it acts faster and gates the noise. Use Voice leveler when you want a natural, slow correction, or put it before Dynamics to give it an even start.

### Voice match

**Voice match** makes one voice sound like another recording. Typical cases:

- A guest's mic sounds thin or boomy next to the host's: put Voice match on the guest's track and match it to the host.
- A retake or pickup recorded on another day (another room, another mic position) stands out from the rest. Give that clip its own filter (**FX** on the clip) and match it to *the rest of* its track.

Add the filter, choose the voice to sound like under **Sound like**, and press **Learn**. WavePod compares the tone of the speech in both (pauses are left out) and sets a smooth EQ that brings this voice towards the reference. The card then shows the learned curve: above the line is raised, below is lowered. Hold the mouse over it to see each band.

| Control | What it sets |
| --- | --- |
| **Amount** | How far the voice moves towards the reference. 100 % is the whole difference; 50–80 % keeps some of the voice's own character. |
| **Detail** | *Broad* follows only the overall shape (smooth, safe); *Fine* also matches narrow differences, such as a resonance of the room or the mic. |

Good to know:

- Only the tone is matched, not the loudness. Level the voices with Voice leveler or Dynamics.
- Learn needs a few seconds of speech in both, and works best with a minute or more. Learn again after you have recorded or cut a lot.
- It matches what the mic and room did to the voice, not the voice itself. Two different people keep sounding like themselves, just as if they had used the same mic.
- Voice match cannot bring back missing frequencies: a phone line has nothing above about 3.5 kHz, so it leaves those bands alone. Put **Speech restoration** before it to rebuild them first.
- Save a learned match as a preset (for example *Guest on the SM7B*) to use it in the next episode. The preset keeps the curve.
- AI agents can do the same with `match_voice`.

It adds no latency.

### Speech restoration

**Speech restoration** is for a guest on a phone line, a Zoom, Teams or Skype call, or an old low-bitrate MP3. Those cut off the top of the voice (above 3.4 kHz on a phone, 7–8 kHz on most calls) and, on a phone, the bottom below about 300 Hz, so the guest sounds small and boxed in next to a studio mic. The filter finds where the voice was cut off and rebuilds the missing parts from the voice that is there: the overtones above the edge grow from the octave below it, and the fundamental below a phone's edge grows from the octave above. Each rebuilt band rises and falls with the voice and is kept at about the level a full-range voice has there.

| Control | What it sets |
| --- | --- |
| **Source** | *Find it* listens to the speech and finds the limits by itself (it needs a second or two of speech, and the card's meter starts moving when it has found them). Or pick the kind of recording: *Phone*, *Mobile / HD voice*, *Zoom, Teams, Skype* or *Low-bitrate MP3*. |
| **Highs** | Level of the rebuilt highs. 0 dB is a little under a natural voice; turn it down if *s* sounds get harsh, all the way down to switch the highs off. |
| **Lows** | Level of the rebuilt lows (only on phone-like recordings that have none). All the way down switches them off. |
| **Listen to** | *What is added* plays only the rebuilt parts, to hear what the filter does. |

Good to know:

- It cannot bring back what was never recorded: the words stay as clear as they were, but the voice no longer sounds like it comes through a pipe.
- If the recording has nothing missing, the filter adds nothing.
- Put it early in the chain, after noise reduction or AI voice cleanup (so it does not rebuild noise) and before Voice match and the compressor.
- The card shows how much it adds, in dB.

It adds no latency.

## Presets

Every filter card has a **Presets…** menu.

- Built-in filters come with **factory presets** tuned for speech, for example Compressor *Spoken word*, EQ *Clarity for dynamic mics*, Noise reduction *Computer fan*, AI voice cleanup *Studio voice* or Mouth de-click *Dry mouth*. Hover one to see what it is for. *Default* goes back to the starting values.
- VST3 plug-ins offer their own programs (factory presets) there.
- **Save as preset…** stores the current settings (for VST3 plug-ins including the plug-in's state) as your own preset, available in every episode. Rename (✎) or delete (🗑) the preset that is loaded.
- The menu shows *(edited)* once you change a value after loading a preset.

Your presets are JSON files in `Documents/WavePod/Presets/`, one folder per filter or plug-in, so you can copy them to another computer.

## Copy and paste filters

- **Copy all** in the panel copies a track's whole filter stack; the copy button on a card copies just that filter.
- Open another track (or Master) and use **Paste…** to add the filters at the end or at the top, or to replace the stack.
- When the copied filter is the same kind as a card (the same built-in filter or the same VST3 plug-in), that card offers **Paste settings**, which keeps its place and bypass.

Copies include VST3 state and the preset name, work across episodes, and each paste is one undo step.

## Clip filters

Hover a clip and click **FX** on it to give just that clip filters of its own. They run after the track's filters. Use them when one part of a track needs different treatment, for example a phone voice for one line, or one clip further away than the next.

## Group FX

A group FX chain is one filter stack shared by several clips, for example every line a character speaks through a radio, or all the clips of one interview recorded in another room.

1. Select the clips: **Shift**+click them, or **Shift**+drag a rubber band over them. They can be on different tracks.
2. Every selected clip now shows its **FX** button. Click it on any of them: the FX tab opens the clips' group FX chain.
3. Add filters as usual. They apply to every clip of the group, and changing a setting changes it for all of them.

Grouped clips show a blue **FX** button with a corner mark. Clicking **FX** on any of them later opens the group chain again, even with only that clip selected.

- **Remove** next to a clip in the group's list takes that clip out: the group's filters no longer apply to it. **Ungroup all** takes every clip out and deletes the chain. The clip menu has **Remove from group FX** as well.
- **Add selected** adds clips you have selected to the group. Selecting clips of one group together with clips in no group and clicking **FX** does the same.
- Selecting clips from different groups (or with none) and clicking **FX** makes a new group for them. If they all have the same clip filters of their own, those move into the new group, so nothing sounds different.
- A clip can still have filters of its own: they run first, then the group's (both after the track's filters). **Own FX** in the group's list opens them.
- Each clip runs the chain on its own, so a reverb or echo rings out after each clip as with clip filters. Splitting, copying or duplicating a grouped clip keeps the copies in the group.

Groups are saved with the episode, every change is one undo step, and the export renders them like any other filter.

## Master FX

**Master** at the top of the FX tab's track list holds the filters on the whole mix (click **All tracks** in the FX tab to get to the list). A **Limiter** at the end keeps peaks below a ceiling. The master filters are applied to the export but not to stems.

## VST3 plug-ins

Installed VST3 effects appear under **+ Add filter… › VST3 plug-in…**. They work in the same stack as the built-in filters, with plain sliders for their parameters instead of the plug-in's own window.

VST3 plug-ins run in a separate process, so a crashing plug-in can't take a recording down. Their settings are saved with the episode, in templates and in presets.

## Let an AI agent set up your filters

With **AI agents** switched on in the settings, an AI app such as Claude can build and tweak filter stacks for you: "give every speaker the voice chain and put a limiter at −1 dB on the master". See [AI agents (MCP)](ai-agents.md).
