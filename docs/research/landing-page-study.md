# Landing page study: upscayl.org (2026-10-31)

The owner asked for a project website that feels like Upscayl's: the intro, the scroll motion and
the section rhythm. This note records what that page does, measured in a headless browser
(screenshots every 450 px of wheel scroll, intro frames from 0 to 4.5 s) and read from its
shipped bundles. Clean room, as with every other study here: behaviour and numbers are written
down in our own words; no code, copy, images or illustrations are taken. Our page is in
`website/` and uses its own brand, words and pictures.

## Stack

- Next.js (pages router) with Tailwind.
- GSAP 3 with ScrollTrigger for nearly every motion; almost all scroll effects are `scrub`bed
  (tied to the scroll position with a lag of 1 to 4 s), not one-shot reveals.
- Lenis smooth scroll with its defaults (`lerp` 0.1, smooth wheel, no touch smoothing).
- One framer-motion piece (the tilted product shot), loaded lazily.
- Fonts: DM Sans for everything, Syne 800 for the giant marquee word.

## Page rhythm, top to bottom (11,700 px at 1440 x 900)

| # | Section | What moves |
| --- | --- | --- |
| 0 | Intro overlay | Light screen; the wordmark rises 100 px out of a 10 px blur (2 s, strong in-out ease). At 2 s a dark disc with a 400 px soft halo scales from 0 to 5x (2 s), while the overlay itself blurs to 10 px and fades (2 s); then it is removed. |
| 1 | Nav | Full width and transparent at the top. Past 50 px of scroll it becomes a floating pill (rounded, 1 px border, half-transparent, `backdrop-filter: blur + brightness(1.5)`, a 4 px dot grid painted over it), with a 500 ms transition. |
| 2 | Hero (100vh) | Sequenced after the intro: background glow fades in (delay 1 s), a thin ring scales up from 0 (1 s), title rises 50 px, subtitle slides in from the left, the CTA pill from the right, then the product visual and the logo strip rise 50 px. On scroll (scrubbed): title drifts up 150 %, subtitle grows to 1.2 and fades, CTA drops 200 px and fades, the visual grows to 1.2, the ring shrinks to 0.5, the logo strip drops and fades. |
| 3 | Statement + three story cards | Heading lines rise from 100 % with `scaleY` 1.1 and opacity 0, staggered 0.5 (scrub 1.1). Cards rise from 100 % while the trigger moves 400 px (scrub 1.2). Cards are big rounded panels, text one side and an illustration the other, alternating sides. Problem, pain, solution. |
| 4 | Giant word | One word repeated ten times, ~128 px, wide display face, 50 % grey. Moves left 20 % across the time it is on screen (scrub 4). Appears twice: after the cards and above the footer. |
| 5 | "Made for ___" | A 300vh section; the label and word block are pinned. Six words in a one-line window: each slides up into place and holds, then slides out (scrub 1.1). Ends on "You". |
| 6 | Product reveal | Title and a large product screenshot in a 1000 px perspective; the screenshot starts tilted back 25 degrees at 1.05x and settles flat (then -15 degrees) as it scrolls past; the title drifts up 100 px. Followed by a bento grid (3 columns, 18 rem rows): media backgrounds in greyscale at 30-40 % that turn colour on hover; on hover the text lifts 40 px, the icon shrinks to 0.75 and a "Learn more" row slides up. |
| 7 | App section | Heading, subheading and button rise 200 px staggered 0.3; the screenshot rises from 100 % (scrub 1.1). Then a two-column list of six features with outlined icons. |
| 8 | Social proof | Two rows of cards in CSS marquees (20 s, the second reversed), with 20 % side fades to the page colour. |
| 9 | Closing CTA | Three phrases rise 200 px with `scaleY` 1.1, staggered 0.3, then the button. 70vh tall. |
| 10 | Footer | `position: fixed` behind the page (`z-index: -1`); the page has a 25 rem bottom margin, so the last scroll uncovers it like a curtain. Its content scales from 0.9, rises 100 px and fades in over the last 6 % of the page. |

Throughout: a fixed, 75 px-blurred conic gradient (blue, purple, pink) at 20 % opacity near the
bottom of the viewport gives every screen the same low glow; the page ground is a deep slate.

## Small touches

- The hero's "Get started" button has a slowly travelling radial gradient on its 1 px border.
- The "AI" word in the subtitle sits on a conic gradient chip.
- The hero's before/after slider swaps its image pair every 10 s with a 1 s blur-out, blur-in.
- The logo strip is an auto-scrolling carousel with a 100 px fade at each end.
- A tilted "NEW!" sticker sits on one nav link and straightens a little on hover.
- Every interactive element shares one 300 ms ease (`cubic-bezier(0.4, 0, 0.2, 1)`).

## What we carry over, and what we change

We keep the shape: the light-to-dark intro, the floating nav, the sequenced hero, the scrubbed
reveals, the pinned word swap, the giant moving word, the tilted product reveal, the bento grid,
the two marquee rows, the closing CTA and the curtain footer.

We change everything that is theirs: our cream card and signal red instead of their slate and
blue-pink glow, our own type (Inter Tight, Inter, Unbounded, JetBrains Mono), our own words, and
pictures of our own editor instead of illustrations. Their testimonials become things people say
to the editor (no invented quotes), and we add a section for voice and Indian languages, which
has no counterpart on their page.
