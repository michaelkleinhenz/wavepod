# Remote guests

Record guests who aren't in the room. They open an invite link in their browser, you talk over a live call, and each guest's browser records their microphone untouched. That recording comes to your computer while you talk and goes on their track when you stop, lined up with the call. The episode gets their full microphone quality, not the call's.

Video is optional and only there so you can see each other. It is never recorded.

## What you need

The live call runs through [LiveKit](https://livekit.io), an open-source call server. WavePod has no server of its own, so you bring one:

- **LiveKit Cloud:** create a free project at cloud.livekit.io and copy its URL, API key and API secret (Settings › API keys). The free plan is enough for a weekly show with a few guests.
- **Your own server:** run `livekit-server` and use its address, key and secret.

Open **Edit › Settings… › Remote guests**, fill in **Server URL**, **API key** and **API secret**, and press **Test Connection**. The secret is stored encrypted by the system keychain where available and never leaves this computer.

Guests need a current Chrome, Edge, Firefox or Safari, a microphone and headphones. Nothing to install, no account.

## LiveKit server

The settings tab has these fields:

- **Server URL**, **API key**, **API secret**: your LiveKit project. When they are empty, WavePod uses `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from the environment, if set.
- **Guest page**: where invite links point. The project's own page works; change it only if you host the page yourself (it is in `site/join/v1/` of the source).
- **Allow video**: guests and you can switch a camera on, at a small size, for eye contact. Video is never recorded.

## Invite a guest

1. Open **View › Remote Guests** (`Shift+Ctrl+G`). The panel floats over the window and stays open while you record.
2. Press **Open Session**.
3. Type the guest's name and press **Invite**. WavePod adds an armed track for them, marked **Remote** in its header (its input list reads **Remote guest**: the audio comes over the internet, not from an input), and copies the invite link. Send it to them by mail or chat.
4. The guest opens the link, picks their microphone and joins. They wait until you press **Let In** next to their name.

**Copy Link** gives you a fresh link for the same guest at any time, for example when they come back on another day. **Hold Back** sends them back to the waiting room; **Remove** ends their call. **End Session** closes the call for everyone; their recordings that haven't arrived yet keep coming the next time they open the link.

## Microphone and camera

With video allowed, **Camera on** in the panel shows your camera to the guests. When the computer has more than one camera, a list next to the button picks which one; switching works while the camera is on, and WavePod remembers the choice.

Guests pick their microphone before they join. During the call, their page shows a microphone list (and a camera list when video is on and they have more than one camera), so they can switch without leaving; a switch during a take keeps recording into the same take.

A guest's track records like any other track. You hear guests on your main output, and they hear you, your other guests, jingles and playback, but never themselves.

## While recording

Press `R` as usual. Each guest's page shows **Recording** and starts keeping its own copy of the microphone in one-second pieces, with two seconds from before you pressed record. The pieces are sent to you as you talk. The panel shows for every guest:

- the round trip of their connection and how good it is,
- **Recording locally, 12 s received**, or how far the upload is behind,
- whether their browser can keep a copy (in a private window it can't, so they should keep the tab open until you have everything).

If a guest's connection drops, the call audio has a gap, but their own recording goes on and is sent when they are back. If they close the tab or their browser crashes, they open the invite link again: what was kept is sent, and the rest of the take is recorded as a second part.

## After recording

When you stop, the call audio stays on the guest's track until their recording has fully arrived. Then it goes on the track as a new take, lined up with the call audio, and the panel says how far it was moved (for example **Lined up with the call audio (moved 120 ms)**). Clock drift between their computer and yours is fixed with a drift-corrected copy of the file.

The call audio stays as the earlier take, so you can switch back to it with `T` / `Shift+T` or the take lanes ([Takes and comping](recording.md#takes-and-comping)). If the recording can't be lined up (for example when the guest was muted for the whole take), it is placed by timing and the panel says so; check it by ear.

The files are in the episode's `media` folder, named after the guest: `Alex-remote-t….wav`.

## Privacy

The call (audio, and video if on) goes through the LiveKit server you set up. The guest's recording goes from their browser to your computer through the same connection and is kept in their browser until you have it all; then their copy is deleted. The guest page keeps no other data and uses no cookies or tracking.

## Troubleshooting

- **The guest can't join:** check **Test Connection** in the settings, and that the session is open. Links are valid for 24 hours; **Copy Link** makes a new one.
- **The guest hears themselves or an echo:** they should wear headphones.
- **"This browser records at 44100 Hz":** the guest's browser couldn't record at the episode's sample rate. Only the call audio is kept for them; a 48 kHz episode avoids this.
- **The upload is far behind:** the guest's upload is slow. It catches up after recording; keep the session open until the panel says the recording is on the timeline.
