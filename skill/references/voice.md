# Voice and Indian languages

How to give a piece a voice, time the picture to it, and make it speak another Indian language. The voices are Sarvam's Bulbul; every call costs the user a little money, so plan first and generate once.

## Write for the ear

- Short sentences, one idea each. A line you would not say aloud does not belong in a voice-over.
- Write numbers and names the way they should be said: "thirty hours", "seventy-nine dollars", "Aurora". In Hindi, write Hindi numerals or words as you want them read.
- Punctuation is timing: a comma is a short breath, a full stop (or the danda, ।) a longer one. Use them instead of splitting a sentence into two takes.
- Code-mixed lines are natural in Indian speech ("ये है Aurora, आपका नया साथी"); the voice reads the Latin words in English.

## One take per phrase

`generate_speech {lines: ["…", "…"], language, voice, place: {compId, startMs}, gapMs: 300}` makes one take per line and places them one after another: each voice starts `gapMs` after the last one ended. Never generate one long take and cut it: the words would be cut mid-breath, and a re-take of one line would shift everything after it.

- A scene's length comes from its take: read `durationMs`, `speechStartMs`, `speechEndMs` from the result and build the scene to them. Hold a beat (300 to 600 ms) after a line before the cut.
- `place` puts the **voice**, not the file, at `startMs`: the silence at the head of a take is left before it.
- Choose one voice for the whole piece (`voices_list`; `shubh` and `ishita` are Sarvam's best-rated) and keep `pace` at 1 unless a line must fit; 1.1 to 1.2 still sounds natural, past 1.3 it rushes.
- A take you do not like: change the words or the voice and call again. The same text, voice and settings return the same file for free.

## Timing the picture to the words

Every take keeps its words with their times (`media_list` shows `speech.words`, ms from the start of the file; add the layer's start for comp time). Use them:

- Land the key word's visual on the word: the product name appears as it is said, a number counts up while it is spoken.
- Put cuts in the gaps between phrases, not on a word.
- `media_transcribe {id: audioLayerId, captions: true}` makes a word-synced caption over the take (style it with `caption_set {states}`); several takes, several captions, or one caption per scene.
- A recorded voice (not generated) has no words yet: `media_transcribe {id, text: "the script"}` times the words you give it for free; without `text` it listens (Sarvam speech to text, ₹0.49 a minute) and times what it hears. Always give the script when you have it: aligning known words is far more reliable than listening.

## Another language

`comp_localize {compId, language: "hi-IN", keep: ["Aurora"], voice?}` makes a copy of the comp named "<name> · हिन्दी":

1. Every voice take (audio whose media knows its script, or that is on the voice category or named `vo-…`) is translated and spoken again, its voice starting where the old one did.
2. A take longer than the room it had is read faster, up to `maxPace` (1.25); what still does not fit gets room opened right after it (`timeline_insert_time`): the scenes after it start later, backgrounds and music hold on. `fit: "pace"` only speeds up; `"none"` keeps the pace.
3. Captions over a take get the new words, word-synced. Other text is translated (`keep` leaves brand names alone; prices and numbers stay).
4. Hindi is often 20 to 60 % longer than English and Tamil longer still: check the result's `takes` (old and new length, pace, room) and look at each scene with `view_frames` for text that now overflows its box. Shorten a translation by hand with `text_set` if a title no longer fits.

Run it once per language from the original, never from a copy (each translation would drift). Register: `mode: "modern-colloquial"` sounds like people talk; the default `formal` reads like a notice.

## Scripts and type

Text in Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada or Malayalam draws its letters in the Noto Sans family of that script automatically, while the layer's own face keeps the Latin letters and digits. For a title in one face, choose a Google family that has the script (`fonts_list {script: "devanagari"}`: Mukta, Hind, Baloo 2, Tiro Devanagari Hindi, Rozha One; Tamil: Mukta Malar, Hind Madurai, Catamaran).

- Indic letters stack marks above and below: give lines 1.3 to 1.5 line height and keep `textCase` off (cases do not exist there).
- Per-letter animation moves whole syllables (a letter with its marks), which reads well; per-word is safer for long words.

## Cost

About ₹3 per 1,000 characters spoken, ₹2 per 1,000 translated, ₹0.49 per minute heard. A 15-second promo in one more language costs well under ₹1. `sarvam_usage` shows what this editor has spent; Sarvam has no balance call. When a call says the key is missing or the credits are used up, stop and tell the user.
