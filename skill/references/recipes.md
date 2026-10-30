# Recipes

Short worked builds to adapt, not to copy: change the words, colours and timings to the brief and the design system. Tool shapes are as in SKILL.md; `api_describe` shows any input. After each build, look with `view_frames`, then `view_render` on the frame that matters.

**Units.** `U` is the comp's short side divided by 100 (10.8 px in a 1080-tall comp). The origin is the comp centre, +y down, times in ms. Sizes, margins and gaps below are in `U`, so a recipe fits any comp size.

Recipes 1, 3 and 6 end with a complete script: one `script_run` builds the whole scene (constants at the top, size from `here`, every call awaited, ids returned by name). The first line of each is a `// comp WxH Nms` comment: the comp that script is written for. Resize with `frame_update` first, or edit the constants.

## 1. Title card, landscape

A title that reads in under a second, then holds. Comp 1920x1080, 6 s.

- **Layers (back to front):** `Ground` (full-frame rect, a linear gradient from deep violet to near black), `Glow` (an ellipse 90U wide, radial fill from the accent at about 65 % alpha to the same colour at 0, off-centre to the right and up), then a left-aligned stack: `Kicker` (caps, tracked, accent, 2.6U), `Title` (15U, weight 800, tight tracking), `Subtitle` (3.6U, muted) and `Rule` (a 0.8U accent bar). Every line has `anchorX: 0` and the same `x`, a 12U margin from the left edge, so the left edges align whatever the words.
- **Colour:** one word of the title in the accent, with `text_style {id, match: "motion", style: {color}}`. One accent word, not three.
- **Motion:** `Glow` fades and scales in over 1.4 to 1.8 s (keys, `ease-out`). `Kicker`: `fade-up` per letter, 28 ms apart. `Title`: `unblur-up` per word, 140 ms apart, starting at 250 ms. `Subtitle`: `fade-up` per line at 1.1 s. `Rule`: `width` keyed from 1 to full over 0.8 s from 0.9 s (it grows right, because its pivot is its left edge).
- **Sound:** `Title` carries one voice, a `pop` on every word: `{pack: "pop", volume: 0.3, randomness: 0.55, phase: "in", trigger: {kind: "text"}, anchor: "start"}`. Nothing else makes a sound. Add a bed if the user gave music (see "The mix").
- **Look:** `view_frames` at 0.3, 0.8, 1.5 and 4 s. At 1.5 s the stack is complete; at 4 s it holds with only the glow settled. Check that the left edges line up, the accent word is the only coloured one, and the title does not run into the glow's brightest part.

```js
// comp 1920x1080 6000ms
const U = Math.min(here.width, here.height) / 100
const LEFT = -here.width / 2 + 12 * U            // one left edge for the whole stack
const ACCENT = '#FFB020', INK = '#F4F4FA', MUTED = '#A9A9C0'
const KICKER = 'Product launch', TITLE = 'Ideas in motion', ACCENT_WORD = 'motion'
const SUBTITLE = 'Design, animate and ship in one place.'
const TITLE_SIZE = 15 * U
const RULE_W = 14 * U

const ground = await ac.layer.create({
  kind: 'shape', name: 'Ground', shape: { type: 'rect', width: here.width, height: here.height },
  fill: { type: 'linear', stops: [{ offset: 0, color: '#1A1440' }, { offset: 1, color: '#05050D' }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
})
const glow = await ac.layer.create({
  kind: 'shape', name: 'Glow', shape: { type: 'ellipse', width: 90 * U, height: 90 * U },
  x: here.width * 0.18, y: -here.height * 0.12,
  fill: { type: 'radial', stops: [{ offset: 0, color: '#7C5CFFA6' }, { offset: 1, color: '#7C5CFF00' }], start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 } },
})
await ac.keyframes.set({ id: glow.id, property: 'opacity', keys: [{ t: 0, v: 0, ease: 'ease-out' }, { t: 1400, v: 1 }] })
await ac.keyframes.set({ id: glow.id, property: 'scale', keys: [{ t: 0, v: 0.8, ease: 'ease-out' }, { t: 1800, v: 1 }] })

const line = (name, text, y, style, extra = {}) =>
  ac.layer.create({ kind: 'text', name, text, x: LEFT, y: y * U, transform: { anchorX: 0 }, style: { align: 'left', ...style }, ...extra })

const kicker = await line('Kicker', KICKER, -17, { fontSize: 2.6 * U, fontWeight: 700, letterSpacing: 0.18 * 2.6 * U, textCase: 'upper', color: ACCENT })
const title = await line('Title', TITLE, -4, { fontSize: TITLE_SIZE, fontWeight: 800, letterSpacing: -0.03 * TITLE_SIZE, color: INK }, {
  sounds: [{ pack: 'pop', volume: 0.3, randomness: 0.55, phase: 'in', trigger: { kind: 'text' }, anchor: 'start' }],
})
const subtitle = await line('Subtitle', SUBTITLE, 10, { fontSize: 3.6 * U, fontWeight: 400, color: MUTED })
await ac.text.style({ id: title.id, match: ACCENT_WORD, style: { color: ACCENT } })

const rule = await ac.layer.create({
  kind: 'shape', name: 'Rule', shape: { type: 'rect', width: RULE_W, height: 0.8 * U, cornerRadius: 0.4 * U },
  fill: ACCENT, x: LEFT, y: 16 * U, transform: { anchorX: 0 },
})
await ac.keyframes.set({ id: rule.id, property: 'opacity', keys: [{ t: 0, v: 0, ease: 'hold' }, { t: 900, v: 1 }] })
await ac.keyframes.set({ id: rule.id, property: 'width', keys: [{ t: 900, v: 1, ease: 'ease-out-expo' }, { t: 1700, v: RULE_W }] })

await ac.animation.set({ id: kicker.id, slot: 'in', preset: 'fade-up', unit: 'letter', staggerMs: 28, durationMs: 420 })
await ac.animation.set({ id: title.id, slot: 'in', preset: 'unblur-up', unit: 'word', staggerMs: 140, delayMs: 250, durationMs: 700 })
await ac.animation.set({ id: subtitle.id, slot: 'in', preset: 'fade-up', unit: 'line', delayMs: 1100, durationMs: 600 })

console.log('title card built:', TITLE)
return { ground: ground.id, glow: glow.id, kicker: kicker.id, title: title.id, subtitle: subtitle.id, rule: rule.id }
```

## 2. Lower third

A name and role that sit in the bottom-left corner, fit any name, and leave. Comp 1920x1080; the layers last 4.5 s from 1 s.

1. Create `Pill` (a rect with `cornerRadius` 1.2U and a dark fill at about 93 % alpha), `Name` (3.2U, weight 700) and `Role` (2.2U, muted), all text `align: "left"`.
2. `layers_group {ids: [pill, name, role], name: "Lower third", layout: {flow: "column", gap: 0.6U, padding: 2.2U, alignX: "start", x: -W/2 + 8U, y: H/2 - 8U - 11.2U}}`. The rect behind becomes the container: it hugs the text, so a longer name widens the card. `x`, `y` are the card's top-left corner; 11.2U is its height for these sizes (check it with `layers_list`). Keep it inside the safe area: 8U from the left and bottom edges.
3. In: the group `fade-up` as a whole (`animation_set {id: group, slot: "in", preset: "fade-up", target: "layer", durationMs: 450}`), then `Name` `fade-up` per word at 150 ms and `Role` `fade-up` per line at 300 ms. Out: the group `fade`, 300 ms, quicker than the entrance.
4. Hold at least 3 s with everything still: nothing moves while it is read. A soft sound on `Name`'s entrance only: `{pack: "soft", volume: 0.25, phase: "in", trigger: {kind: "text"}, anchor: "start"}`.
5. Look at 0.4 s, 1.5 s and the last 0.5 s. Try a longer name (`text_set`): the pill must grow, not clip.

## 3. Kinetic type, vertical

One huge word at a time, a new one on every beat, each arriving a different way, a sound per word. Comp 1080x1920, 4 s at 120 bpm (a beat is 500 ms).

- **Layers:** `Ground` (full-frame, near black) and one text layer per word, all on one lane so they cut back to back: each starts where the last ended. Words in caps, 20U, weight 900, centred, a vertical offset that changes word to word so the eye moves.
- **Motion:** a whole-layer entrance of 320 ms per word (`animation_set {slot: "in", target: "layer"}`) with a different preset each time: `pop-in`, `slide-up`, `drop`, `whip`, `rubber`, then `punch` for the last. No exits: the next word replaces it on the beat.
- **Colour:** the key word, last and held longest, has its `color` keyed: white at 0 easing to the accent at 260 ms. One flash in the piece.
- **Sound:** one `pop` voice per word with `trigger: {kind: "layer"}, anchor: "start"`, the pitch rising a little each word, and the key word lower and louder.
- **Look:** `view_frames` on each beat start plus 150 ms: the word must be fully arrived by then and not clipped by the edges. The key word's flash shows in the frame at its start.

```js
// comp 1080x1920 4000ms
const U = Math.min(here.width, here.height) / 100
const BEAT = 500
const ACCENT = '#FFB020', INK = '#F4F4FA'
const WORDS = [                       // beats on screen, entrance, vertical offset in U
  { text: 'Words', beats: 1, preset: 'pop-in', y: -12 },
  { text: 'move', beats: 1, preset: 'slide-up', y: 8 },
  { text: 'when', beats: 1, preset: 'drop', y: -6 },
  { text: 'you', beats: 1, preset: 'whip', y: 12 },
  { text: 'mean', beats: 1, preset: 'rubber', y: -10 },
  { text: 'it.', beats: 3, preset: 'punch', y: 0, key: true },
]

await ac.layer.create({ kind: 'shape', name: 'Ground', shape: { type: 'rect', width: here.width, height: here.height }, fill: '#0B0B14' })

const ids = {}
let lane
let t = 0
for (const [i, w] of WORDS.entries()) {
  const last = i === WORDS.length - 1
  const sound = { pack: 'pop', volume: w.key ? 0.4 : 0.32, pitch: w.key ? 0.8 : 1 + i * 0.05, randomness: 0.4, phase: 'in', trigger: { kind: 'layer' }, anchor: 'start' }
  const made = await ac.layer.create({
    kind: 'text', name: 'Word ' + (i + 1), text: w.text, y: w.y * U, trackId: lane,
    startMs: t, durationMs: last ? here.durationMs - t : w.beats * BEAT,
    style: { fontSize: 20 * U, fontWeight: 900, textCase: 'upper', color: w.key ? ACCENT : INK, letterSpacing: -0.02 * 20 * U },
    sounds: [sound],
  })
  lane = made.trackId                  // every word on the first word's lane: back to back, never overlapping
  await ac.animation.set({ id: made.id, slot: 'in', preset: w.preset, target: 'layer', durationMs: 320 })
  if (w.key) await ac.keyframes.set({ id: made.id, property: 'color', keys: [{ t: 0, v: '#FFFFFF', ease: 'ease-out' }, { t: 260, v: ACCENT }] })
  ids[w.text] = made.id
  t += w.beats * BEAT
}
console.log('words', WORDS.length, 'ends at', t, 'ms')
return ids
```

## 4. Logo reveal

A mark that draws itself, fills, catches the light once, and a wordmark that follows. Comp 1920x1080, 4 s.

1. The mark is one or more `path` layers (`layer_create {kind: "path", d}`; `svg_place` for artwork the user gave). For each piece make an outline layer (stroke only, 6 px, `fill: null`) and a fill layer (fill only), at the same `x`, `y`.
2. Outlines: `animation_set {preset: "draw", target: "layer", durationMs: 900}`, each piece starting 120 ms after the last (start the layers staggered). Fills: `fade` in over 500 ms, starting as the last outline finishes.
3. Light: `effects_add {id: <the fill layer>, type: "shine", values: {duration: 0.9, delay: 1.6, loop: false}}`: one sweep after the fill, never a loop. Put it on a group if the mark has several fill pieces.
4. Wordmark: a text layer under the mark, `pop-in` or `fade-up` per letter, 40 ms apart, starting as the fill lands. Letter-spaced wide, one weight.
5. Sound: a single low impact where the fill lands. `sounds_list {query: "thud"}`, `sounds_use {id}`, then put the value it returns in the fill layer's `sounds` with `trigger: {kind: "layer"}, phase: "in", anchor: "end"`. Add one soft `pop` per wordmark letter at 0.15 only if it reads as a typing rhythm; otherwise leave the wordmark silent.
6. Look at the draw (0.5 s), the fill (1.6 s), the shine (2.2 s) and the hold. The outline must be fully drawn before the fill reaches full opacity.

## 5. Path morph

One shape that becomes another, here a circle into a four-point star. The two `d` strings must have the same commands in the same order; the points then blend one by one.

1. Write both outlines with the same segments: below, four `C` curves each. For your own shapes, count the commands of each and make them equal before keying.
2. Key `geometry` with the `d` strings as the values: a rest of 300 ms, 900 ms of `ease-in-out` change, a rest of 300 ms (the same `d` keyed again at each rest).
3. Paths with different commands do not blend: they switch at the next key. If the morph looks like a pop, the commands differ.
4. Look at 0, 30 %, 60 % and 100 % of the morph: the in-between frames should be a plausible shape, not a tangle.

```js
// comp 1920x1080 2000ms
const CIRCLE = 'M 0 -60 C 33 -60 60 -33 60 0 C 60 33 33 60 0 60 C -33 60 -60 33 -60 0 C -60 -33 -33 -60 0 -60 Z'
const STAR = 'M 0 -90 C 20 -50 50 -20 90 0 C 50 20 20 50 0 90 C -20 50 -50 20 -90 0 C -50 -20 -20 -50 0 -90 Z'
const SCALE = (here.height * 0.25) / 180      // the art is 180 across; show it a quarter of the frame high
const mark = await ac.layer.create({ kind: 'path', name: 'Morph', d: CIRCLE, fill: '#FFB020', stroke: null, transform: { scaleX: SCALE, scaleY: SCALE } })
await ac.keyframes.set({ id: mark.id, property: 'geometry', keys: [
  { t: 300, v: CIRCLE, ease: 'ease-in-out' },
  { t: 1200, v: STAR },
  { t: 1700, v: STAR },
] })
return { mark: mark.id }
```

## 6. Product promo, vertical, 15 s

A hook, three feature beats, an offer and an end card. Comp 1080x1920, 15 s. The script builds the shapes and words; the product pictures are placeholders: each `Photo` is a gradient rect, so swap it for a `mediaId` layer (`layer_create {kind: "media", mediaId, trackId, startMs, durationMs}`, same lane and times) when the user gives photos.

| Beat | Time | Content |
| --- | --- | --- |
| Hook | 0 to 1.5 s | one claim, two lines |
| Feature 1, 2, 3 | 3 s each | kicker number, name, one line |
| Offer | 10.5 to 13 s | price and the deadline |
| End card | 13 to 15 s | name and address, held |

- **Cuts:** the `Photo` layers share one lane and meet exactly, so `transition_add {ids, preset: "push", edge: "out", durationMs: 450, params: {angle: 90}}` puts a push on each cut, the next beat arriving from below. Text is not on that lane: it leaves 300 ms before the cut and arrives 300 ms after, so only the picture moves during the push.
- **Text:** left-aligned at an 8U margin, bottom third of the frame (the top is for the picture). The title is anchored at its bottom edge so a wrapped line grows upward, and the detail sits just under it. `unblur-up` per word for titles, `fade-up` for kickers and details, `pop-in` per word for the price.
- **Sound:** a soft whoosh voice on each `Photo`'s transition (`trigger: {kind: "transition"}, phase: "out", anchor: "peak"`) and a `pop` on every title (per word). The bed is a music file the user gave: after the script, `layer_create {kind: "media", mediaId, soundBus: "music", startMs: 0, durationMs: 15000}` and fade it with `keyframes_set` on `volume` (see "The mix"). The script adds no bed: with no music file, say so.
- **Look:** `view_frames` on a cut (1.3, 1.5, 1.7 s), mid-beat, the price and the last second. The old text must be gone before the push starts and the new one must not appear until it ends.

```js
// comp 1080x1920 15000ms
const U = Math.min(here.width, here.height) / 100
const MARGIN = 8 * U
const ACCENT = '#FFB020', INK = '#F4F4FA', MUTED = '#C4C4D8'
const PUSH_MS = 450, TEXT_GAP = 300             // text leaves this long before a cut, arrives this long after
const TITLE_BOTTOM = 62 * U                     // title's bottom edge; text sits in the bottom third
const SCENES = [                                // Photo = placeholder gradient; swap for a media layer
  { name: 'Hook', ms: 1500, from: '#2A1B5E', to: '#0B0B14', title: 'Your desk is too dark.' },
  { name: 'Feature 1', ms: 3000, from: '#16324F', to: '#0B0B14', kicker: '01', title: 'Warm to cool', detail: 'Dial the light to the hour.' },
  { name: 'Feature 2', ms: 3000, from: '#3B1D4A', to: '#0B0B14', kicker: '02', title: 'Charges your phone', detail: 'Full by lunch, no cable.' },
  { name: 'Feature 3', ms: 3000, from: '#1F3D2C', to: '#0B0B14', kicker: '03', title: 'Touch to dim', detail: 'Slide a finger. No app.' },
  { name: 'Offer', ms: 2500, from: '#5E2A1B', to: '#0B0B14', kicker: 'Launch price', title: '49 euros', detail: 'Free shipping until Sunday.', preset: 'pop-in' },
  { name: 'End card', ms: 2000, from: '#14142B', to: '#05050D', title: 'Lumen', detail: 'lumen.example/shop' },
]

const text = (name, str, startMs, durationMs, extra) =>
  ac.layer.create({ kind: 'text', name, text: str, startMs, durationMs, x: MARGIN - here.width / 2, ...extra })

const photos = []
const out = {}
let lane
let t = 0
for (const [i, s] of SCENES.entries()) {
  const first = i === 0
  const last = i === SCENES.length - 1
  const ms = last ? here.durationMs - t : s.ms
  const photo = await ac.layer.create({
    kind: 'shape', name: 'Photo ' + s.name, shape: { type: 'rect', width: here.width, height: here.height },
    fill: { type: 'linear', stops: [{ offset: 0, color: s.from }, { offset: 1, color: s.to }], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } },
    startMs: t, durationMs: ms, trackId: lane,
    sounds: last ? [] : [{ pack: 'soft', volume: 0.25, phase: 'out', trigger: { kind: 'transition' }, anchor: 'peak' }],
  })
  lane = photo.trackId                          // one lane, meeting exactly: a transition needs it
  photos.push(photo.id)

  const from = first ? t : t + TEXT_GAP
  const span = (last ? t + ms : t + ms - TEXT_GAP) - from
  const left = { transform: { anchorX: 0 }, style: { align: 'left' } }
  const parts = {}
  parts.title = await text(s.name + ' title', s.title, from, span, {
    y: TITLE_BOTTOM, maxWidth: here.width - 2 * MARGIN, transform: { anchorX: 0, anchorY: 1 },
    style: { align: 'left', fontSize: 10 * U, fontWeight: 800, letterSpacing: -0.02 * 10 * U, color: INK },
    sounds: [{ pack: 'pop', volume: 0.3, randomness: 0.55, phase: 'in', trigger: { kind: 'text' }, anchor: 'start' }],
  })
  await ac.animation.set({ id: parts.title.id, slot: 'in', preset: s.preset ?? 'unblur-up', unit: 'word', staggerMs: 90, durationMs: 600 })
  if (s.kicker) {
    parts.kicker = await text(s.name + ' kicker', s.kicker, from, span, {
      y: TITLE_BOTTOM - 13 * U, transform: { anchorX: 0, anchorY: 1 },
      style: { align: 'left', fontSize: 2.6 * U, fontWeight: 700, letterSpacing: 0.18 * 2.6 * U, textCase: 'upper', color: ACCENT },
    })
    await ac.animation.set({ id: parts.kicker.id, slot: 'in', preset: 'fade-up', unit: 'word', durationMs: 450 })
  }
  if (s.detail) {
    parts.detail = await text(s.name + ' detail', s.detail, from, span, {
      y: TITLE_BOTTOM + 1.5 * U, maxWidth: here.width - 2 * MARGIN, transform: { anchorX: 0, anchorY: 0 },
      style: { align: 'left', fontSize: 3.6 * U, fontWeight: 400, color: MUTED },
    })
    await ac.animation.set({ id: parts.detail.id, slot: 'in', preset: 'fade-up', unit: 'line', delayMs: 250, durationMs: 500 })
  }
  if (!last) {
    for (const p of Object.values(parts)) await ac.animation.set({ id: p.id, slot: 'out', preset: 'fade', unit: 'line', durationMs: 200 })
  }
  out[s.name] = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.id]))
  t += ms
}

await ac.transition.add({ ids: photos.slice(0, -1), preset: 'push', edge: 'out', durationMs: PUSH_MS, params: { angle: 90 } })
console.log('promo built:', SCENES.length, 'beats,', t, 'ms')
return { photos, text: out }
```

## 7. Falling title

A title whose words drop onto a shelf and settle. See "Physics".

1. One text layer per word, above the frame, spread across the width at different heights (a title is words, so each is one body). A `Shelf`: a rect near the lower third, 0 opacity or a thin line, `physics_body {ids: [shelf], type: "passive"}`.
2. `physics_body {ids: [words], bounce: 0.25, friction: 0.6}`, each word its own small `spin` (plus or minus 40), `physics_scene {walls: true, startMs: <when the first word should fall>}`.
3. Stagger the words' `startMs` by 150 ms so they land one after the other. A soft `pop` on each word's first landing, not on every bounce.
4. `view_frames` from the drop to 1 s after the last landing, then `physics_inspect {atMs}` at the end: every word rests on the shelf and none overlaps another.

## 8. Sticker rain

About 20 stickers pour over a headline, with one gust. The numbers are in "Physics" (the sticker rain recipe); the order of work:

1. `stickers_list {query: "party popper", style: "3d"}` then `stickers_use {id, place: {x, y, size: 180, startMs: 0, durationMs: <comp>}}` for each, one look only, positions above the frame.
2. `physics_body {ids, bounce: 0.3, friction: 0.6, spin, velocity}` with its own small random spin and sideways speed; the headline `passive`.
3. `physics_scene {walls: true}`, then `physics_force {type: "wind", strength: 0, rotation: -20}` and key `force.<forceId>.strength` 0, 700, 0 over 0.4 s on a beat.
4. A few soft `pop` voices on the first landings. Leave about 1 s of settle before the cut.

## 9. Living character

A person or emoji that blinks, breathes and talks with the voiceover. Follow "A talking host" in "Characters".

1. Import the voice line first and tag it `voice`. Place one drawn person as layers: `stickers_use {id, layers: true, place: {x, y, size: 800, startMs, durationMs}}`.
2. `character_detect {id}`: read the parts and the `life` list. Fix wrong parts with `overrides`.
3. `character_bringToLife {id}`; `behaviors_inspect {groupId}` shows the stack. For a character with no voice, use `sway` instead of `talk`.
4. `view_frames` across the line, close on the face: eyes shut now and then, the mouth changes with the syllables, the body never jumps.

## 10. Captions without a transcription tool

There is no tool that listens: time the words from the script.

1. Put the whole line in one text layer with `maxWidth` set so it wraps, starting where the voice starts.
2. Give each word a share of the line's length by its characters (plus a little for each pause):

```js
// comp 1920x1080 5000ms
const U = Math.min(here.width, here.height) / 100
const LINE = 'Make every second count'
const START = 400, END = 3400                        // where the voice speaks, comp ms
const words = LINE.split(' ')
const total = words.reduce((n, w) => n + w.length + 2, 0)
let t = START
const cues = words.map((text) => {
  const ms = ((text.length + 2) / total) * (END - START)
  const cue = { text, startMs: Math.round(t), endMs: Math.round(t + ms) }
  t += ms
  return cue
})
const layer = await ac.layer.create({ kind: 'text', name: 'Caption', text: LINE, y: 30 * U, maxWidth: here.width * 0.7, startMs: 0, durationMs: here.durationMs, style: { fontSize: 5 * U, fontWeight: 700 } })
await ac.caption.set({ id: layer.id, words: cues, timesIn: 'comp' })
return { caption: layer.id, cues }
```

3. If the user gave real timings (a lyric sheet, a subtitle file), use those numbers instead and leave the formula out.
4. Look at the start, the middle and the end of the line: one word in focus at a time, read words at full opacity, the pill gliding if `motion.travel` is on.

## 11. 2D to 3D in one shot

A flat design that becomes a 3D world without a cut: the same wordmark and cloud, the same timeline and keys, and a camera that starts exactly where the flat view was, then moves. Never rebuild the layers in a separate world and cut to it: the viewer sees the swap.

1. Build the flat scene as usual. The layers that go 3D (the wordmark, the cloud) span the comp from where they appear to the end; the background, captions and anything that stays flat stay where they are.
2. `world_move_into {ids}` with the layers that go 3D. They move into a new world nested full frame, in place: the default camera shows exactly the flat picture, entrances, text animations, effects and sounds included. World time is comp time minus the nested layer's start (0 here, because the moved layers start at 0).
3. `world_camera {compId: <frameId>, fromDefault: true}`: a camera at the default pose. Aim it with `world_track {lookAt}` at a controller at the origin (the centre of the flat view, so the aim is the default one), then key only its position, starting at the moment of the move with the default pose as the first key. Before that key the camera holds, so nothing changes until the move.
4. Depth: key a layer's `y` (depth in a world) from 0 at the moment of the move, so the layers part as the camera travels (parallax). A thickness (`world_extrude`) or a material makes a picture take light, which changes its colours: give it before the scene starts (in the flat look's colours) or after a cut, never at the move.
5. Sound: one fuller whoosh whose peak sits where the camera is fastest (see `references/sound.md`).
6. Check with `view_frames` across the move (from 300 ms before to 1 s after): the frame before the move must match the flat comp's frame, and the camera's path must not pass through a layer (its `y` stays below the layers' depth).

```js
// comp 1920x1080 8000ms
const U = Math.min(here.width, here.height) / 100
const END = here.durationMs
const MOVE = 3000                                    // the camera leaves the flat view here
const FLY = 3000                                     // and takes this long
const sky = await ac.layer.create({ kind: 'shape', name: 'Sky', shape: { type: 'rect', width: here.width, height: here.height }, fill: '#14123a', startMs: 0, durationMs: END })
const word = await ac.layer.create({ kind: 'text', name: 'Wordmark', text: 'drizzle', y: 10 * U, startMs: 0, durationMs: END, style: { fontSize: 22 * U, fontWeight: 800, color: '#ffffff' } })
await ac.animation.set({ id: word.id, slot: 'in', preset: 'fade-up', unit: 'letter', staggerMs: 40, durationMs: 500 })
const cloud = await ac.layer.create({ kind: 'shape', name: 'Cloud', shape: { type: 'ellipse', width: 34 * U, height: 20 * U }, fill: '#c8c2ff', y: -20 * U, startMs: 0, durationMs: END })
await ac.animation.set({ id: cloud.id, slot: 'in', preset: 'pop-in', durationMs: 450 })

// Into a world in place: same layers, same keys, the same picture.
const moved = await ac.world.move_into({ ids: [word.id, cloud.id], name: 'Drizzle 3D' })
const world = moved.frameId
const { cameraId } = await ac.world.camera({ compId: world, fromDefault: true })
const aim = await ac.world.add({ compId: world, kind: 'controller', name: 'Aim', position: [0, 0, 0] })
await ac.world.track({ id: cameraId, lookAt: aim.id })

// The camera holds the flat view until MOVE, then flies in and round (world numbers: y is depth, z is up).
const pose = (await ac.layer.get({ id: cameraId })).layer.transform
const fly = (property, to) =>
  ac.keyframes.set({ id: cameraId, property, keys: [{ t: MOVE, v: pose[property], ease: 'ease-in-out' }, { t: MOVE + FLY, v: to }] })
await fly('y', pose.y * 0.45)
await fly('x', -40 * U)
await fly('z', 16 * U)
// Parallax: the cloud drifts back as the camera moves.
await ac.keyframes.set({ id: cloud.id, property: 'y', keys: [{ t: MOVE, v: 0, ease: 'ease-in-out' }, { t: MOVE + FLY, v: 45 * U }] })
return { sky: sky.id, nested: moved.nestedId, world, camera: cameraId, aim: aim.id, word: word.id, cloud: cloud.id }
```
