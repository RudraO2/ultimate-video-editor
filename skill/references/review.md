# Looking and reviewing

## Look efficiently

| Question | Call |
| --- | --- |
| Is the layout roughly right? | `view_render {detail: "glance"}` |
| Does the frame work? | `view_render {atMs}` at the resting moment, not frame 0 before things enter |
| Is the type right (weight, spacing, a fallback font)? | `view_render {detail: "inspect", layers: ["<id>"]}` crops to that layer |
| Does the motion work? | `view_frames {fromMs, toMs, count: 6}` across the animated span |
| Did one beat land? | `view_frames {times: [480, 500, 520, 600]}` at the exact instants |
| A whole piece | `view_frames` over the whole comp at `glance` (9 to 12 tiles), then zoom into the spans that look wrong |

Pictures cost context. Do not render after changes that cannot be seen (a rename, a volume). Look after each visual idea, not after each call. Renders are drawn exactly as the export draws them, video frames included.

## The file

`export_video` writes the real file once, at the end. Its reply's `loudness` (`integratedLufs`, `truePeakDbtp`, `matchDb`) is the sound check: −16 to −14 LUFS and at or below −1 dBTP. Far off means a cause to find (see Sound below), not a gain to nudge.

## The checklist before "done"

Story (pieces meant for an audience; see `storytelling.md`)
- The hook is the first thing on screen: frame 0 is moving, no logo or fade from black first.
- Each beat reads in under a second with the sound off; something worth watching is on screen at any random second (`view_frames {times}` at four random instants).
- Every claim is true and the user's own lines are word for word theirs.
- The last frame holds long enough to read.

Layout
- Nothing important outside the title-safe area (90 % of the frame).
- Edges that should align do; spacing follows a rhythm; one clear focal point.

Type
- No fallback font; sizes from a clear scale; display type tracked tighter, caps labels opened up.
- Readable on every frame it is on; no single word left alone on a title's last line.
- Measured, not guessed: a pill fits its words with the same padding on each side, a label sits optically centred in its box, stacked words have even gaps from ink to ink, nothing touches or overlaps. Check with `view_render {detail: "inspect", layers}` on the frame each element first appears and on the most crowded frame.

Colour
- Enough contrast on every ground the text crosses, checked on the frames where the ground changes under it (a cut, a wipe, something light passing behind); one accent, used sparingly.

Motion
- A deliberate order of arrival; easing that matches the intent; related elements staggered.
- Holds long enough to read; exits quicker than entrances.
- Nothing pops at a layer's first or last frame.
- Keys a person can edit: `keyframes_inspect {}` on the comp flags no baked tracks; hops are `arc` keys, cuts are `hold`.
- No dead frames: a sweep across the whole comp (not a few stills) finds no blank, black or blinking frame, and no nested comp ends before its layer does.
- Thrown and bouncing things travel on arcs (`arc` on their position keys), not straight lines; a move through several points flows (`keyframes_smooth`) unless it is meant to stop at each.
- Cuts: a hard cut by choice, or a transition that fits (`transition_add`); never a white flash faked with a layer.
- Finish: one hero effect at most per shot; words that are spoken or sung follow the timing (`caption_set`).
- Stickers: one look across the piece (all 3D, all flat or all drawn); each lands on its beat with an entrance and its own pop; 3D ones no larger than about 300 px (check one up close with `view_render {layers}`: soft edges mean too big); cut-outs show no fringe of the old ground on a dark and a light frame.

Edit
- Cuts fall on the end of a sentence or an action, never mid-word; no dead air left by accident; scenes hand over on cause ("but", "so"), not just one after another.

Sound
- It has sound: the beats that matter make one (`sounds` on the layer that moves, or a CC0 sound from `sounds_list`); silence only by choice.
- A piece over about 3 s has a bed: a music file the user gave or the project has (the CC0 library has none; with none, say so), cut to the comp, faded 1 to 3 s in and out.
- Every media clip has its category (`soundBus`: voice, music, sfx, ambience; `layer_get` shows it; none means unrouted; file-name guesses are substring matches, so confirm each); the leveler is on and no clip volume was hand-ridden to balance things.
- Sounds sit on the layer that causes them (which has the motion that fires them: no animation, no sound), `hitMs` on the frame of impact, one sound family, volumes in the taste ranges (one-shots 0.15 to 0.35, streams 0.15 to 0.3).
- The export's `loudness` reads integrated -16 to -14 LUFS and `truePeakDbtp` at or below -1; if not, the cause is fixed (a missing bed, an untagged clip, a muted category), not a gain.
- Music ducks under the voice (the voice clips are tagged `voice`) and the voice is the loudest thing.

3D worlds
- `world_inspect` at the start, middle and end of each shot shows the subject in front of the live camera and inside its view; the camera never passes through a picture.
- Lights only matter where a picture has a material (`world_material`); a picture without one is unlit, so a world with lights and no materials looks flat on purpose. Meshes always take light: a mesh in the dark is a lighting mistake. So does a picture with thickness (`world_extrude`): check its sides are lit and seen at an angle, or the depth does not show.
- Bloom glows only where something is bright: with `source: "bright"` a white background or wall blooms too (use `emission` in a lit scene). Depth of field: the subject is sharp in `view_render` (`focusOn` it). A floor sits at the bottom of the objects, not through them or under a gap.

Physics
- `view_frames` across the fall and settle: nothing leaves the frame (walls on), nothing sinks into or tunnels through another body, the pile stops moving before the cut (about 1 s of rest), and landings cascade rather than arrive in unison (staggered heights). Things meant to land on a word rest on its letters (the word is `passive`), and a gust is visible but brief.

Characters
- A character that should feel alive is in parts and brought to life (`behaviors_inspect` lists blink, breathe and, with a voice, talk and nod); `view_frames` close on the face shows the eyes shut together now and then, the mouth moving with the words and resting in pauses, and no part jumping or coming loose from the head.

Scripts
- A build of five or more similar calls, or a whole scene, went through one `script_run` (the beat sheet's numbers as constants at its top) (a failed run changed nothing: read its line and hint, fix, run again); a script the user will re-run is saved (`script_save`, replace mode) with its knobs as constants at the top; its keys are poses, not a key per frame (`keyframes_inspect`).

If something fails and you cannot fix it, tell the user exactly what and why.

## Diagnosing

When a render looks wrong in a way your changes do not explain (a missing layer, a black frame), read `app_console {level: "error"}`. Treat entries as evidence; many warnings are harmless. Report with `report_issue` (category `app-bug`) only what you can tie to the failure.
