---
name: Ultimate Video Editor Default
description: The default design system for work made in this editor: a type scale, spacing, safe areas, colour roles and motion tokens that make any comp look deliberate. Replace it with a brand's own system when there is one.
version: 1.0.0
---

# Default design system

Adapted from the default design system shipped in `@atomcut/mcp` (MIT, by AtomCut), with this editor's tools, easings and fonts. Tokens are **relative to the comp**, so one system serves a 1080×1920 reel and a 3840×2160 film.

`U` = the comp's **short side ÷ 100**. It is 10.8 px on 1080×1920 and 1920×1080, and 21.6 px on 4K. Compute U once from `doc_overview` and build every size, margin and gap from it.

## Grid and safe areas

- **Margin**: 6U from each edge for primary content (about 65 px at 1080). Title-safe is 90 % of the frame, action-safe 95 %.
- **Vertical video (9:16)**: keep text out of the bottom 15 % and the right 12 %, where platform UI lives. The top 8 % is for status bars.
- **Columns**: landscape 12 columns with a 2U gutter; vertical 4 columns with a 2U gutter. Align edges to columns; centre only what stands alone.
- **Rhythm**: vertical spacing in multiples of 1U. Related items sit 1 to 2U apart, groups 4 to 6U apart.
- **Align by anchor, not by eye.** A left-aligned stack gives every line `anchorX: 0` and the same `x`; an auto layout group (`layers_group` with `layout`) spaces a stack for you.

## Type scale

The scale is steep (about ×1.6): hierarchy has to read in the half-second a viewer gives it. Sizes are in U; the pixel column is for a short side of 1080.

| Role | Size | px at 1080 | Weight | Tracking | Leading |
|---|---|---|---|---|---|
| Display | 16U | 173 | 800 | −3 % | 0.95 |
| Title | 10U | 108 | 700 to 800 | −2 % | 1.0 |
| Heading | 6.5U | 70 | 700 | −1 % | 1.1 |
| Body | 4U | 43 | 400 to 500 | 0 | 1.4 |
| Caption (on video) | 4.5 to 5.5U | 49 to 59 | 700 | 0 | 1.15 |
| Kicker or label (caps) | 2.6U | 28 | 700 | +18 % | 1.0 |
| Fine print | 2.2U | 24 | 500 | +2 % | 1.3 |

- In `style`: `fontSize` is the px value, `letterSpacing` is px (tracking % × `fontSize`; for example −3 % of 173 is about −5), `lineHeight` is the leading multiplier. Caps for kickers and labels: `textCase: "upper"`.
- Display fits 12 characters a line or fewer (8 or fewer on 9:16); a longer line steps down to Title. Never more than three sizes in one shot.
- Weight contrast does more than size contrast: an 800 title over a 400 subtitle. When a family has no heavier face, `fauxBold` (0.02 to 0.04) thickens it.
- Two families at most per piece. **Inter** for workhorse text; **Space Grotesk** or **Sora** for geometric display; **Playfair Display** or **Fraunces** when editorial or luxury; **JetBrains Mono** for code and data. Any Google family loads by name: set `fontFamily`.

## Colour roles

A composition uses roles, not arbitrary colours.

| Role | Default | Use |
|---|---|---|
| `ground` | `#0B0B12` | background (the dark default; invert for light pieces) |
| `surface` | `#15151E` | cards, pills, panels |
| `ink` | `#F4F4FA` | primary text |
| `ink-2` | `#A9A9C4` | secondary text |
| `accent` | `#9C7CFF` | one focal colour per shot |
| `accent-2` | `#FF5C8A` | a rare second accent (states, highlights) |
| `line` | `#FFFFFF1F` | hairlines and dividers |

Light pieces swap the ground and ink: `ground #F6F5F2`, `surface #FFFFFF`, `ink #121218`, `ink-2 #5B5B6E`, `line #1212181A`; the accents stay.

- One accent per shot, used on 5 to 10 % of the frame.
- Text contrast is at least 4.5:1 against what is actually behind it. Check the render, not the swatch.
- Gradients stay within a hue family: ground to a deeper or warmer version of itself.
- On footage, text sits on a scrim (ground at 40 to 60 % alpha), a pill (`surface`), or has a soft shadow (0, 2U, 6U, black at 50 %): `effects_add` with `type: "shadow"` on the layer, or per glyph with `domain: "text"`.

## Shape language

- Corner radius: 1.5U small (chips, tags), 3U cards, full (height ÷ 2) pills.
- Strokes: 0.2U hairlines, 0.5U emphasis. Round caps for anything that draws on.
- Shadows are soft and low, one light source, top left.

## Motion tokens

| Token | Duration | Easing |
|---|---|---|
| `micro` | 200 ms | `ease-out` |
| `enter` | 600 ms | `ease-out-expo` |
| `enter-large` | 900 ms | `ease-out-expo` |
| `exit` | 400 ms | `ease-in` |
| `move` | 700 ms | `ease-in-out` |
| `settle` | 500 ms | `ease-out-back` (sparingly) |

- **Stagger**: letters 18 ms, words 90 to 120 ms, lines 150 ms, list items 80 ms (`animation_set` `staggerMs`).
- **Distance**: entrances travel 2 to 4U; big reveals up to 8U. Nothing slides in from off-frame unless it is a transition.
- **Order**: kicker, title, supporting text, decoration. The eye should never have two things arriving at once.
- **Holds**: a finished title holds at least 1.2 s plus 50 ms per word before anything changes.
- **Loops**: continuous drift is slow and calm (0.1 to 0.3 Hz with `ease-in-out` keys), never busy.

## Captions

- Focus word: `ink`, weight 800, with an `accent` pill (radius full, padding 0.6U × 0.3U) or an accent colour: one or the other, not both. `caption_set` holds the states: unread, focus, read.
- Read words: `ink` at 100 %. Unread words: `ink` at 55 %. For lyrics: read 35 %, upcoming 55 %.
- Two lines at most on screen; 3 to 5 words a caption for talk, 1 to 2 for punchy social.

## Sound tokens

- UI pops and clicks: volume 0.15 to 0.35, randomness 0.4 to 0.6, pitch 0.9 to 1.2. Never on every letter: per word or per element.
- Typing and other streams of hits: volume 0.15 to 0.3, randomness 0.5 to 0.6, never above 0.5; `mechanical` by default, `thock` for a harder keyboard.
- Whooshes on big moves only, one per transition (`trigger: transition`, `anchor: "peak"`, the middle of the transition is the cut). Lower pitch for heavy elements, higher for small ones.
- Bus targets (the leveler's): voice -16 LUFS, music -20, sfx -19, ambience -28. The voice is the loudest thing.
- Music ducks 10 dB under voice (the default rule: 150 ms in, 500 ms out). Duck by rule, never with volume keys.
- Master: -14 LUFS integrated (loudness match, on by default), true peak at or below -1 dBTP; read both from `export_video`'s `loudness`.
- Music: a bed (a music file from the user or project) under every piece over about 3 s, faded 1 to 3 s in and out, cut to the edit.

## Imagery and generated media

When drawing or shooting with AI, brief it in the system's terms so it belongs next to the type:

- **Palette**: name `ground` and `accent` in the prompt ("deep ink-blue shadows, a single violet accent light"); avoid saturated rainbow scenes.
- **Light**: one motivated key, soft fill, gentle falloff; cinematic contrast, not HDR.
- **Composition**: leave the title's area calm (say where: "empty upper third"); the subject on a third, not dead centre, unless it is a product hero.
- **Finish**: natural film grain at most; no text, logos or watermarks in the image, because type is set in the editor.
- **Footage**: slow, deliberate camera moves (push-in, lateral track); a 24 to 30 fps feel; 4 to 8 s shots.
- **Voice**: warm, clear, mid-pace, conversational rather than announcer. **Music**: minimal and modern, 90 to 110 bpm, instrumental under voice, a clean ending.

## Do and don't

- Do align to the grid and share edges; don't nudge by eye.
- Do let one element lead; don't animate everything at once.
- Do check the busiest frame for legibility; don't trust a single still.
- Don't stack more than two effects on text. Don't use pure `#000` or `#FFF` for large fields: use `ground` and `ink`.
