# 05 · Reel from a long video

**Brief:**
Turn the 20-second landscape video in the project into a 1080×1920 reel of about 10 seconds: keep the most interesting parts, fill the frame, add punch-ins every other cut, captions, and a title card for the first second.

**AtomCut's recipe (the bar):** `media_transcribe` the source, pick the hook and the 3–5 strongest lines, a new 1080×1920 comp with the source nested and scaled to cover, `x` keyed to follow the speaker, `timeline_cut_ranges` everything else in one call (captions stay in sync), `media_remove_pauses`, punch-ins (scale 1 → 1.1) at every other cut, captions (`maxWords: 3`) and a title card for the first second.

**Media:** `long.mp4` (20 s, 1280×720 test footage with a tone; no speech, so transcription cannot be judged here), imported by the runner before the brief.
