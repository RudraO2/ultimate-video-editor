# 08 · Hopping logo

**Brief:**
Make a 4-second 1920×1080 logo sting for "Hopscotch". A ball drops in from the upper left, bounces across the floor three times, each bounce lower and shorter, and comes to rest at the centre, just above the wordmark "HOPSCOTCH", which rises in under it. Meanwhile a small paper-plane shape glides in from the right along a looping, flowing route through three points in the sky and settles above the wordmark. Light background, one accent colour.

**AtomCut's recipe (the bar):** the ball's `position` keyed once per contact with `arc` on each take-off key (linear easing, each arc about half the last, each flight about 70 % as long), squash and stretch at the contacts (`scaleY` and `scale` with the pivot on the floor); the plane's route as `in`/`out` handles, or a few keys run through the keyframe Smooth action so it never stops at a waypoint; the wordmark `fade-up` per letter; a soft `pop` on each contact.

**Media:** none.
