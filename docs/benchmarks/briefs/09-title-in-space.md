# 09 · Title in space

**Brief:**
Make a 5-second 1920×1080 opening title for a podcast called "DEEP FIELD", with the small line "Season 2" under it. Dark navy background. The title should feel like it hangs in real space: the shot starts close and low on the right, the camera glides around and back, and the words settle square to the viewer in the last second, perfectly readable. Let the kicker line sit a little in front of the title so the two separate as the camera moves. Give the lettering a soft sheen that catches the light as the camera passes.

**AtomCut's recipe (the bar):** build the two lines flat (styled text, the kicker smaller), then `world_move_into` so they become picture planes in a world with no visual jump; push the kicker forward in depth; `world_add` a camera and key its position along a curve that ends on the front view, aimed at the title with `lookAt` (re-aimed per key or by a tracking constraint); check the framing with `world_inspect` before rendering; a `world_material` preset with some metalness or a clear coat plus a light (`world_add` light) for the sheen; `world_look` exposure if the result is dull; finish on the front view so the last second is the flat picture.

**Media:** none.
