# 04 · Lyric captions (Spotify-style)

**Brief:**
The audio in the project is a 12-second song. Make a 1080×1920 lyric video with these lines, each one highlighted while it is sung:
- 0.0–3.0 s "City lights are calling"
- 3.0–6.0 s "I can hear them in the rain"
- 6.0–9.0 s "Every step a heartbeat"
- 9.0–12.0 s "Bringing me back home again"
Show the current line large and bright, the next one dimmer, the sung ones faded; the block should scroll up as lines change. Calm gradient background.

**AtomCut's recipe (the bar):** each line a caption layer (6–7U, 800, left-aligned, max width 80 %) with states unread 0.55, focus 1.0, read 0.35, stacked in an auto-layout column (gap 1.5U) inside a group at the left margin; the group's `y` keyed so the current line stays at one height, moving up by line height + gap over 350 ms ease-in-out at each line; a soft blurred album art or slow gradient behind; no sounds.

**Media:** `song.wav` (12 s), imported by the runner before the brief.
