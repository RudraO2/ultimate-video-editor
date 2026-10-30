# 11 · Neon logo

**Brief:**
Make a 5-second 1920×1080 logo sting for a late-night bar called "NOVA". The logo is the word NOVA inside a thin ring, made as a real neon sign: thick glowing tubes with some depth, hot pink for the word and electric blue for the ring, hanging in a dark room. The sign flickers on in the first second (the ring first, then the word), then glows steadily, softly lighting the dark wall behind it, while the camera drifts slowly towards it. The glow should bleed around the letters like real neon, without washing out the shapes.

**AtomCut's recipe (the bar):** a dark world (`world_create {starter: false}`, a near-black background); the word as text and the ring as an ellipse with a stroke only (or a closed path), both added in the world (`world_add {kind: "text"}`, or built flat and `world_move_into`); `world_extrude {depth: 10–20, bevel: 2–4}` for tube depth; `world_material {preset: "neon"}` with `emission` in each colour and `emissionStrength` 3–5; `world_look {bloom: {source: "emission", strength ~0.9, radius ~0.5}}` so only the tubes glow; a back wall (a dark mesh plane or cube behind the sign) lit by a coloured point light near the sign; the flicker as keys on `opacity` or `material.emissionStrength` (on, off, on in quick steps; the ring before the word); a camera (`world_add {kind: camera}` or `world_camera {fromDefault: true}`) with a slow push on `y`; `view_frames` to check the glow; then export.

**Media:** none.
