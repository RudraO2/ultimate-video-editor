# 01 · Title card (landscape)

**Brief:**
Make a 5-second 1920×1080 title card for a documentary called "The Quiet Coast", episode 3, subtitle "Where the tide keeps time". Deep navy and warm amber. Kicker "EPISODE 03" above the title, the subtitle under it and a short accent rule; left-aligned on a generous margin. Animate it in with a refined, staggered entrance and let it rest from about 2 s. Score it with the music in the project.

**AtomCut's recipe (the bar):** gradient ground into a deeper tint, an off-centre radial glow behind the text, a left-aligned stack on a 12U margin (kicker in tracked caps in the accent, title at display size 800 with −3 % tracking, subtitle in a second ink, accent rule), one title word coloured, kicker `fade-up` per letter (18 ms), title `unblur-up` per word (110 ms, expo, +220 ms), subtitle `fade-up` per line (+700 ms), the rule growing from 0 (ease-out-expo), the glow fading and scaling 0.85 → 1 over 2 s, a soft `pop` per title word.

**Media:** `music-documentary.mp3`, imported by the runner before the brief.
