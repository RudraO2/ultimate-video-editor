# Theme proposal: White (2026-10-31)

The owner wants the editor to stop looking like AtomCut, with Apple-like minimalism: white with red, as before, for icons and the whole UI, and rounded corners. Screens, layout, panels and behaviour stay the same. This is a proposal only: nothing under `apps/` or `packages/` changes until the owner approves it.

A first round (Graphite, Chai, Kesar Night) was turned down on 2026-10-31 and removed; it is in git history (commit "Theme proposals: Graphite, Chai and Kesar Night").

`theme-d-white.html`: white panels on a soft grey window (`#f5f5f7`), near-black text (`#1d1d1f`), one red (`#c8001a`) for icons and everything active, hairline lines, softer shadows, rounder corners. Icons: Phosphor Icons 2.1.1, Regular weight (MIT), rounded like SF Symbols.

`theme-e-glass.html` (Glass, 2026-10-31, second take): after the owner's reference mock-up (`ai_studio_code (2).html`, kept out of git). The window, both rails and the tab bar sit on a deep teal-blue backdrop (`#2c4148` to `#1d2b31` with a faint aqua and blue glow); the four main panels float on it as frosted white glass (18 px blur, white hairline, top highlight, deep shadow), tinted mint on the left, white to soft blue on the inspector, mint to white to blue across the timeline. Inside the glass: dark ink `#1f2d33`, muted `#4a5b62`, red `#b50016`. On the backdrop: light text `#e9f3f5`, muted `#a3bcc3`, a lighter red `#ff9aa6` for rail icons and tabs. Primary buttons are a red gradient, active things glow, the Export dialog is frosted glass over a blurred editor. The rail is ours (the reference's was weaker). New tokens: `color-chrome*` (text and fills on the backdrop) and `gradient-backdrop`, `glass-left`, `glass-right`, `glass-timeline`, `glass-stage`, `glass-edge`. Applying it means scoping: the backdrop sets the `chrome` values into `--color-ink`, `--color-muted`, `--color-accent`, `--color-field`, `--color-hover`, `--color-line`, and each glass panel sets the light ones back (see the `.bg-app` and `.gl-panel` rules in the file). Backdrop blur costs GPU time: check it on the Intel UHD before applying.

Open either file in a browser. The bar on top switches Easy and Advanced, shows the Export dialog, and opens "Tokens & icons": clip kinds (video, audio, text, caption, with Devanagari and Tamil labels), states, WCAG contrast checks, every token next to today's value, and all 116 icons the app imports, Lucide next to Phosphor. The URL hash keeps the view (`#easy`, `#advanced,export`, `#advanced,tokens`).

How it was made: the live app's DOM and compiled CSS were captured (Advanced with a video selected and the Export dialog open, Easy with the OpenCode chat) at 1266 × 683 CSS px. The file is that copy with the tokens overridden, a few finishing rules (below), and every Lucide `<svg>` swapped for Phosphor, so layout and text are the app's own. The video frame and clip thumbnails are a drawn placeholder (the owner's clip is gitignored and stays out of git). Inter and JetBrains Mono (latin, SIL OFL 1.1) are embedded; Devanagari and Tamil use system fonts, as in the app's chat.

## What changes besides colours

- Corners: panels 12 → 16 px, `rounded-lg` 8 → 10, `rounded-md` 6 → 8, `rounded-sm` and `rounded` 4 → 6.
- Selected and active things (`active-tint`) get a 12 % red tint instead of 22 %, lighter and still 4.85:1.
- Play and the Export button are solid red with a white icon (today a pink tint with a red icon).
- Rail icons and the tool palette icons are red; the labels stay grey and black.
- Section headers in sentence case ("Transform", "OpenCode") instead of spaced capitals; clip kind tags stay in capitals.
- Main panels get a hairline and a soft shadow instead of relying on contrast with the window.
- Clip borders are softer (55 % instead of 70 %); captions get their own orange.

## Contrast

Every pair in the "Contrast" table passes 4.5:1: text and muted text on every surface, red on white (6.05) and on its tint (4.85), white on solid red (6.05), success, danger, warning, and clip labels and kind tags on every clip colour.

## Applying it (after approval)

1. Paste the file's first `<style id="theme-tokens">` block into `@theme` / `@theme static` in `apps/desktop/src/renderer/src/styles.css` (colours, radii, shadows), and set `html { color-scheme: light; }`.
2. Wire the four new tokens:
   - `--color-accent-ink`: text on a solid accent. Today it is `text-white` (Export button and similar `bg-accent text-white` spots).
   - `--color-danger`, `--color-warn`: replace `text-red-*`, `bg-red-*`, `border-red-*`, `text-amber-*`, `bg-amber-300`; `text-emerald-400` becomes `text-ok`.
   - `--color-clip-caption`: captions are text layers today, so they share the text colour. Give caption layers `border-clip-caption/70 bg-clip-caption/22` in `TimelineClip.tsx` (and the kind icon in `kindIcons.ts`).
3. Bring over the finish: the `extraCss` rules at the end of the file's third `<style>` become changes in `styles.css` (`active-tint` at 12 %, `.rounded` radius) and in components (solid `bg-accent` + `text-accent-ink` for Play and Export, `text-accent` on rail and tool icons, no `uppercase tracking-wide` on section headers, `/55` clip borders in `TimelineClip.tsx`).
4. Raise the clip kind tag from `text-ink/50` to `text-ink/75` (`TimelineClip.tsx`); at 50 % it misses 4.5:1 today (3.8 to 4.0).
5. Move the hard-coded colours below onto tokens; on white, the dark ones (`#100c11`, `#f1eaee`) would show as wrong.
6. Swap `lucide-react` for `@phosphor-icons/react` (pinned to a version at least two weeks old) using the mapping in the file's second comment. Keep each icon's size; a filled Lucide icon (play, keyframe) uses Phosphor's `fill` weight.

## Today's colour inventory

Tokens in `styles.css` (`@theme`): `app #08060a`, `panel #100c11`, `stage #060406`, `lane #140f14`, `card #161016`, `raised #1b141b`, `field rgb(255 255 255 / 4%)`, `hover rgb(255 255 255 / 8%)`, `line rgb(255 255 255 / 7%)`, `ink #f1eaee`, `muted #8c818a`, `accent #ff4e6a`, `ok #2fd47a`, clips `text #9d8bff`, `shape #4cc3e0`, `image #e8b04b`, `video #7c9dff`, `audio #46d39a`, `group #d6c3a5`, `path #ff86c8`, `nested #f2a65a`; `@theme static`: `motion #8b5cf6`, `motion-halo rgb(10 10 14 / 62%)`, `motion-ink #ffffff`; `radius-panel 12px`, `shadow-panel`, `shadow-float`. Utilities: `glass` (raised 88 % + blur), `active-tint` (accent 22 % + accent text). Selection, playhead, keyframes and toggles all use `accent`. No separate danger, warning or caption token.

Hard-coded colours that a theme should own (renderer, `apps/desktop/src/renderer/src`):

- Accent copies `#ff4e6a`: `components/Viewport.tsx:578,612` (canvas selection), `components/KeyViews.tsx:349,672` (selected key), `components/PanelViews.tsx:183` (node wires), `components/rigOverlay.ts`.
- Ink copies `#f1eaee`: `components/Viewport.tsx:582,615`; `#100c11` (panel) in `components/KeyViews.tsx:672`.
- Curve colours per property: `components/KeyViews.tsx:31-43` (11 colours plus 5 fallbacks).
- Viewport overlays: `components/motionPaths.ts` (duplicates the motion tokens), `components/rigOverlay.ts` (`#ffd166`, `#ff6b6b`, `#5aa9ff`, `#e8e4ee`).
- Tailwind palette classes: `text-red-300` ×5, `text-red-200` ×2, `text-red-400`, `text-red-100`, `text-red-200/70`, `border-red-400/40`, `bg-red-950/90`, `bg-red-500/10`, `text-amber-200` ×2, `bg-amber-300`, `text-emerald-400`, `text-white` ×4, `bg-black/50` ×3, `bg-white/25`.
- Content defaults, not theme (leave): text highlight defaults in `InspectorPanel.tsx` and `CaptionSection.tsx`, new fill and stroke colours, `library/titleCard.ts`, `LibraryPanel.tsx` swatches, `WorldSections.tsx`, `agent/view.ts`, icon tint `#F4F2ED`.

## Today's icons

`lucide-react` 1.61.0 (ISC), imported in 33 files, 116 distinct icons. The file's "Tokens & icons" panel lists them all with what each stands for and its Phosphor replacement.
