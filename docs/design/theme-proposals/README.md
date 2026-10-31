# Theme proposals (2026-10-31)

The owner wants the editor to stop looking like AtomCut: own colours and own icons, with the same screens, layout, sizes and behaviour. These three files are proposals only. Nothing under `apps/` or `packages/` changes until the owner picks one.

| File | Theme | Mode | Icons |
| --- | --- | --- | --- |
| `theme-a-graphite.html` | Graphite: calm neutral, cool grey, one mint-teal accent | dark | Iconoir 7.12.1 (MIT) |
| `theme-b-chai.html` | Chai: warm paper and stone, ink-brown text, terracotta accent | light | Phosphor Icons 2.1.1, Regular (MIT) |
| `theme-c-kesar-night.html` | Kesar Night: deep indigo, saffron accent, peacock teal and rani pink clips | dark | Tabler Icons 3.50.0, outline (MIT) |

Open a file in a browser. The bar on top switches Easy and Advanced, shows the Export dialog, and opens "Tokens & icons": clip kinds (video, audio, text, caption, with Devanagari and Tamil labels), states, WCAG contrast checks, every token next to today's value, and all 116 icons the app imports, Lucide next to the new set. The URL hash keeps the view (`#easy`, `#advanced,export`, `#advanced,tokens`).

How they were made: the live app's DOM and compiled CSS were captured over CDP (Advanced with a video selected and the Export dialog open, Easy with the OpenCode chat), at 1266 × 683 CSS px. Each file is that copy with the colour tokens overridden and every Lucide `<svg>` swapped for the new set's icon, so layout and text are the app's own. The video frame and clip thumbnails are a drawn placeholder (the owner's clip is gitignored and stays out of git). Inter and JetBrains Mono (latin, SIL OFL 1.1) are embedded; Devanagari and Tamil use system fonts, as in the app's chat. Text-look previews keep their own content colours. The generator lived in the session scratchpad; the files themselves are the source of truth now.

## Contrast

Every pair in the "Contrast" table passes 4.5:1 in all three files: ink and muted text on every surface, the accent on panels and on its own tint (`active-tint`), text on a solid accent, ok, danger, warning, and clip labels and kind tags on every clip colour. Lowest pairs: Graphite 5.34 (accent on tint), Chai 4.64 (accent on tint), Kesar Night 6.02 (accent on tint).

## Applying the winner

1. Paste the file's first `<style id="theme-tokens">` block into `@theme` / `@theme static` in `apps/desktop/src/renderer/src/styles.css`, and set `html { color-scheme }` as the block says (Chai is `light`).
2. Wire the four new tokens:
   - `--color-accent-ink`: text on a solid accent. Today it is `text-white` (Export button and similar `bg-accent text-white` spots). Kesar Night's saffron needs dark text.
   - `--color-danger`, `--color-warn`: replace `text-red-*`, `bg-red-*`, `border-red-*`, `text-amber-*`, `bg-amber-300`; `text-emerald-400` becomes `text-ok`.
   - `--color-clip-caption`: captions are text layers today, so they share the text colour. Give caption layers `border-clip-caption/70 bg-clip-caption/22` in `TimelineClip.tsx` (and the kind icon in `kindIcons.ts`).
3. Raise the clip kind tag from `text-ink/50` to `text-ink/75` (`TimelineClip.tsx`); at 50 % it misses 4.5:1 in every theme, today's included.
4. Move the hard-coded colours below onto tokens.
5. Swap `lucide-react` for the chosen set's React package (`iconoir-react`, `@phosphor-icons/react` or `@tabler/icons-react`, pinned to a version at least two weeks old) using the mapping in the file's second comment. Keep each icon's size; Lucide's `strokeWidth` maps to the set's own weight (Iconoir 1.5 px line, Tabler 1.75, Phosphor Regular is a filled outline).

## Today's colour inventory

Tokens in `styles.css` (`@theme`): `app #08060a`, `panel #100c11`, `stage #060406`, `lane #140f14`, `card #161016`, `raised #1b141b`, `field rgb(255 255 255 / 4%)`, `hover rgb(255 255 255 / 8%)`, `line rgb(255 255 255 / 7%)`, `ink #f1eaee`, `muted #8c818a`, `accent #ff4e6a`, `ok #2fd47a`, clips `text #9d8bff`, `shape #4cc3e0`, `image #e8b04b`, `video #7c9dff`, `audio #46d39a`, `group #d6c3a5`, `path #ff86c8`, `nested #f2a65a`; `@theme static`: `motion #8b5cf6`, `motion-halo rgb(10 10 14 / 62%)`, `motion-ink #ffffff`; `shadow-panel`, `shadow-float`. Utilities: `glass` (raised 88 % + blur), `active-tint` (accent 22 % + accent text). Selection, playhead, keyframes and toggles all use `accent`. No separate danger, warning or caption token.

Hard-coded colours that a theme should own (renderer, `apps/desktop/src/renderer/src`):

- Accent copies `#ff4e6a`: `components/Viewport.tsx:578,612` (canvas selection), `components/KeyViews.tsx:349,672` (selected key), `components/PanelViews.tsx:183` (node wires), `components/rigOverlay.ts`.
- Ink copies `#f1eaee`: `components/Viewport.tsx:582,615`; `#100c11` (panel) in `components/KeyViews.tsx:672`.
- Curve colours per property: `components/KeyViews.tsx:31-43` (11 colours plus 5 fallbacks; several equal today's clip colours).
- Viewport overlays: `components/motionPaths.ts` (duplicates the motion tokens), `components/rigOverlay.ts` (`#ffd166`, `#ff6b6b`, `#5aa9ff`, `#e8e4ee`).
- Tailwind palette classes: `text-red-300` ×5, `text-red-200` ×2, `text-red-400`, `text-red-100`, `text-red-200/70`, `border-red-400/40`, `bg-red-950/90`, `bg-red-500/10`, `text-amber-200` ×2, `bg-amber-300`, `text-emerald-400`, `text-white` ×4, `bg-black/50` ×3, `bg-white/25`.
- Content defaults, not theme (leave): text highlight defaults in `InspectorPanel.tsx` and `CaptionSection.tsx`, new fill and stroke colours, `library/titleCard.ts`, `LibraryPanel.tsx` swatches, `WorldSections.tsx`, `agent/view.ts`, icon tint `#F4F2ED`.

## Today's icons

`lucide-react` 1.61.0 (ISC), imported in 33 files, 116 distinct icons. Each file's "Tokens & icons" panel lists them all with what each stands for and its replacement. The most used: `Plus` (12 files), `Trash2`, `X`, `ChevronRight`, `ChevronDown`, `Eye`/`EyeOff`, `Search`, `Play`, `Sparkles`, `Square`, `Type`; the rail uses `Wand2` (Easy), `SlidersHorizontal` (Advanced), `MessageCircle`, `ImageIcon`, `Layers`, `LibraryBig`, `SquareCode`, `AudioLines`, `Puzzle`, `Sparkles`, `Undo2`, `Redo2`, `Download`; the logo is `Clapperboard`.
