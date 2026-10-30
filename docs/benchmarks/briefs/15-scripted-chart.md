# 15 · Scripted chart

**Brief:**
Make a 6-second 1920×1080 animated bar chart of our monthly sign-ups: Jan 120, Feb 180, Mar 150, Apr 240, May 310, Jun 420. Title "Sign-ups, first half of 2026" at the top left. The bars grow up from a common baseline one after another, each with its value above it and its month below; June is the hero, in an accent colour, and lands last with a little more weight. Hold the finished chart for at least a second and a half. Build the chart with one script saved in the project, so I can re-run it with new numbers later.

**AtomCut's recipe (the bar):** one `script_run` that lays the chart out from the data (bar heights scaled to the largest value, even gaps, a baseline, labels measured from the bars), with staggered entrances (bars grow from the baseline with an ease-out, labels fade up after their bar), the hero bar in the accent with a slightly longer, bouncier landing, a soft tick per bar and a heavier hit on the hero, saved with `script_save` in replace mode with the data as constants at the top; then `view_frames` to check and single-tool fixes.

**Media:** none.
