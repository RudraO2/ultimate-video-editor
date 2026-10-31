# Website

The project's landing page: one static page with no build step. Open it through any static server:

```sh
npx --yes serve website          # or: python3 -m http.server 8080 --directory website
```

| Path | What |
| --- | --- |
| `index.html` | The page, with the icon sprite inlined (Phosphor Icons, MIT, plus three marks of our own) |
| `css/site.css` | Every style; the tokens are at the top |
| `js/site.js` | The motion and behaviour |
| `assets/brand/` | Logo and favicons, copied from `/assets` |
| `assets/shots/` | Screenshots of the real editor (Easy and Advanced, Dark and Cream, the graph editor, a 3D world in the orbit view) |
| `assets/video/` | A real export from the editor (7 s, 1280 x 720, MP4 and WebM) and its poster |
| `assets/og.jpg` | The social card for link previews |
| `tools/demo-scene.js` | The editor script that builds the scene in the screenshots and the video |

## How it moves

GSAP 3.15.0 with ScrollTrigger drives the motion and Lenis 1.3.26 smooths the scroll. Both load from
CDNs, pinned with subresource integrity. Almost every scroll effect is scrubbed: tied to the scroll
position, with a lag of one to four seconds, so it plays backwards when you scroll up.

| Section | Motion |
| --- | --- |
| Intro | Cream card; the name rises out of a blur (2 s), then a dark disc grows over it while the card blurs away (2 s). A click, key or wheel skips ahead. Deep links (`#voice`) skip it. |
| Nav | Transparent at the top; past 50 px a floating pill with a dot screen over blurred glass, which turns light over the cream section. |
| Hero | Glow, ring, badge, title, subtitle, buttons, player and the agent strip arrive in turn. On scroll the title drifts up, the subtitle grows and fades, the player grows to 1.2x and the ring shrinks. The player is the real export; its timecode and playhead follow the video. |
| Statement and cards | Lines rise and stretch into place; each card rises as it enters. |
| Giant word | Slides left 20 % while it crosses the screen. |
| Made for | Pinned for two screens while six words pass through one line, each stretching on Anybody's width axis. |
| Agents | The screenshot starts tilted back 24 degrees and settles flat; the grid's pictures turn from grey to colour on hover. |
| Voice, cream sheet, closing | Scrubbed rises; the cream sheet scales up over the dark room; the Cream / Dark slider sweeps once to show it can be dragged. |
| Footer | Fixed behind the page; the last scroll uncovers it (screens wider than 760 px). |

With `prefers-reduced-motion` there is no intro, no smooth scroll and no scroll animation, and the
video gets its controls. Without JavaScript the page is complete and still.

## Updating the pictures

The screenshots and the video come from the editor itself. Run it with remote debugging
(`UVE_REMOTE_DEBUG_PORT=9222 pnpm dev`), run `tools/demo-scene.js` in an empty comp through the
Scripts tab or `script_run`, and capture the window. The screenshots show the scene before the
script's last block (the move into 3D); the hero video is the whole script, exported at 2/3 scale
after `frame_update {durationMs: 7000}`. Save screenshots as WebP at 2400 px wide.

## Deploying

- **GitHub Pages:** `.github/workflows/website.yml` publishes this folder. Turn on Settings > Pages >
  Source: GitHub Actions, then run the workflow by hand, or set the repository variable
  `WEBSITE_PAGES` to `true` to deploy on every push to `main` that changes `website/`. Pages on a
  private repository needs a paid plan.
- **Anywhere else:** it is a static folder. On Netlify, Vercel or Cloudflare Pages, set the publish
  directory to `website` and leave the build command empty.

After the first deploy, change `og:image` in `index.html` to the absolute URL of `assets/og.jpg`:
most link previews ignore a relative one.

## Credits

The layout and motion follow a study of upscayl.org (`docs/research/landing-page-study.md`): we took
the behaviour and timings, not its code, copy or pictures. Icons: Phosphor Icons (MIT). Fonts:
Bricolage Grotesque, Anybody, JetBrains Mono, Noto Sans Devanagari and Noto Sans Tamil (SIL Open Font
License), from Google Fonts. Motion: GSAP (GreenSock's standard no-charge licence) and Lenis (MIT).
