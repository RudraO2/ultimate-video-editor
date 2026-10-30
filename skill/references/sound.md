# Choosing sounds

Sounds that land on time but are the wrong kind make a film sound cheap. This is how to choose: a palette for the piece, a sound per kind of motion, and what to leave out. Placement (`trigger`, `anchor`, `hitMs`) and the mix are in SKILL.md ▸ "Sounds on motion" and "The mix".

## Search, then read before you pick

- Search by what you hear, one or two words: `pop`, `soft landing`, `whoosh`, `drip`, `tick`, `stamp`, `riser`, `chime`, `paper`. Plural and -ing forms match (`drops`, `landing`).
- Every result has `quality`: `motion` (made for motion design: the synthesised packs, Motion Essentials, UI Clicks, Impacts & Risers), `foley` (clean recordings of real things and plain interface sounds), `game` (designed for games: fantasy, RPG, sci-fi lasers, jingles). Chiptune (`retro`) and voices or creatures (`voice`) are left out unless a word asks for them (`8bit`, `retro`, `scream`). In a polished piece, pick `motion` or `foley`; `game` only for a playful or game-themed piece.
- Read `use` before you pick: it says what the sound is and what it suits. A name can mislead: Kenney's "Drop" sounds are interface blips for an item dropped into a list, not water. A result with no `use` is unheard: prefer one that has a `use` that fits.
- `durationMs` and `hitMs` tell you how it lands: a 60 ms tick fits a stream, a 2 s ring does not.

## One palette per piece

Before placing anything, choose the piece's palette: 4 to 6 sounds from one family, and use only those. Families:

- **Soft and round** (friendly product, kids, characters): `pack: "pop"` or `ui-clicks/pop`, `motion-essentials/pop-in`, `motion-essentials/impact-soft`, `motion-essentials/whoosh-pass-slow`, `ui-clicks/soft-tap`, real water drips and bubbles.
- **Crisp and digital** (software, data, tech): `ui-clicks/tick`, `motion-essentials/count-tick`, `motion-essentials/whoosh-tight`, `motion-essentials/glitch-short`, `motion-essentials/shutter`, `motion-essentials/latch`, `pack: "digital"` or `"mechanical"`.
- **Cinematic** (trailers, big reveals): `impacts-risers/whoosh-low`, `impacts-risers/riser-short`, `motion-essentials/riser-tension`, `impacts-risers/impact-deep`, `motion-essentials/sub-hit`, `impacts-risers/tail`, `motion-essentials/stinger-up`.
- **Paper and desk** (editorial, explainers, documents): paper, page turn, card slide, pen, stamp (a wooden knock), soft thud.

Mixing families (a chiptune coin next to a cinematic boom, a synth blip next to a real raindrop) is the most common reason a film sounds cheap.

## A sound per kind of motion

| Motion | Sound | Search | How |
| --- | --- | --- | --- |
| An element appears (icon, tag, sticker, bubble) | round soft pop | `pop` | its own `sounds`, `trigger: layer`, `anchor: start`, volume 0.2–0.3, randomness 0.5 |
| Words of a title appear | soft pops or ticks per word | `pack: pop` or `soft` | `trigger: text`, per word, 0.15–0.25 |
| Something slides or flies in | short whoosh that peaks as it arrives | `whoosh` | `anchor: end`, `offsetMs` minus the whoosh's peak (its `use` gives it, e.g. −150), 0.2–0.35 |
| A camera move or a big transition | fuller, slower whoosh or sweep | `whoosh low`, `sweep` | on the transition, `anchor: peak`; or a clip whose peak sits on the cut |
| A light thing lands | short soft thud | `soft landing`, `thud` | `anchor: end` of the motion that lands, 0.25–0.35 |
| A heavy thing lands (logo, title slam) | deep impact, maybe a sub-hit under it | `impact`, `sub hit` | `anchor: end`, 0.35–0.5; once per scene |
| Water drops, rain | real drips and small bubbles, 2–4 different takes | `drip`, `water drop`, `bubble` | one voice per drop with randomness 0.5, or alternate takes; 0.15–0.25; never the same file over and over |
| A counter or number roll | tiny tick per step, then one landing sound | `tick`, `count tick` | a stream at 0.12–0.2; a soft chime or thud when it stops |
| Typing | keyboard pack | `pack: keys`, `mechanical` | per letter, 0.15–0.25, randomness 0.5–0.6 |
| A stamp, a seal, "approved" | short heavy knock with no ring, paper under it | `stamp`, `wood knock` | `anchor: end` at contact, 0.35–0.45, pitch 0.9 |
| A notification, success | soft short chime | `chime`, `notification` | 0.2–0.3; one, never a jingle |
| A build into a reveal | a riser that ends on the reveal, then the reveal's hit | `riser`, `swell` | the riser's peak (`hitMs`) on the downbeat (`anchor: end` of the motion before it), then the impact |
| Pixelate, glitch, a digital effect | short glitch | `glitch` | on the effect's start, 0.2–0.3 |
| A screenshot, a snap | shutter or latch | `shutter`, `latch` | 0.2–0.3 |
| Lightning, electricity | distant thunder, or a sub-hit with a short glitch | `thunder`, `sub hit` | never a laser or zap from a game pack |

## Layering

At most two sounds on one moment: a whoosh into an impact (a thing flies in and lands), a riser into a hit (a build and a reveal), a pop over a soft tap (a pop with more body). Three or more turn to mush.

## What to avoid

- Game sounds in a polished piece: lasers, zaps, coins, power-ups, jingles, chiptune.
- The same file again and again: use the sounds stack with randomness (each hit varies), or alternate 2–3 takes.
- Pitch beyond 0.85–1.15 on a recorded sound: it sounds processed. Synthesised packs can go further.
- One-shot effects louder than volume 0.5: the voice must stay the loudest thing. The leveler brings every effect near the effects target first; `volume` then sets how far under it sits.
- A sound on every motion. In a narrated piece, 3 to 6 sounds per 10 s are plenty; let the bed and the voice carry the rest. Silence before the big moment makes it land.
- A wrong sound because nothing fits. Leave the moment silent and `report_issue` what you looked for.

## Checking

- Listen in your head along the timeline: does each sound belong to the palette, and does it sound like the thing that moves (weight, size, material)?
- After export, `loudness.matchDb` near its cap and `truePeakDbtp` at the ceiling with the loudness short of the target mean effects are too loud: lower them (`sound_category {action: "update", id: "sfx", volume: 0.7}`) rather than raising the voice.
