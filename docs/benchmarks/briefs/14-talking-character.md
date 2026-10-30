# 14 · Talking character

**Brief:**
Make a 6-second 1920×1080 clip where a friendly hand-drawn person (an Open Peeps sticker) stands on the left of a warm cream frame and says the voice line in the project ("Hear everything. Nothing else."), looking alive the whole time: blinking, breathing, nodding along to the words, mouth moving with the voice. On the right, the key phrase of the line appears as a bold caption beside them, word by word as it is said. Keep the character on screen from the first frame to the last.

**AtomCut's recipe (the bar):** the character placed as separate parts (not one flat picture), then `character_bringToLife` in one call: a mouth set driven by lip sync on the voice, both eyes blinking together about every 4 s, a slow breath on the body, the head nodding with the voice's loudness; check with `view_frames` that the eyes shut and the mouth opens and closes with the words; the caption timed to the speech; the voice in the Voice category of the mix, a quiet music bed ducked under it.

**Media:** the voice line `vo-1-hook.wav` and the music bed `music-promo.mp3`, imported by the runner before the brief.
