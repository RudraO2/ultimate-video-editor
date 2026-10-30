# 02 · Lower third

**Brief:**
Over the clip in the project, add a lower third for "Dr. Maya Okafor — Marine Biologist" that comes in at 0.5 s, holds at least 3 s and goes out cleanly. 1920×1080, 6 seconds. Keep it inside the title-safe area, bottom left.

**AtomCut's recipe (the bar):** a surface pill (rect, radius = height / 2) grouped with two texts (name 700, role 400 in a second ink) in an auto-layout column (gap 0.6U, padding 2U 3U), bottom-left inside title-safe. In: pill `slide-right` or `fade-up` 500 ms, texts `fade-up` per line with an 80 ms stagger. Hold ≥ 3 s. Out: `fade` 300 ms, ease-in.

**Media:** `clip.mp4` (6 s, 1280×720 test footage with a tone), imported by the runner before the brief.
