# Transcript and text editing

WavePod can turn your episode into text and let you edit the audio by editing the text: delete words to cut them, let WavePod find pauses and filler words, and (experimentally) change words in the speaker's own voice.

Transcripts are made by **ElevenLabs** speech-to-text (Scribe), an online service. You need an ElevenLabs account and API key; transcribing uses credits on your account.

## Set up transcription

Open **Edit › Settings…** (`Ctrl+,`) › **General › Transcription**:

- **ElevenLabs API key**: from elevenlabs.io › Developers › API Keys. Click **Save key**. The key is kept encrypted with your system's keychain where there is one; **Remove key** deletes it.
- **Model** and **Language**: leave the language on automatic unless the model picks the wrong one.
- **Names and terms to get right**: guest names, products, places, separated by commas.

## Transcribe

Open the transcript with **View › Transcript** (`Shift+Ctrl+T`) or **Transcript** in the header, and click **Transcribe** (or use **Edit › Transcribe Episode**).

Each speaker track is uploaded as a small 16 kHz mono file and comes back with every word and its time. Only files without a transcript are sent, so transcribing again after recording more only sends the new parts. The transcript shows up as soon as the first track is done; transcribing goes on with the panel closed, and the **Transcript** button spins meanwhile.

Transcripts are stored per recorded file in the episode's `transcripts/` folder, in that file's own time, so they stay right through every cut, move and trim.

## Crosstalk

Because each track is transcribed on its own, speech-to-text also writes down the other speakers that bleed quietly into a microphone. WavePod leaves those words out: a word is dropped when another speaker track is much louder at the same moment, because that is the other person heard through this mic. The status line under the panel's buttons says how many words were left out.

Set this in **Edit › Settings… › General › Transcription › Crosstalk**:

- **Leave out words when another track is louder by**: 15 dB by default. Pick a smaller value if bleed still gets through, or a larger one if quiet words said over someone else go missing. **Off** keeps every word.
- **Leave out words quieter than**: an optional fixed level, from −40 to −60 dBFS, for noise and very quiet background talk. It's off by default.

Changes apply right away; nothing is uploaded again. Track and clip gain are taken into account when tracks are compared.

## Reading and cutting by text

The panel shows the episode as text, one paragraph per speaker turn. Hesitations (äh, ähm, uh, um, …) are underlined.

- **Click a word** to jump there.
- **Drag across words** to select their time.
- Press `Delete` (or `Backspace`) to cut the selection out of all tracks; the gap closes and everything stays in sync. `Ctrl+Z` brings it back.

**Save as…** writes the transcript as **Text with speakers (.txt)** with times, or as **Subtitles (.vtt)**.

AI agents can read the transcript (for show notes or chapter titles) through the `get_transcript` tool. See [AI agents (MCP)](ai-agents.md).

## Clean up pauses and hesitations

**Edit › Clean Up Pauses and Hesitations…** (`Shift+Ctrl+K`, or **Clean up…** in the transcript) finds:

- **pauses** in the mix longer than a set length (1.5 s by default), and shortens them to a set length (0.7 s) by cutting out their middle, so the breaths at both ends stay;
- **hesitations** from the transcript (äh, ähm, öhm, hm; uh, um, erm in English). Each cut is moved onto the quiet points around the sound. If someone else talks at that moment, the hesitation is muted on its own track instead of cut.

Listen to each find with **▶** (from a little before to a little after), untick what should stay, then:

- **Apply** to make all the cuts (one undo step), or
- **Mark only** to put edit markers there and decide by hand.

Hesitations need a transcript first; pauses don't.

## Changing words (experimental)

You can replace a word, or insert new words, spoken in the speaker's voice by ElevenLabs text-to-speech. Use it to fix a misspoken name or a missing word.

1. Double-click a word in the transcript, or click or select words of one speaker and press `Enter` or **Change…**.
2. Choose **Replace**, **Insert before** or **Insert after**, and type the words.
3. Choose the voice:
   - **Clone voice** makes an instant voice clone from up to 90 seconds of that track's own transcribed speech. You confirm that you have the speaker's permission. The clone is remembered on the track and can be deleted from your ElevenLabs account again with **Delete it from ElevenLabs**.
   - Or pick any voice of your ElevenLabs account.
4. **Listen** (`Enter`) plays the take. **Put in** (`Ctrl+Enter`) puts it into the episode.

The speaker's words around the edit are sent along so the intonation fits. When the take goes in, the silence around it is trimmed, its gain matches the speaker's level around the edit, the range is cut out of (or room made on) every track so they stay in sync, and the cut edges get short fades. The new clip is saved as `media/tts-….wav` with a transcript of its own, so it shows in the text. `Ctrl+Z` undoes it.

Takes are 24 kHz unless **High quality** (44.1 kHz, needs an ElevenLabs Pro plan) is ticked. Every take costs ElevenLabs text-to-speech credits.
