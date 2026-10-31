#!/usr/bin/env python3
"""Regenerate every icon in this folder from `logo-source.png`.

    python3 -m venv .venv && .venv/bin/pip install pillow
    .venv/bin/python assets/generate.py

Needs Pillow; `iconutil` (macOS) for the .icns. The source export has a ragged,
semi-transparent fringe around the card, so the card is cropped out, re-masked with a
clean rounded rectangle (radius 21.5 % of the side, measured off the original art) and
resized with Lanczos from a 2048 px intermediate.
"""
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'logo-source.png')
CREAM = (252, 248, 241, 255)
CARD_BOX = (65, 65, 1187, 1187)   # the clean card inside the 1254 px export
RADIUS_FRAC = 241 / 1122          # the card's own corner radius

source = Image.open(SRC).convert('RGBA')
card = source.crop(CARD_BOX)


def rounded_mask(size, ss=4):
    """A rounded-rectangle mask, 4x supersampled so the edge is clean."""
    m = Image.new('L', (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size * ss - 1, size * ss - 1], radius=round(RADIUS_FRAC * size) * ss, fill=255
    )
    return m.resize((size, size), Image.LANCZOS)


BIG = 2048
big = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
big.paste(card.convert('RGB').resize((BIG, BIG), Image.LANCZOS), (0, 0), rounded_mask(BIG))


def rounded(size):
    return big.resize((size, size), Image.LANCZOS)


def full_bleed(size):
    """Opaque square: Apple and the stores apply their own corner mask."""
    c = Image.new('RGBA', (size, size), CREAM)
    c.alpha_composite(rounded(size))
    return c.convert('RGB')


def padded(size, art_frac, bg=None):
    c = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    a = max(1, round(size * art_frac))
    c.alpha_composite(rounded(a), ((size - a) // 2, (size - a) // 2))
    return c


def save(img, rel):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if img.size[0] <= 64 and img.mode == 'RGBA':
        img = img.quantize(colors=256, method=Image.FASTOCTREE)   # banding is invisible this small
        img.save(path, optimize=True)
    else:
        img.save(path, optimize=True, compress_level=9)
    print(rel, img.size)


save(rounded(1024), 'logo.png')
save(full_bleed(1024), 'logo-square.png')

for s in (16, 24, 32, 48, 64, 96, 128, 180, 192, 250, 256, 384, 512):
    save(rounded(s), f'png/logo-{s}.png')

for s in (76, 120, 152, 167, 180, 1024):
    save(full_bleed(s), f'apple/apple-icon-{s}.png')
save(full_bleed(180), 'apple/apple-touch-icon.png')

save(rounded(16), 'web/favicon-16x16.png')
save(rounded(32), 'web/favicon-32x32.png')
save(rounded(192), 'web/android-chrome-192x192.png')
save(rounded(512), 'web/android-chrome-512x512.png')
save(padded(512, 0.72, CREAM).convert('RGB'), 'web/maskable-512.png')
save(full_bleed(180), 'web/apple-touch-icon.png')

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
rounded(256).save(os.path.join(HERE, 'web/favicon.ico'), format='ICO', sizes=ICO_SIZES)
print('web/favicon.ico')

save(rounded(1024), 'desktop/icon.png')
save(rounded(512), 'desktop/icon-512.png')
rounded(256).save(os.path.join(HERE, 'desktop/icon.ico'), format='ICO', sizes=ICO_SIZES)
print('desktop/icon.ico')

if shutil.which('iconutil'):
    iconset = os.path.join(HERE, 'desktop/icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        padded(base, 824 / 1024).save(f'{iconset}/icon_{base}x{base}.png')
        padded(base * 2, 824 / 1024).save(f'{iconset}/icon_{base}x{base}@2x.png')
    subprocess.run(['iconutil', '-c', 'icns', iconset,
                    '-o', os.path.join(HERE, 'desktop/icon.icns')], check=True)
    shutil.rmtree(iconset)
    print('desktop/icon.icns')
else:
    print('iconutil not found: desktop/icon.icns left as it is', file=sys.stderr)
