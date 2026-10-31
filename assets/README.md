# Brand assets

The Ultimate Video Editor mark: a filmstrip **U** whose inner curve carries a play triangle, in the
app's warm red on its cream card.

Everything here is generated from `logo-source.png` (1254 px master export) by
[`generate.py`](generate.py) — `pip install pillow`, then `python3 assets/generate.py`. The generated files are
cropped to the card, re-masked with a clean rounded rectangle (radius 21.5 % of the side) and
resized with Lanczos from a 2048 px intermediate, so there is no fringe at any size.

## What to use

| File | Use it for |
| --- | --- |
| `logo.png` | The default mark — 1024 px, transparent outside the rounded corners. READMEs, docs, slides. |
| `logo-square.png` | 1024 px, opaque, corners filled cream. Stores, social cards, anywhere transparency is wrong. |
| `png/logo-<n>.png` | 16, 24, 32, 48, 64, 96, 128, 180, 192, 250, 256, 384, 512 — transparent corners. (1024 is `logo.png`.) |
| `apple/` | iOS / iPadOS / macOS. Opaque, full-bleed squares at 76, 120, 152, 167, 180 and 1024: Apple applies its own mask, so these must not be pre-rounded or transparent. |
| `desktop/icon.icns` | macOS icon, built to the HIG (art fills 824/1024 of the canvas, the rest transparent), 16 → 512 pt with @2x. |
| `web/` | `favicon.ico` (16–256 in one file), `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180), `android-chrome-192x192.png`, `android-chrome-512x512.png`, `maskable-512.png` (cream, art inside the 80 % safe zone). |
| `desktop/` | Electron packaging: `icon.icns` (macOS), `icon.ico` (Windows, 16–256), `icon.png` (1024) and `icon-512.png` (Linux). |
| `logo-source.png` | The untouched export. Regenerate from this, not from a resized copy. |

## Web snippet

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

```json
{
  "icons": [
    { "src": "/android-chrome-192x192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "theme_color": "#C2201A",
  "background_color": "#FCF8F2"
}
```

## Colours

Sampled from the mark itself:

| Token | Hex | Where |
| --- | --- | --- |
| Card cream | `#FCF8F1` | The icon's ground, and the editor's Cream theme |
| Signal red | `#CE3024` | The play triangle and the lit side of the ribbon |
| Deep red | `#A61310` | The filmstrip side of the U |
| Shadow maroon | `#480606` | Where the ribbon turns away from the light |
| Warm coral | `#F5AB90` | The gradient's light end, on the right stroke |

## Rules

- Keep the cream card. The mark is drawn for a light ground; don't knock it out to white or place
  the red U alone on a dark field.
- Don't re-round, recolour, rotate or add effects to the card — the rounded corner is already the
  platform's shape.
- Leave clear space of at least 10 % of the icon's width on every side.
- For a very small size (16–32 px) use the matching file in `png/`, never a browser-resized 1024.
